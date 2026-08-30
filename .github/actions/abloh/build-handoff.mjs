#!/usr/bin/env node
/**
 * Builds the `abloh-ci-handoff/v2` envelope that the authenticated control-plane
 * endpoint accepts.
 *
 * This replaces a ~240-line jq filter that lived inside the workflow YAML. The jq
 * version could not be unit tested, which is how the producer and the validator in
 * that same file drifted apart on `baseline` keys without anyone noticing.
 *
 * CONTRACT: the output must remain byte-identical to the jq filter's output.
 * `build-handoff.differential.test.mjs` enforces that against every corpus
 * artifact by running both and comparing the serialized result. Two consequences
 * for anyone editing this file:
 *
 *   1. Key insertion order is part of the contract. jq emits object keys in the
 *      order the filter constructs them and this file mirrors that order exactly.
 *      Reordering a property is a behavioural change.
 *   2. jq's `//` is an ALTERNATIVE operator, not a null-coalesce: `a // b` yields
 *      `b` when `a` is null OR false. `alt()` below reproduces that, and it is
 *      deliberately not `??`.
 *
 * This is the ONLY upload builder. The endpoint it feeds derives repository
 * identity from GitHub's signed OIDC token rather than trusting the payload, so
 * no field here may carry a runner-local path.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** jq's `//`. Falls through on null AND false, unlike `??`. */
function alt(value, fallback) {
  return value === null || value === undefined || value === false ? fallback : value;
}

/**
 * jq's `.foo` on a key the object does not have yields `null`. JavaScript yields
 * `undefined`, and JSON.stringify DELETES undefined-valued keys — so a field the
 * producer happened to omit would vanish from the envelope entirely and the
 * endpoint's exact-key checks would reject the whole upload.
 *
 * Every fixed-shape object is therefore built from an explicit key list rather
 * than by spreading or by property-by-property copying: the key list is the
 * schema, absences become null, and unknown producer keys cannot leak through.
 * Key order follows the array, which is part of the output contract.
 */
function field(value) {
  return value === undefined ? null : value;
}

/** First line, printable ASCII, bounded — the shape the control plane accepts for a reason. */
function printableLine(value, max = 400) {
  const firstLine = String(value).split(/\r?\n/u)[0] ?? "";
  const ascii = firstLine.replace(/[^\x20-\x7e]/gu, "?").trim();
  return ascii.length <= max ? ascii : ascii.slice(0, max);
}

function pick(source, keys) {
  const from = source ?? {};
  const out = {};
  for (const key of keys) out[key] = field(from[key]);
  return out;
}

/**
 * THE ONE REFUSAL A PRODUCER'S GATE IS ALLOWED TO CARRY ACROSS THIS BOUNDARY.
 *
 * `{ refusal }` when the run refused at the ADMISSION stage, and `{}` for everything else. The whole
 * argument is at the call site; what this function is responsible for is that nothing else gets
 * through and that what does is bounded.
 *
 * IT IS PROJECTED FIELD BY FIELD, on this file's own rule: the key list is the schema, so a producer
 * key nobody here named cannot ride along. The evidence array is dropped entirely - the admission
 * codes declare none, and an empty declared list is not a reason to build a path for one.
 */
function admissionRefusal(gate) {
  const refusal = (gate ?? {}).refusal;
  if (refusal === null || typeof refusal !== "object") return {};
  if (refusal.stage !== "admission") return {};
  const remedy = refusal.remedy ?? {};
  if (remedy.kind !== "customer-action" || typeof remedy.text !== "string") return {};
  const location = remedy.location ?? null;
  return {
    refusal: {
      code: printableLine(refusal.code, 128),
      stage: "admission",
      owner: printableLine(refusal.owner, 32),
      privacy: printableLine(refusal.privacy, 32),
      summary: printableLine(refusal.summary, 1000),
      evidence: [],
      remedy: {
        kind: "customer-action",
        text: printableLine(remedy.text, 1000),
        ...(location === null || typeof location !== "object"
          ? {}
          : {
              location: {
                file: printableLine(location.file, 512),
                key: location.key === null || location.key === undefined ? null : printableLine(location.key, 256),
                line: typeof location.line === "number" ? location.line : null,
                suggestion: null,
              },
            }),
      },
      destinations: Array.isArray(refusal.destinations)
        ? refusal.destinations.slice(0, 16).map((entry) => printableLine(entry, 32))
        : [],
    },
  };
}

/**
 * The closed vocabulary of diff-coverage cannot-attest reasons.
 *
 * Provider diagnostics are free text and can embed local paths and parser
 * excerpts, so the raw value is never carried. It is mapped to one of nine codes
 * and an unrecognized reason is a hard failure — silently forwarding it is how a
 * path would escape.
 */
/*
 * A TEXT COPY of core's DIFF_COVERAGE_CANNOT_ATTEST_REASONS - this script runs standalone on the
 * runner and cannot import TypeScript. scripts/capability-sync.test.ts pins the two byte-for-byte;
 * that pin's first run caught this list missing the three Python codes, which made
 * normalizeL0Reason throw on any Python repository whose diff coverage refused (pytest missing, no
 * Python project found) and took the whole CI upload down with it.
 */
const L0_REASON_CODES = new Set([
  "coverage-provider-unavailable",
  "coverage-provider-version-mismatch",
  "coverage-run-failed",
  "coverage-report-missing",
  "coverage-report-invalid",
  "coverage-scope-invalid",
  "coverage-scope-incomplete",
  "coverage-py-unavailable",
  "coverage-acquisition-failed",
  /* A touched package the run could not measure at all. Pinned here by capability-sync.test.ts
     against core's one list: without it this script rewrites the code to `unknown` and the whole
     artifact - including the packages that measured perfectly - is refused at ingest. */
  "package-unmeasurable",
  "python-project-not-found",
  "pytest-unavailable",
  "python-target-unavailable",
]);

/**
 * THE CLOSED CODE, PASSED THROUGH - and nothing is guessed any more (external refusal review, rank 5).
 *
 * WHAT WAS HERE. Thirty lines of prefix and exact-match rules that tried to recover a wire code from
 * whatever sentence the engine happened to throw, ending in
 * `throw new Error("diff coverage cannot-attest reason is not recognized")`. Two things that rule
 * cost, both reproduced by the reviewer:
 *
 *  - IT DID NOT COVER EVERY REACHABLE SENTENCE. `aggregate coverage timed out`,
 *    `prepared coverage adapter does not match the test runner` and
 *    `angular-vitest runner: no angular.json test target was resolved` all threw here, and the throw
 *    DISCARDS THE ENTIRE ARTIFACT - every package that measured perfectly included. The customer's
 *    job log then showed an HTTP status and nothing else, on a run that succeeded locally.
 *  - IT DISAGREED WITH THE API'S COPY OF ITSELF. Deno's
 *    `coverage report step exited nonzero (untrusted)` matched this file's `coverage report ` prefix
 *    rule and became `coverage-report-invalid`, while the API's exact map made it
 *    `coverage-run-failed`. One failure, two names, depending on which surface you were reading.
 *
 * The engine now declares the code where it refuses, so this only has to check that what arrived is
 * in the vocabulary. An UNRECOGNISED value no longer takes the run down: it becomes the generic
 * `coverage-acquisition-failed`, which is the honest thing to say about a refusal whose code this
 * boundary does not know, and it is said on the job log rather than swallowed. Losing the specific
 * code costs a reader one sentence of precision. The throw cost them the entire measurement.
 */
export function normalizeL0Reason(reason) {
  if (typeof reason !== "string") {
    throw new Error("diff coverage cannot-attest reason is required");
  }
  if (L0_REASON_CODES.has(reason)) return reason;
  /* THE UNKNOWN VALUE IS NOT QUOTED, and that is not squeamishness. Every producer contract says
     this field is a closed egress-safe reason, but a producer that BREAKS that contract is exactly
     the case this branch exists for, and echoing whatever arrived would print a checkout path or a
     command tail into the job log. The value is already in the local run artifact for anyone
     diagnosing this, which is where unbounded diagnostics live everywhere else in this product. */
  console.log(
    "Abloh: this run reported a diff-coverage refusal this Action does not recognise. " +
      "It is recorded as coverage-acquisition-failed and the rest of the measurement is unaffected. " +
      "The exact reason is in this run's local JSON artifact, and updating the abloh Action to the " +
      "version matching your CLI restores it here.",
  );
  return "coverage-acquisition-failed";
}

/**
 * A BOUND THAT ACTUALLY BOUND IS NEWS, AND IT GOES ON THE JOB LOG (silent-discard sweep, 2026-08-28).
 *
 * Every cap in this file is set at the producer's own ceiling, so in the ordinary case it removes
 * nothing and this says nothing. The case it exists for is the one where the two drift: the producer
 * grows a limit, this file does not, and the envelope quietly describes less than the run measured.
 * A truncated `packages` list looks like a complete measurement of fewer packages; a truncated
 * `mutantRoster` is refused at the ingest door by a sentence that names the count and blames the
 * producer, which sends a maintainer to read the wrong file. Neither is allowed to be silent.
 */
function bounded(values, limit, what) {
  if (!Array.isArray(values) || values.length <= limit) return values;
  console.log(
    `Abloh: this run reported ${values.length} ${what}, and this Action uploads at most ${limit}. ` +
      `The remaining ${values.length - limit} are NOT in the upload, so what the control plane shows ` +
      "covers less than this run measured. The whole measurement is in this run's local JSON " +
      "artifact, and updating the abloh Action to the version matching your CLI restores the rest.",
  );
  return values.slice(0, limit);
}

/** `{file, ranges, lines}` only — drops any other key the producer may add. */
function scopeEntries(entries) {
  return (alt(entries, [])).map((entry) => ({
    file: entry.file,
    ranges: entry.ranges.map((range) => [range[0], range[1]]),
    lines: entry.lines,
  }));
}

const PROVIDER_KEYS = ["runner", "provider", "runnerVersion", "providerVersion"];
const COVERAGE_COUNT_KEYS = ["changed", "covered", "uncovered", "notInstrumented"];
const COUNT_KEYS = [
  "killed", "timeout", "survived", "no-coverage",
  "runtime-error", "build-error", "skipped-by-cap",
];
const SCORE_KEYS = [
  "rawScore", "triagedScore", "denominator",
  "errorCount", "confirmedEquivalent", "triageValidated",
];
const FLOOR_KEYS = ["minMutantsExecuted", "maxErrorRate", "minSamplingFraction"];
/*
 * THE BASELINE STATE, WHOLE.
 *
 * `redBaseline` alone stopped describing this block on 2026-08-27, and the four names below are the
 * rest of what it now takes to say what happened to the suite:
 *
 *  - `runTimedOut` with its notice and its bound disclosure. A run the engine killed at its per-run
 *    wall exits non-zero and is deliberately NOT red, so it arrives here as `redBaseline: false`.
 *    Projected without the flag, the control plane classified it green and the run page said
 *    "3 baseline runs, all green" over a suite nothing had finished observing.
 *  - `deadlineExceeded`, which is the same shape one cause later: the shared pre-mutation deadline
 *    expired, nothing was measured, and `redBaseline` is false.
 *  - `redBaselineDetail`, the counts and test names behind a red baseline. Stripping it collapsed
 *    "12 of 161 test(s) executed failed in every run: a, b, c" into the hosted fallback sentence
 *    "the test suite did not pass before measurement started".
 *
 * `quarantine` is projected separately below, because it is a nested block with arrays in it and
 * `pick` copies values verbatim.
 */
/**
 * The steps a project's own test script may run over its sources, exactly as the control plane and
 * the CLI both spell them. Three copies of one vocabulary; they move together.
 */
const SOURCE_CHECK_STEPS = ["eslint", "prettier", "biome", "tsc"];

const BASELINE_KEYS = [
  "runs", "durationsMs", "redBaseline", "testCount", "testCounts",
  "testIdentityCount", "ambiguousIdentityCount", "flakyCount",
  "timingCv", "timeoutFactor", "quarantineDowngraded",
  "runTimedOut", "runTimeoutNotice", "runBoundDisclosure", "deadlineExceeded",
  "redBaselineDetail",
];
/*
 * WHETHER THE BASELINE KNEW WHICH TEST DID WHAT (external review, rank 3).
 *
 * `redBaseline: false` beside an empty flaky set is what made a hosted card say "3 baseline runs,
 * all green" over a suite whose per-test reports never parsed - the flaky set was empty because
 * nothing could be compared, not because nothing was flaky, and quarantine had nothing to exclude
 * so a test broken on unmutated code credited every mutant it covered. Two integers, re-asserted
 * here rather than copied, because `pick` forwards nested objects verbatim and this one decides
 * what a hosted sentence is allowed to claim.
 */
function perTestAttributionBlock(baseline) {
  const raw = baseline?.perTestAttribution;
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const expected = count(raw.expected);
  const parsed = count(raw.parsed);
  return expected === null || parsed === null ? null : { expected, parsed };
}
/**
 * Closed quarantine-block keys. Sentences and identities are bounded here rather than trusted:
 * the block is composed on the customer's runner and rendered into a hosted check summary.
 */
const QUARANTINE_KEYS = ["excluded", "measured", "rescuedRedBaseline", "disclosure"];
/**
 * The bound on the two name lists.
 *
 * The quarantine cap is `max(5 tests, 2% of the suite)`, so a fifty-thousand-test suite can
 * legitimately name a thousand. NOT A SILENT CAP: `excluded` beside the list is the true count and
 * stays whatever the producer measured, so a truncated list is visible as a list shorter than the
 * number it sits next to.
 */
const MAX_QUARANTINE_NAMES = 1_000;
const FINDING_KEYS = [
  "mutantId", "file", "startLine", "endLine", "mutator", "status", "coveredBy",
];
/*
 * What TIER 2 additionally sends, and nothing beyond it.
 *
 * The mutated span's exact columns, the source slice that was there (`originalText`) and the slice
 * that replaced it. `originalText` IS CUSTOMER SOURCE, which is why this list is reached only when the
 * artifact itself reports tier 2 — the customer's explicit choice to let Abloh hold the evidence
 * rather than only its shape.
 *
 * IT MUST MATCH THE SERVER. `TIER2_ADDITIONAL_FINDING_FIELDS` in apps/api/src/draft.ts is the same
 * four names. Widening one side alone is silent: a field this strips never reaches the server's
 * allowlist to be kept, and a field the server drops was uploaded for nothing. Both were the same
 * seven structural names until tier 2 existed, which is exactly how they drifted unnoticed.
 */
const TIER2_FINDING_KEYS = [
  "originalText", "replacement", "startColumn", "endColumn",
];
/*
 * The triage fields that travel.
 *
 * modelId, promptVersion and effort are the CLASSIFIER IDENTITY, and they are safe to send
 * because a project cannot choose them: a committed policy file may not name a model, so these
 * always identify the service's own classifier and never anything the customer wrote.
 *
 * They matter for two things that are impossible without them. A run can only be marked
 * triage-validated by matching an exact (model, prompt, effort) triple, so a run that omits them
 * can never be validated. And a human label on a verdict is meaningless unless it can be
 * attributed to whatever produced that verdict — the moment the prompt changes, unattributed
 * labels become noise.
 */
const TRIAGE_KEYS = [
  "verdict",
  "reasonCode",
  "confidence",
  "overridden",
  "description",
  /* NO `impact`. The one-sentence consequence was retired on 2026-08-21 and the server's triage
     allowlist no longer keeps it, so projecting it here would upload prose that is dropped on
     arrival. Dropping it on this side is what keeps the two lists the same names, which is the
     invariant the note above exists to protect. */
  "modelId",
  "promptVersion",
  "effort",
];

/**
 * Diff coverage. A completed measurement (or a not-applicable one with no executable
 * lines) carries its per-line classification; every other state carries the
 * state, a normalized reason and nothing else — counts and lines would be
 * unfounded.
 */
/**
 * Closed per-package row keys (counts-only rows; the server re-derives every quantity).
 *
 * `excluded` IS PART OF THE ROW, and its absence here cost more than any other omission in this
 * file. A package the change touched and the run could not measure at all carries no runner - there
 * is none to name - and says so in `excluded`. Projected without it, the row reached the control
 * plane as a measurable package with `runner: null`, which the ingest door refuses
 * (`runResult.packages row '<dir>' has an unrecognized runner`), and the refusal discards THE WHOLE
 * ENVELOPE: every sibling package that measured perfectly went with it, behind a bare HTTP 400.
 *
 * It is projected through `excludedBlock` rather than copied, because the two strings in it are
 * composed by the selector on the customer's runner and the receiver refuses anything that is not
 * one printable ASCII line.
 */
const PACKAGE_ROW_KEYS = [
  "directory",
  "runner",
  "diffCoverage",
  "mutation",
  "baseline",
  "environmentContractDigest",
  "reachedStage",
];
/** The two strings an excluded row carries, and the receiver's cap on each. */
const MAX_EXCLUSION_STR_LEN = 300;

function diffCoverageBlock(dc) {
  if (dc === null || dc === undefined) return null;
  const measured =
    dc.state === "completed" ||
    (dc.state === "not-applicable" && dc.reason === "no-executable-lines");

  if (measured) {
    return {
      state: dc.state,
      reason: alt(dc.reason, null),
      wallMs: dc.wallMs,
      provider: pick(dc.provider, PROVIDER_KEYS),
      counts: {
        ...pick(dc.counts, COVERAGE_COUNT_KEYS),
        /* Older producers omit this; jq's `// 0` made it zero, not null. */
        notExecutable: alt(dc.counts?.notExecutable, 0),
      },
      /* Retry-once disclosure — was silently dropped by this projection (WS3 fold). */
      acquisitionAttempts: alt(dc.acquisitionAttempts, null),
      lines: dc.lines.map((line) => ({ file: line.file, line: line.line, state: line.state })),
    };
  }

  return {
    state: dc.state,
    reason: dc.state === "cannot-attest" ? normalizeL0Reason(dc.reason) : dc.reason,
    /*
     * The tool's own first line, beside the code. The code names the situation; this names the fix
     * ("Cannot find module '@vitest/coverage-v8'"), and without it the reader is sent hunting
     * through CI logs for the sentence the runner already produced. The producer folded it to one
     * printable-ASCII line and capped it; `printableLine` re-asserts that shape here because this
     * projection is the egress door and asserts every field's shape itself. Kenneth's call,
     * 2026-08-12: the first line is actionable and carries nothing a stack frame would.
     */
    reasonDetail:
      dc.state === "cannot-attest" && typeof dc.reasonDetail === "string" && dc.reasonDetail !== ""
        ? printableLine(dc.reasonDetail, 200)
        : null,
    wallMs: alt(dc.wallMs, null),
    provider: dc.provider === null || dc.provider === undefined ? null : pick(dc.provider, PROVIDER_KEYS),
    counts: null,
    acquisitionAttempts: alt(dc.acquisitionAttempts, null),
    lines: [],
  };
}

/**
 * WHAT WAS LEFT OUT OF THE MEASURED SURFACE, and what the run's rate therefore covers.
 *
 * THE BLOCK IS THE DIFFERENCE BETWEEN TWO RUNS THAT LOOK IDENTICAL ON THE WIRE. A suite that was
 * green and a suite that was red until its failing tests were excluded both upload
 * `redBaseline: false`; only this block says which one a reader is looking at. Stripped, a rescued
 * red baseline was signed and rendered as fully green, with no disclosure that the unmutated suite
 * had failed.
 *
 * Counts and one sentence, plus the identities Kenneth's ruling of 2026-08-26 requires every
 * surface to be able to show. `byReason` is copied verbatim rather than filtered: the receiver
 * checks that its tally sums to `excluded`, and a key dropped here would break that sum.
 */
function quarantineBlock(quarantine) {
  if (quarantine === null || quarantine === undefined) return null;
  const nameList = (value) =>
    (Array.isArray(value) ? value : [])
      .slice(0, MAX_QUARANTINE_NAMES)
      .map((name) => printableLine(name, 200))
      .filter((name) => name !== "");
  const byReason = {};
  for (const [reason, count] of Object.entries(quarantine.byReason ?? {})) {
    if (Number.isInteger(count) && count >= 0) byReason[reason] = count;
  }
  return {
    ...pick(quarantine, QUARANTINE_KEYS),
    /* The sentence every surface shows. Bounded here like every other authored string that crosses:
       it is composed on the runner and rendered into a hosted check summary. */
    disclosure:
      typeof quarantine.disclosure === "string" ? printableLine(quarantine.disclosure, 500) : null,
    names: nameList(quarantine.names),
    failing: nameList(quarantine.failing),
    byReason,
  };
}

/**
 * The exclusion, scrubbed to the shape the receiver accepts.
 *
 * A DIAGNOSTIC MUST NOT BE ABLE TO DESTROY THE RUN IT DESCRIBES - the same law `fixLoop.reason`
 * lives under below. These two strings are composed by the target selector from whatever the
 * repository looked like, and the ingest door refuses a whole upload over a newline in either.
 * A field the producer left empty says so rather than making the receiver refuse the envelope.
 */
function excludedBlock(excluded) {
  if (excluded === null || excluded === undefined) return null;
  const line = (value) => {
    const text = typeof value === "string" ? printableLine(value, MAX_EXCLUSION_STR_LEN) : "";
    return text === "" ? "not stated by the producer" : text;
  };
  return { reason: line(excluded.reason), remedy: line(excluded.remedy) };
}

/** One package row: the closed key list, plus the exclusion block when the row carries one. */
function packageRow(row) {
  return {
    ...pick(row, PACKAGE_ROW_KEYS),
    excluded: excludedBlock(row?.excluded),
  };
}

/**
 * THE FRACTION OF THE SUITE THAT WAS MEASURED, AS TWO INTEGERS (silent-discard sweep, 2026-08-28).
 *
 * A repository whose own test command carries a shard flag - `vitest run --shard=1/4` - measures a
 * quarter of its suite, and Kenneth's F12 ruling of 2026-08-27 is MEASURE AND DISCLOSE: the command
 * runs exactly as declared and every surface states that a fraction was covered. The CLI records
 * that on the baseline, the run page reads `baseline.shard` and renders it, and this projection sat
 * between the two dropping it. So the local artifact disclosed the shard, the hosted surface showed
 * the same catch rate with nothing beside it, and the customer read a rate over a quarter of their
 * tests as a rate over their tests. Same defect as `redBaselineDetail`, one key over.
 *
 * TWO INTEGERS AND NOT THE SENTENCE, which is the shape `run-store.ts` declares and the shape the
 * run page wants: it composes its own words from the numbers rather than rendering a string this
 * runner produced. Sending `flag` and `disclosure` would egress unbounded producer text for a
 * surface that will not print it.
 */
function shardBlock(shard) {
  if (shard === null || shard === undefined || typeof shard !== "object") return null;
  const { index, total } = shard;
  if (!Number.isInteger(index) || !Number.isInteger(total)) return null;
  if (total < 1 || index < 1 || index > total) return null;
  return { index, total };
}

/**
 * WHETHER THE SUITE MET LIVE RESPONSES OR RECORDED ONES (silent-discard sweep, 2026-08-28).
 *
 * The producer's own comment on this field says it lives in the baseline block precisely so that
 * "disclosing this reaches the control plane", and the run page has a whole path for it - a
 * `baseline-replayed` note, a `baseline-recording-missing` note, and two counts on the card. All of
 * it was unreachable, because this projection never carried the key: every replayed run uploaded as
 * an ordinary green baseline. A rate measured against a recording of what an API said months ago is
 * a different claim from one measured against what it says now, and that difference is invisible in
 * the number - which is the reason the field exists at all.
 *
 * TWO INTEGERS, under the names the run page reads. `recordings` is a repository path, `disclosure`
 * is a producer sentence and the page writes its own; neither crosses this door.
 */
function replayBlock(replay) {
  if (replay === null || replay === undefined || typeof replay !== "object") return null;
  const served = replay.handled;
  const missing = replay.unmatched;
  if (!Number.isInteger(served) || served < 0) return null;
  return { handled: served, unmatched: Number.isInteger(missing) && missing >= 0 ? missing : 0 };
}

/** Baseline durations and per-run test totals are capped at the first 10 runs. */
function baselineBlock(baseline) {
  if (baseline === null || baseline === undefined) return null;
  return {
    ...pick(baseline, BASELINE_KEYS),
    shard: shardBlock(baseline.shard),
    replay: replayBlock(baseline.replay),
    /* Both arrays are capped at the first 10 runs. */
    durationsMs: bounded(alt(baseline.durationsMs, []), 10, "baseline run duration(s)"),
    testCounts: bounded(alt(baseline.testCounts, []), 10, "baseline test count(s)"),
    /* The three authored sentences, re-asserted as one printable line each at this egress door.
       Every one of them is composed on the customer's runner and rendered by a hosted surface. */
    runTimeoutNotice:
      typeof baseline.runTimeoutNotice === "string" ? printableLine(baseline.runTimeoutNotice, 500) : null,
    runBoundDisclosure:
      typeof baseline.runBoundDisclosure === "string" ? printableLine(baseline.runBoundDisclosure, 500) : null,
    perTestAttribution: perTestAttributionBlock(baseline),
    redBaselineDetail:
      typeof baseline.redBaselineDetail === "string" ? printableLine(baseline.redBaselineDetail, 1_000) : null,
    quarantine: quarantineBlock(baseline.quarantine),
  };
}

/**
 * WHAT THE RUN'S MODEL CALLS COST, forwarded whole and never re-added here.
 *
 * The producer sums the lanes ONCE, in the CLI's `runModelCost`, and that sum is what travels. This
 * projection copies the lanes, the total and the unpriced marker across; it does not add anything
 * up, because a second summation on the wire is exactly the partial-total defect the run-total law
 * of 2026-08-23 exists to stop. A total that disagrees with its own lanes is refused at the ingest
 * door, not corrected here.
 *
 * `null` WHEN THE ARTIFACT CARRIES NONE, which is every artifact a CLI released before the block
 * existed writes. The receiver treats null as absent, and an absent cost is UNKNOWN rather than
 * zero — a run with no cost on record and a run that cost nothing are different facts and the row
 * has to keep them apart.
 *
 * WHAT IT CARRIES IS MONEY AND LANE NAMES: numbers, two fixed English labels the producer writes,
 * and a reason sentence naming a missing operator variable. No source, no model prose, no path.
 */
function modelCostBlock(cost) {
  if (cost === null || cost === undefined) return null;
  return {
    lanes: alt(cost.lanes, [])
      .slice(0, 8)
      .map((lane) => ({ label: printableLine(lane?.label ?? "", 120), dollars: field(lane?.dollars) })),
    dollars: field(cost.dollars),
    unpriced:
      cost.unpriced === null || cost.unpriced === undefined
        ? null
        : {
            label: printableLine(cost.unpriced.label ?? "", 120),
            /* Same scrub as `fixLoop.reason`: this sentence is written by a failure path and one
               newline in it would have the receiver refuse the whole upload. */
            reason: printableLine(cost.unpriced.reason ?? "", 512),
          },
  };
}

/**
 * The most findings one upload may carry.
 *
 * A REFUSAL, NOT A TRUNCATION (junction audit ACT-FIND-01, 2026-08-28). This used to `slice`, while
 * `findingCount` beside it stayed the TRUE total - and the control plane's ingest door requires the
 * two to agree, so every run past this bound was rejected by an invariant nobody could see from the
 * job log. The customer's CI failed as configured and then reported `HTTP 400` with no body: a
 * measured run, correct in every respect, thrown away with no sentence naming why.
 *
 * TRUNCATING WOULD NOT BE SAFE EITHER, which is why the bound refuses rather than carrying a
 * truncation contract. The server RE-DERIVES the gate from the findings it receives: a flagged-path
 * violation past the cap would be missing from that recompute, the recomputed gate would pass where
 * the artifact failed, and the upload would be refused again - this time after silently describing a
 * different run. The bound stops the run here, by name, with the whole measurement still in the
 * job's own artifact.
 */
export const MAX_UPLOADED_FINDINGS = 10_000;

/**
 * Findings are allowlist-copied. `replacement`, `originalText` and the triage
 * rationale are source-bearing and are dropped by omission here.
 */
function findingEntries(findings, tier) {
  const keys = tier === 2 ? [...FINDING_KEYS, ...TIER2_FINDING_KEYS] : FINDING_KEYS;
  const all = alt(findings, []);
  if (all.length > MAX_UPLOADED_FINDINGS) {
    throw new Error(
      `this run reported ${all.length} findings and one upload carries at most ` +
        `${MAX_UPLOADED_FINDINGS}. Nothing was uploaded, because sending the first ` +
        `${MAX_UPLOADED_FINDINGS} beside a count of ${all.length} is what the control plane refuses, ` +
        "and sending a shorter count would describe a run that did not happen. The whole measurement " +
        "is in this job's own artifact. Narrow what this check measures - a smaller pull request, or " +
        "a tighter mutation scope in abloh.yml - and the upload comes back.",
    );
  }
  return all
    .map((finding) => ({
      ...pick(finding, keys),
      triage:
        finding.triage === null || finding.triage === undefined
          ? null
          : pick(finding.triage, TRIAGE_KEYS),
    }));
}

/**
 * @param {object} evidence  parsed attest-results.json from the runner
 * @param {object} ctx       GitHub-supplied provenance and policy identity
 * @param {{rationales?: string, fixProofs?: string, coverage?: string, engineV2Proofs?: string, engineV2Pool2?: string}} [sidecars]
 *   Uploaded sidecars, as the RAW BYTES of the local files.
 *
 *   `rationales` and `fixProofs` are TIER-2 ONLY — they carry model prose and generated test bodies,
 *   so they are omitted entirely below tier 2 and for any run that produced neither.
 *
 *   `engineV2Proofs` travels at EVERY tier: the v2 engine is tierless, so there is no tier decision
 *   to read. What bounds it instead is the acceptor, which verifies the bytes against
 *   `engineV2.proofsDigest` and stores only candidates that PROVED.
 *
 *   `engineV2Pool2` travels on the same terms, bound to its own commitment
 *   (`engineV2.disclosure.agentBugs.evidenceDigest`) and projected to the bugs the artifact signed
 *   as survivors.
 *
 *   `coverage` travels at EVERY tier: line and column maps with hit counters carry no source text,
 *   so gating it by tier would withhold evidence without protecting anything.
 *
 *   Passed as a separate argument, and the key omitted when absent, so that every existing two-argument
 *   call produces byte-identical output — which is what keeps the differential contract against the
 *   retired jq filter meaningful instead of merely re-baselined.
 *
 *   The bytes are forwarded UNCHANGED. The control plane verifies them against `rationalesDigest`
 *   and `fixLoop.proofsDigest`, which the evidence block already carries,
 *   so re-serializing here would break the verification that makes these files evidence rather than
 *   attachments.
 */
/**
 * ABLOH'S OWN FAILURE, BOUNDED, ON ITS WAY OUT OF THE RUNNER (external refusal review, rank 6).
 *
 * The complete engine output is deliberately NOT here and never will be: it is unbounded
 * third-party text from the customer's own build, and the field that keeps it whole
 * (`engineFailure.log`) exists precisely because it must not be capped. It stays in the local
 * artifact.
 *
 * WHAT TRAVELS IS THE FIRST LINE, which is the half a reader acts on - `MODULE_NOT_FOUND: cannot
 * find @stryker-mutator/typescript-checker` - and which the producer already folded to one line.
 * Without it, a hosted run that failed inside abloh showed "abloh failed to run the mutation stage"
 * and nothing else, while the sentence that named the cause died with the ephemeral runner.
 */
function engineFailureBlock(evidence) {
  const failure = evidence?.engineFailure;
  if (failure === null || failure === undefined || typeof failure !== "object") return null;
  const message = typeof failure.message === "string" ? printableLine(failure.message, 200) : "";
  if (message === "") return null;
  return {
    stage: failure.stage === "mutation" ? "mutation" : "mutation",
    engine: typeof failure.engine === "string" ? printableLine(failure.engine, 100) : "",
    message,
  };
}

export function buildStructuralHandoff(evidence, ctx, sidecars) {
  return {
    schema: "abloh-ci-handoff/v2",
    provenance: {
      repository: ctx.repository,
      triggerSha: ctx.triggerSha,
      headSha: ctx.headSha,
      /* Empty string means "not a pull request", not "PR zero". */
      pullRequest: ctx.pullRequest === "" ? null : Number(ctx.pullRequest),
      workflowRef: ctx.workflowRef,
      workflowSha: ctx.workflowSha,
      githubRunId: ctx.runId,
      githubRunAttempt: ctx.runAttempt,
    },
    artifactDigest: ctx.artifactDigest,
    evidence: {
      schema: field(evidence.schema),
      engine: pick(evidence.engine, ["name", "version"]),
      /* target.repo is deliberately absent: on the runner it is a local
         filesystem path. Repository identity comes from the OIDC claim. */
      target: pick(evidence.target, ["baseSha", "sha", "runner"]),
      scope: scopeEntries(evidence.scope),
      diffCoverage: diffCoverageBlock(evidence.diffCoverage),
      /* ONE BOUNDED LINE OF ABLOH'S OWN FAILURE - see `engineFailureBlock`. The complete log stays
         on the machine that produced it, and the refusal that renders this NAMES that it did. */
      engineFailure: engineFailureBlock(evidence),
      rawCoverageDigest: field(evidence.rawCoverageDigest),
      rawCoverageFormat: field(evidence.rawCoverageFormat),
      /*
       * The fix-loop block, and with it `proofsDigest`.
       *
       * The Action already uploads `attest-fix-proofs.json` at tier 2 (sidecars.fixProofs below),
       * and the control plane will only store bytes it can check against a commitment. That
       * commitment is `fixLoop.proofsDigest`, and this block was never emitted — so every proven
       * test a customer's fix loop generated was uploaded, refused as `sidecar.malformed`, and lost.
       * The generated test bodies stay in the sidecar; what travels here is counts, verdicts and
       * digests, which is why it rides at every tier.
       */
      fixLoop:
        evidence.fixLoop === null || evidence.fixLoop === undefined
          ? null
          : {
              ...evidence.fixLoop,
              /*
               * A DIAGNOSTIC MUST NOT BE ABLE TO DESTROY THE RUN IT DESCRIBES.
               *
               * The control plane requires printable single-line ASCII here and refuses the whole
               * upload otherwise. `reason` is produced by failure paths — an unavailable proof
               * environment, an exceeded budget — and one of them interpolated the customer's own
               * suite tail, complete with newlines and vitest's `⎯` rule characters. The
               * measurement was finished and correct; the evidence was thrown away at ingest and
               * the Action reported a bare "HTTP 400".
               *
               * The producer now sends one scrubbed line, and this is the second guard: the field
               * is normalised at the boundary as well, so no future failure message can reach the
               * receiver in a shape it refuses.
               */
              ...(typeof evidence.fixLoop.reason === "string"
                ? { reason: printableLine(evidence.fixLoop.reason) }
                : {}),
            },
      /*
       * THE V2 ENGINE'S OWN BLOCK, forwarded whole and with NO TIER GATE.
       *
       * The v2 arm is tierless — it runs on `policy.engine === "v2"` alone, and the control plane
       * refuses an `engineV2` block that carries a `tier` field at all — so gating this by tier
       * would withhold the block from the runs it exists for.
       *
       * FORWARDED VERBATIM rather than projected key by key. Every field of it is validated at
       * ingest by `sanitizeEngineV2`, which refuses a forbidden or unknown one outright, so a
       * second allowlist here would only be a copy that drifts from the one that decides. What
       * this block carries is digests, counts, verdicts and named reasons: no generated source.
       *
       * It carries `proofsDigest`, the commitment the v2 proofs sidecar below is checked against.
       * Without this key that sidecar arrives uncheckable and is refused — the same failure the
       * `fixLoop` comment above records, one engine later.
       */
      engineV2:
        evidence.engineV2 === null || evidence.engineV2 === undefined
          ? null
          : {
              ...evidence.engineV2,
              /* Same scrub as `fixLoop.reason`, for the same reason: one v2 failure path
                 interpolates a caught error's own message into this field, and a newline in it
                 would have the receiver refuse the whole upload. */
              ...(typeof evidence.engineV2.reason === "string"
                ? { reason: printableLine(evidence.engineV2.reason) }
                : {}),
            },
      /* The changed-error-handler analysis. Half of the Ext-5 recompute: `policy.errorPaths` above
         says whether the rule is on, and this says how many untested handler mutants and
         anti-patterns it found. With the policy alone the server reads failOnUntested: true against
         a count of zero and still recomputes a pass, so both must travel or neither helps. Null when
         no scan ran. */
      errorHandlers:
        evidence.errorHandlers === null || evidence.errorHandlers === undefined
          ? null
          : evidence.errorHandlers,
      /* The REDACTED mutation report's commitment, for exactly the reason above.
         `mutationRedacted` is forwarded in `sidecars` and the control plane checks it against this
         value; the field was never emitted, so those bytes always arrived uncheckable and were
         refused. The digest describes the source-free rewrite, not `rawReportDigest`'s verbatim
         report, which never leaves the runner. */
      redactedReportDigest: field(evidence.redactedReportDigest),
      mutationExecution:
        evidence.mutationExecution === null || evidence.mutationExecution === undefined
          ? null
          : {
              state: evidence.mutationExecution.state,
              reason: alt(evidence.mutationExecution.reason, null),
              scope: alt(evidence.mutationExecution.scope, null),
              /* THE STEP THE REFUSAL SENTENCE NAMES (junction audit ACT-CHECK-01, 2026-08-28).
                 `checkStep` says WHICH gate in the project's own test script reads its sources -
                 eslint, prettier, biome or tsc - and the control plane's refusal copy prints it
                 verbatim. This projection dropped it, so the customer read "your test command
                 checks your sources" with no name attached and no idea which step to move. The
                 receiver holds it to that same closed vocabulary and rejects anything else, which
                 is why forwarding it cannot widen what leaves this runner. */
              ...(SOURCE_CHECK_STEPS.includes(evidence.mutationExecution.checkStep)
                ? { checkStep: evidence.mutationExecution.checkStep }
                : {}),
            },
      mutationScope: scopeEntries(evidence.mutationScope),
      /* Per-phase wall clock. The run page states what each stage cost, and a duration that does
         not survive this boundary is a duration the hosted UI can never show. */
      mutationWallMs: field(evidence.mutationWallMs),
      triageWallMs: field(evidence.triageWallMs),
      /* What the run charged, every lane summed once by the producer. Always emitted, null when
         the artifact carried none — the same convention as the two durations above. */
      modelCost: modelCostBlock(evidence.modelCost),
      tier: field(evidence.tier),
      mutantsPlanned: field(evidence.mutantsPlanned),
      mutantsRun: field(evidence.mutantsRun),
      counts: pick(evidence.counts, COUNT_KEYS),
      scores: pick(evidence.scores, SCORE_KEYS),
      floor:
        evidence.floor === null || evidence.floor === undefined
          ? null
          : pick(evidence.floor, [...FLOOR_KEYS, "passed"]),
      gate: {
        ...pick(evidence.gate, ["status", "score", "threshold"]),
        /*
         * THE ADMISSION REFUSAL, AND ONLY THAT ONE (onboarding flip, phase D).
         *
         * THE CALLER'S GATE IS NOT TRUSTED and this does not change that: the control plane
         * recomputes status, score and threshold from the evidence and refuses an envelope whose
         * numbers disagree. This carries no number. It carries WHY a run that measured nothing
         * measured nothing, in the one case the server cannot work out for itself - admission is a
         * fact about a receipt in the repository's own tree, and the control plane has no checkout.
         *
         * EVERY OTHER STAGE IS DROPPED, deliberately. A coverage refusal, a baseline refusal and an
         * engine failure are all reconstructible server-side from evidence the envelope already
         * carries, and accepting a producer's version of them would be a second answer to a
         * question that already has one. This is the only stage that has no other route.
         */
        ...admissionRefusal(evidence.gate),
      },
      baseline: baselineBlock(evidence.baseline),
      /* The TRUE total, deliberately not findings.length: the array above is
         capped at 10000 so a consumer can tell truncation happened. */
      findingCount: alt(evidence.findings, []).length,
      findings: findingEntries(evidence.findings, evidence.tier),
      policy: {
        /*
         * THE FIELDS THE SERVER RECOMPUTES THE GATE FROM.
         *
         * The control plane does not trust the CLI's pass/fail: it re-derives the gate from the
         * sanitized findings and this policy, then REFUSES the upload when its answer differs from
         * the one the artifact was signed with (draft.ts:3366 -> 400 INVALID_CI_HANDOFF).
         *
         * `flaggedPaths` and `errorPaths` are inputs to that recompute — resolveFlaggedPaths and the
         * Ext-5 error-path gate read them. Omitting them made the server default both rules to OFF,
         * so a run the CLI failed under either rule recomputed as passing and the whole upload was
         * rejected. The customer's CI failed as configured, then the evidence, check run and
         * dashboard row never existed, and the Action reported only "HTTP 400" with no body.
         *
         * Anything added to the server's recompute must be added here in the same change.
         */
        ...pick(evidence.policy, ["threshold", "enforce", "tier", "flaggedPaths", "errorPaths"]),
        policyDigest: ctx.policyDigest === "" ? null : ctx.policyDigest,
        source: {
          kind: ctx.policySource,
          path: ctx.policyPath === "" ? null : ctx.policyPath,
          /* The policy is read at the measured commit, so its source sha is the
             head sha; the validator asserts these are equal. */
          sourceSha: ctx.headSha,
        },
        floor: pick(evidence.policy?.floor, FLOOR_KEYS),
      },
      rationalesDigest: field(evidence.rationalesDigest),
      rawReportDigest: field(evidence.rawReportDigest),
      skipBaseline: field(evidence.skipBaseline),
      /* WS3 widened shape: the worst-of compat signal, per-package rows (counts only by
         construction), and the bounded mutant roster the server derives per-package kills
         from. Null when absent — the server treats null as absent. */
      evidenceProfile: evidence.evidenceProfile === null || evidence.evidenceProfile === undefined
        ? null
        : evidence.evidenceProfile,
      packages: Array.isArray(evidence.packages)
        ? bounded(evidence.packages, 8, "measured package row(s)").map((row) => packageRow(row))
        : null,
      mutantRoster: Array.isArray(evidence.mutantRoster)
        ? bounded(evidence.mutantRoster, 20000, "mutant(s) in its roster").map((entry) => ({ file: entry.file, status: entry.status }))
        : null,
    },
    /* Only what exists. An absent key is the ordinary case, which is why this is spread last rather
       than emitted as null: the receiver's key check treats it as optional, and a null would be a
       claim that the run had sidecars and they were empty. */
    ...(() => {
      const payload = sidecarPayload(sidecars, evidence.tier);
      return payload === null ? {} : { sidecars: payload };
    })(),
  };
}

/**
 * The sidecar bytes actually present, or null when there is nothing to send.
 *
 * The tier gate lives HERE rather than around the whole key, because the sidecars do not disclose
 * the same thing. Rationales are model prose and fix proofs are generated test bodies, so both are
 * the customer's tier-2 decision. The coverage report is line and column maps — nothing a tier-0
 * run withholds — so gating it by tier would suppress evidence without protecting anything.
 */
function sidecarPayload(sidecars, tier) {
  if (sidecars === null || sidecars === undefined) return null;
  const payload = {};
  if (tier === 2) {
    if (typeof sidecars.rationales === "string" && sidecars.rationales.length > 0) {
      payload.rationales = sidecars.rationales;
    }
    if (typeof sidecars.fixProofs === "string" && sidecars.fixProofs.length > 0) {
      payload.fixProofs = sidecars.fixProofs;
    }
  }
  if (typeof sidecars.coverage === "string" && sidecars.coverage.length > 0) {
    payload.coverage = sidecars.coverage;
  }
  /* Tier 1 and above. Per-mutant lines and mutators are more than the tier-0 promise allows to
     leave a customer's CI, and the control plane refuses this key for a tier-0 run regardless —
     the gate is repeated there because this file runs on the customer's own machine. */
  if (tier >= 1 && typeof sidecars.mutationRedacted === "string" && sidecars.mutationRedacted.length > 0) {
    payload.mutationRedacted = sidecars.mutationRedacted;
  }
  /*
   * The v2 proofs sidecar, at EVERY tier, because the v2 engine has none.
   *
   * Its tier neighbours above are not the model here. `fixProofs` is tier-2-gated because tier is
   * the v1 customer's own choice about generated source; the v2 arm has no such choice to read, so
   * a tier condition here would be an inherited reflex rather than a boundary. What replaces it is
   * on the receiving side and is stricter than a shape check: the file is verified against
   * `engineV2.proofsDigest`, and only PROVEN candidates survive the join to `exitProofs` there.
   *
   * This file carries rejected candidate bodies alongside proven ones, which is why nothing here
   * decides what is kept. It is sent whole because the digest commits to these exact bytes, and it
   * is projected by the acceptor rather than by the producer that wrote it.
   */
  if (typeof sidecars.engineV2Proofs === "string" && sidecars.engineV2Proofs.length > 0) {
    payload.engineV2Proofs = sidecars.engineV2Proofs;
  }
  /*
   * Pool 2's evidence, on exactly the terms of the file above and for the same reasons.
   *
   * It carries every bug the pool handled - killed, held and survived alike - each with its witness
   * test body. Nothing here filters that: the acceptor verifies these bytes against
   * `engineV2.disclosure.agentBugs.evidenceDigest` and then keeps only the bugs the ARTIFACT signed
   * as survivors, so a bug the customer's own suite caught can never be presented as one it missed.
   * A producer that pre-filtered would be deciding its own case.
   */
  if (typeof sidecars.engineV2Pool2 === "string" && sidecars.engineV2Pool2.length > 0) {
    payload.engineV2Pool2 = sidecars.engineV2Pool2;
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

export function contextFromEnvironment(environment = process.env) {
  return {
    repository: environment.GITHUB_REPOSITORY ?? "",
    triggerSha: environment.ABLOH_TRIGGER_SHA ?? "",
    headSha: environment.ABLOH_HEAD_SHA ?? "",
    pullRequest: environment.ABLOH_PULL_REQUEST ?? "",
    workflowRef: environment.GITHUB_WORKFLOW_REF ?? "",
    workflowSha: environment.GITHUB_WORKFLOW_SHA ?? "",
    runId: environment.GITHUB_RUN_ID ?? "",
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? "",
    artifactDigest: environment.ABLOH_LOCAL_ARTIFACT_DIGEST ?? "",
    policySource: environment.ABLOH_POLICY_SOURCE ?? "",
    policyPath: environment.ABLOH_POLICY_PATH ?? "",
    policyDigest: environment.ABLOH_POLICY_DIGEST ?? "",
  };
}

/**
 * One tier-2 sidecar, read as RAW BYTES.
 *
 * Not parsed and re-serialized: the control plane checks these against a digest the evidence block
 * already declared, and any re-encoding — even a semantically identical one — would change the bytes
 * and fail that check. A missing file is the ordinary case and yields undefined, not an error: most
 * runs have no fix proofs, and a tier-2 run with no triage has no rationales either.
 *
 * The cap is the same 16 MiB the evidence file gets. It exists so a pathological sidecar cannot make
 * the runner read an unbounded file into memory before the server ever sees it.
 */
function readSidecar(path) {
  if (!path) return undefined;
  try {
    const bytes = statSync(path).size;
    if (bytes < 1 || bytes > 16 * 1024 * 1024) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function main() {
  const evidencePath = process.env.ABLOH_EVIDENCE_PATH;
  if (!evidencePath) throw new Error("ABLOH_EVIDENCE_PATH is required");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  /* Handed in unconditionally; buildStructuralHandoff drops them below tier 2, so the tier decision
     lives in one place rather than being re-derived here. */
  const sidecars = {
    rationales: readSidecar(process.env.ABLOH_RATIONALES_PATH),
    fixProofs: readSidecar(process.env.ABLOH_FIX_PROOFS_PATH),
  };
  process.stdout.write(
    JSON.stringify(buildStructuralHandoff(evidence, contextFromEnvironment(), sidecars)),
  );
}

/*
 * Run as a script, stay silent when imported.
 *
 * Two traps here, both of which produce an EMPTY envelope rather than an error:
 *
 *  - The workflow pipes this file to `node --input-type=module` on STDIN, where
 *    process.argv[1] is undefined. Any comparison against it fails, main() never
 *    runs, and the upload step writes a zero-byte payload.
 *  - argv[1] is the path as given, while import.meta.url is fully resolved. On
 *    macOS /var is a symlink to /private/var, so the two disagree for the same
 *    file. Both sides are therefore reduced to a real path before comparison.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return true; /* stdin: nothing else could have imported us */
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
