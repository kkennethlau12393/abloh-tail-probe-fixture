import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStructuralHandoff, contextFromEnvironment, normalizeL0Reason } from "./build-handoff.mjs";

/*
 * The port of the jq envelope builder to JavaScript is only safe if the two
 * produce identical bytes. This runs the ORIGINAL jq filter — extracted from the
 * workflow template at test time, not a copy — and the JS builder over the same
 * inputs, and requires the serialized results to match exactly.
 *
 * Deleting the jq filter from the template will make the extraction fail, which
 * is intentional: this file is the evidence the port was faithful, so it must be
 * run and seen green BEFORE the filter is removed. After removal, keep the
 * golden-output assertions below; they no longer need jq.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "..", "..", "..", "corpus", "artifacts");

const CONTEXT = {
  repository: "Vero-Technology/Cosmos",
  triggerSha: "1bd848465cc2aedc949c77471bd848465cc2aedc",
  headSha: "1bd848465cc2aedc949c77471bd848465cc2aedc",
  pullRequest: "25",
  workflowRef: "Vero-Technology/Cosmos/.github/workflows/abloh.yml@refs/pull/25/merge",
  workflowSha: "aedc949c77471bd848465cc2aedc949c77471bd8",
  runId: "17263544120",
  runAttempt: "1",
  artifactDigest: "sha256:" + "a".repeat(64),
  policySource: "repository-file",
  policyPath: "abloh.yml",
  policyDigest: "sha256:" + "b".repeat(64),
};

/**
 * Pull the live jq filter out of the workflow template, so the test cannot drift
 * from what CI actually runs. Read as raw text rather than parsed YAML: the
 * filter is a block scalar, and this avoids a yaml dependency for one lookup.
 */

function runJq(filter, evidence) {
  const dir = mkdtempSync(join(tmpdir(), "abloh-jq-"));
  const path = join(dir, "evidence.json");
  writeFileSync(path, JSON.stringify(evidence));
  const args = ["-e", "-c"];
  for (const [flag, value] of [
    ["repository", CONTEXT.repository],
    ["triggerSha", CONTEXT.triggerSha],
    ["headSha", CONTEXT.headSha],
    ["pullRequest", CONTEXT.pullRequest],
    ["workflowRef", CONTEXT.workflowRef],
    ["workflowSha", CONTEXT.workflowSha],
    ["runId", CONTEXT.runId],
    ["runAttempt", CONTEXT.runAttempt],
    ["artifactDigest", CONTEXT.artifactDigest],
    ["policySource", CONTEXT.policySource],
    ["policyPath", CONTEXT.policyPath],
    ["policyDigest", CONTEXT.policyDigest],
  ]) {
    args.push("--arg", flag, value);
  }
  args.push(filter, path);
  return execFileSync("jq", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function corpusArtifacts() {
  if (!existsSync(CORPUS)) return [];
  const out = [];
  for (const dir of readdirSync(CORPUS)) {
    const file = join(CORPUS, dir, "attest-results.json");
    if (!existsSync(file)) continue;
    try {
      out.push({ name: dir, evidence: JSON.parse(readFileSync(file, "utf8")) });
    } catch {
      /* an unparseable artifact is not this test's subject */
    }
  }
  return out;
}

function jqAvailable() {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const HEX = "f".repeat(64);

/**
 * Evidence in the shape the CURRENT producer emits. The corpus artifacts cannot
 * serve here: they are attest-results/v1 research data with no `target.baseSha`,
 * and the validator refuses them for that reason alone — which says nothing
 * about whether this builder is correct.
 */
function v2Evidence(overrides = {}) {
  return {
    schema: "attest-results/v2",
    engine: { name: "stryker", version: "8.0.0" },
    target: { baseSha: BASE_SHA, sha: SHA, runner: "vitest" },
    scope: [],
    diffCoverage: null,
    rawCoverageDigest: null,
    rawCoverageFormat: null,
    mutationExecution: null,
    mutationScope: [],
    tier: 1,
    mutantsPlanned: 0,
    mutantsRun: 0,
    counts: {
      killed: 0, timeout: 0, survived: 0, "no-coverage": 0,
      "runtime-error": 0, "build-error": 0, "skipped-by-cap": 0,
    },
    scores: {
      rawScore: null, triagedScore: null, denominator: 0,
      errorCount: 0, confirmedEquivalent: 0, triageValidated: false,
    },
    floor: null,
    gate: { status: "cannot-attest", score: null, threshold: 0.7 },
    baseline: null,
    findings: [],
    policy: {
      threshold: 0.7, enforce: false, tier: 1,
      floor: { minMutantsExecuted: 1, maxErrorRate: 0.1, minSamplingFraction: 0.5 },
    },
    /* rationalesDigest and rawReportDigest are bare hex; policyDigest and
       artifactDigest carry the sha256: prefix. The validator distinguishes. */
    rationalesDigest: HEX,
    rawReportDigest: HEX,
    skipBaseline: false,
    ...overrides,
  };
}

const V2_CONTEXT = {
  ...CONTEXT,
  triggerSha: SHA,
  headSha: SHA,
  workflowSha: "c".repeat(40),
  artifactDigest: "sha256:" + "d".repeat(64),
  policyDigest: "sha256:" + HEX,
};

const VALIDATOR_CASES = [
  ["minimal run", v2Evidence()],
  ["with a baseline", v2Evidence({
    baseline: {
      runs: 3, durationsMs: [1200, 1190, 1210], redBaseline: false,
      testCount: 412, testCounts: [412, 412, 412], testIdentityCount: 412,
      ambiguousIdentityCount: 0, flakyCount: 0, timingCv: 0.01,
      timeoutFactor: 2, quarantineDowngraded: 0,
    },
  })],
  ["Diff coverage cannot attest", v2Evidence({
    mutationExecution: { state: "skipped", reason: "layer-0-failed", scope: null },
    diffCoverage: {
      state: "cannot-attest", reason: "coverage provider unavailable",
      wallMs: null, provider: null, counts: null, lines: [],
    },
  })],
];

/**
 * Extract the workflow's own validator — the ~1000-line script that runs
 * immediately after the builder in CI and decides whether the envelope may be
 * uploaded. Running this builder's output through it is the real safety net: it
 * asserts the envelope is ACCEPTED by the actual gatekeeper.
 */

function runValidator(validatorPath, dir, envelope) {
  const payloadPath = join(dir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify(envelope));
  try {
    execFileSync("node", [validatorPath], {
      env: { ...process.env, ABLOH_STRUCTURAL_PAYLOAD: payloadPath },
      stdio: "pipe",
    });
    return null;
  } catch (error) {
    const line = String(error.stderr ?? "").split("\n").find((l) => l.startsWith("TypeError"));
    return (line ?? String(error.message)).replace("TypeError: invalid structural handoff: ", "");
  }
}

test("a field the producer omits becomes null, never a missing key", () => {
  /* jq yields null for an absent key; JSON.stringify DELETES undefined, which
     would silently shorten the envelope below the endpoint's exact-key count. */
  const evidence = v2Evidence();
  delete evidence.rawCoverageFormat;
  delete evidence.target.baseSha;
  const round = JSON.parse(JSON.stringify(buildStructuralHandoff(evidence, V2_CONTEXT)));
  assert.ok("rawCoverageFormat" in round.evidence, "top-level key vanished");
  assert.equal(round.evidence.rawCoverageFormat, null);
  assert.ok("baseSha" in round.evidence.target, "nested key vanished");
  assert.equal(round.evidence.target.baseSha, null);
});

test("unknown producer keys never reach the envelope", () => {
  const evidence = v2Evidence({ mutants: [{ originalText: "if (a && b)" }], secretThing: 1 });
  evidence.target.repo = "/Users/kenneth/abloh/corpus/vet-clones/cosmos";
  const envelope = buildStructuralHandoff(evidence, V2_CONTEXT);
  const serialized = JSON.stringify(envelope);
  /* Match the exact key, not the substring: mutantsPlanned/mutantsRun are legitimate. */
  assert.ok(!serialized.includes('"mutants":'), "mutants[] leaked");
  assert.ok(!serialized.includes("originalText"), "mutant source text leaked");
  assert.ok(!serialized.includes("secretThing"), "an unknown key leaked");
  assert.ok(!serialized.includes("/Users/kenneth"), "a runner-local path leaked");
  assert.equal(envelope.evidence.target.repo, undefined, "target.repo leaked");
});

test("source-bearing fields never reach the envelope", () => {
  const artifacts = corpusArtifacts();
  assert.ok(artifacts.length > 0);
  for (const { name, evidence } of artifacts) {
    let envelope;
    try {
      envelope = buildStructuralHandoff(evidence, CONTEXT);
    } catch {
      continue;
    }
    const serialized = JSON.stringify(envelope);
    for (const forbidden of ["originalText", "replacement", "coveredByTests", "killedByTests", "rationale", "mutants"]) {
      assert.ok(
        !serialized.includes(`"${forbidden}"`),
        `${name}: envelope carries ${forbidden}`,
      );
    }
    /* target.repo on the runner is an absolute local path. */
    assert.equal(envelope.evidence.target.repo, undefined, `${name}: envelope carries target.repo`);
  }
});

test("the envelope carries exactly the keys the endpoint accepts", () => {
  const artifacts = corpusArtifacts();
  /* The WIDENED shape — this producer's releases register their workflow SHA against the
     27-key table server-side (ci-handoff evidenceKeysForWorkflowSha). */
  const V2_EVIDENCE_KEYS = [
    "schema", "engine", "target", "scope", "diffCoverage", "rawCoverageDigest",
    "rawCoverageFormat", "mutationExecution", "mutationScope", "tier", "mutantsPlanned",
    "mutantsRun", "counts", "scores", "floor", "gate", "baseline", "findingCount",
    "findings", "policy", "rationalesDigest", "rawReportDigest", "skipBaseline",
    "evidenceProfile", "packages", "mutantRoster",
    /* The redacted mutation report's commitment. Emitted unconditionally (null when the run
       produced no redacted report), so it belongs in the exact list, not the optional one. */
    "redactedReportDigest",
    /* The Ext-5 error-handler scan, likewise always emitted and null when no scan ran. It is half
       of a gate the server RE-DERIVES, so its absence refused whole uploads rather than degrading
       a display — see build-handoff.recompute.test.mjs. */
    "errorHandlers",
    /* The fix-loop block, carrying the commitment its tier-2 sidecar is verified against. */
    "fixLoop",
    /* The v2 engine's block, carrying the commitment ITS proofs sidecar is verified against. Also
       always emitted, null on every run of the v1 arm, which is every run until the engine default
       flips - so it belongs in the exact list beside fixLoop rather than in the optional one. */
    "engineV2",
    /* Per-phase wall clock — always emitted (null when the artifact carried none), so it belongs
       in the exact list rather than the optional one. */
    "mutationWallMs", "triageWallMs",
    /* What the run's model calls cost, summed once by the producer. Always emitted on the same
       terms as the durations above: null when the artifact carried none, which is what an Action
       released before the block existed produces. */
    "modelCost",
    /* ABLOH'S OWN FAILURE, in one bounded line. Always emitted, null on every run that did not fail
       inside abloh - which is the same terms as the two above and the reason it belongs in the
       exact list. The complete engine log deliberately stays on the machine that produced it. */
    "engineFailure",
  ];
  for (const { name, evidence } of artifacts) {
    let envelope;
    try {
      envelope = buildStructuralHandoff(evidence, CONTEXT);
    } catch {
      continue;
    }
    assert.deepEqual(
      Object.keys(envelope).sort(),
      ["artifactDigest", "evidence", "provenance", "schema"],
      `${name}: unexpected top-level keys`,
    );
    assert.deepEqual(
      Object.keys(envelope.evidence).sort(),
      [...V2_EVIDENCE_KEYS].sort(),
      `${name}: evidence keys do not match the endpoint's widened exact list`,
    );
  }
});

test("baseline carries the whole state, not just redBaseline", () => {
  /*
   * The six names past the original eleven are the STATE this block could not express before
   * 2026-08-27, and every one of them was a run that rendered green after being stripped: a run the
   * engine killed at its per-run wall (`runTimedOut` with its notice and bound), a run the shared
   * pre-mutation deadline ended (`deadlineExceeded`), a red baseline rescued by excluding its
   * failing tests (`quarantine`), and the counts and names behind a red one (`redBaselineDetail`).
   *
   * `shard` joined them on 2026-08-28 for the same reason one key later (silent-discard sweep). A
   * repository whose own test command carries `--shard=1/4` measures a quarter of its suite; the
   * CLI records the fraction, the run page reads `baseline.shard` and renders it, and this
   * projection was dropping it in between - so the hosted rate covered a quarter of the tests and
   * said nothing about it. `replay` joined in the same pass and for the same reason: the run page
   * has `baseline-replayed` and `baseline-recording-missing` notes that no upload could reach.
   *
   * `perTestAttribution` is the same shape one round later (external refusal review, rank 3): a
   * baseline whose per-test reports never parsed has an empty flaky set because nothing could be
   * compared, and `redBaseline: false` beside it rendered as "all green".
   */
  const evidence = corpusArtifacts().map((a) => a.evidence).find((e) => e.baseline);
  if (!evidence) return;
  const { baseline } = buildStructuralHandoff(evidence, CONTEXT).evidence;
  assert.deepEqual(Object.keys(baseline).sort(), [
    "ambiguousIdentityCount", "deadlineExceeded", "durationsMs", "flakyCount", "perTestAttribution",
    "quarantine", "quarantineDowngraded", "redBaseline", "redBaselineDetail", "replay",
    "runBoundDisclosure", "runTimedOut", "runTimeoutNotice", "runs", "shard", "testCount",
    "testCounts", "testIdentityCount", "timeoutFactor", "timingCv",
  ]);
});

/**
 * THE SHARD SURVIVES THE PROJECTION, which is what the run page needs to say the rate covers a
 * fraction. Driven through the real builder rather than asserted on the key list, because a key
 * present and null is the same silence as a key absent.
 */
test("a sharded baseline reaches the control plane as two integers", () => {
  const evidence = minimalEvidence({
    baseline: {
      runs: 3,
      durationsMs: [1, 1, 1],
      redBaseline: false,
      shard: { index: 1, total: 4, flag: "--shard=1/4", disclosure: "1 of 4 shards measured" },
    },
  });
  const { baseline } = buildStructuralHandoff(evidence, CONTEXT).evidence;
  assert.deepEqual(baseline.shard, { index: 1, total: 4 });
  /* The producer's own sentence is NOT egressed: the run page composes its own words from the two
     integers, and this file does not forward unbounded runner text a surface will not print. */
  assert.equal(baseline.shard.flag, undefined);
  assert.equal(baseline.shard.disclosure, undefined);

  /* An unsharded run carries the absence rather than a key that vanishes. */
  const plain = buildStructuralHandoff(
    minimalEvidence({ baseline: { runs: 3, durationsMs: [1, 1, 1], redBaseline: false } }),
    CONTEXT,
  ).evidence;
  assert.equal(plain.baseline.shard, null);

  /* And a nonsense fraction is not forwarded as one. */
  for (const bad of [{ index: 5, total: 4 }, { index: 0, total: 4 }, { index: 1, total: 0 }, { index: "1", total: 4 }]) {
    const out = buildStructuralHandoff(
      minimalEvidence({ baseline: { runs: 1, durationsMs: [1], redBaseline: false, shard: bad } }),
      CONTEXT,
    ).evidence;
    assert.equal(out.baseline.shard, null, `${JSON.stringify(bad)} is not a fraction`);
  }
});

/**
 * A RUN PAST THE FINDING BOUND REFUSES HERE, BY NAME (junction audit ACT-FIND-01, 2026-08-28).
 *
 * This test used to assert the defect: the list was capped at 10,000 while `findingCount` beside it
 * stayed the true total. The control plane's ingest door requires the two to agree, so every such
 * run was rejected by an invariant invisible from the job log - the customer's CI failed as
 * configured, then reported `HTTP 400` with no body, and a correct measurement was thrown away.
 *
 * Truncating honestly is not available either: the server RE-DERIVES the gate from the findings it
 * receives, so a flagged-path violation past the cap would be missing from that recompute and the
 * recomputed gate would pass where the artifact failed. So the bound stops the upload here, with the
 * count, the bound and the remedy in one sentence, and the whole measurement still in the artifact.
 */
test("a run past the finding bound refuses the upload here, naming the count and the remedy", () => {
  const findings = Array.from({ length: 10_005 }, (_, i) => ({
    mutantId: `m${i}`, file: "a.ts", startLine: 1, endLine: 1,
    mutator: "LogicalOperator", status: "survived", coveredBy: 1, triage: null,
  }));
  assert.throws(
    () => buildStructuralHandoff(minimalEvidence({ findings }), CONTEXT),
    (error) => {
      assert.match(error.message, /reported 10005 findings/u);
      assert.match(error.message, /at most 10000/u);
      assert.match(error.message, /in this job's own artifact/u);
      assert.match(error.message, /Narrow what this check measures/u);
      return true;
    },
  );

  /* And a run AT the bound still uploads, whole, with the two numbers agreeing. */
  const atBound = minimalEvidence({ findings: findings.slice(0, 10_000) });
  const { evidence: out } = buildStructuralHandoff(atBound, CONTEXT);
  assert.equal(out.findings.length, 10_000);
  assert.equal(out.findingCount, 10_000);
});

/*
 * WHAT THESE TWO TESTS USED TO ASSERT, AND WHY THEY NOW ASSERT SOMETHING ELSE (external refusal
 * review, rank 5).
 *
 * The first required an unrecognised reason to THROW, and the throw discards the entire handoff -
 * every package that measured perfectly included. That is the rank 5 defect written down as a
 * requirement: the reviewer reproduced three reachable engine sentences hitting it, and the customer
 * saw only an HTTP status on a run that had succeeded on their own machine.
 *
 * The second pinned twenty-odd rules that guessed a wire code back out of a sentence. The engine
 * declares its code at the throw now (`packages/engine-stryker/src/coverage.ts`), so there is
 * nothing left to guess, and the rules were never able to cover every sentence anyway.
 *
 * The PRIVACY property both were really protecting is unchanged and is asserted directly below: a
 * free-text reason never reaches the wire. It cannot, because only a closed code is ever written.
 */
test("an unrecognized cannot-attest reason is generalised, and its text never reaches the wire", () => {
  const evidence = minimalEvidence({
    diffCoverage: {
      state: "cannot-attest",
      reason: "/Users/kenneth/secret/path exploded",
      wallMs: null, provider: null, counts: null, lines: [],
    },
  });
  const { evidence: out } = buildStructuralHandoff(evidence, CONTEXT);
  assert.equal(out.diffCoverage.reason, "coverage-acquisition-failed");
  assert.doesNotMatch(
    JSON.stringify(out),
    /secret\/path/u,
    "a free-text reason must not be forwarded - it can embed local paths",
  );
});

test("the closed vocabulary passes through, and nothing else is invented from a sentence", () => {
  for (const code of [
    "coverage-provider-unavailable",
    "coverage-scope-incomplete",
    "coverage-report-invalid",
    "coverage-run-failed",
  ]) {
    assert.equal(normalizeL0Reason(code), code);
  }
  /* The sentences these used to be translated from now come from producers old enough not to speak
     the vocabulary, and they are generalised rather than guessed at. */
  assert.equal(normalizeL0Reason("coverage provider unavailable"), "coverage-acquisition-failed");
  assert.equal(normalizeL0Reason("lcov parse failed at line 9"), "coverage-acquisition-failed");
});

test("an absent pull request becomes null, not zero", () => {
  const evidence = minimalEvidence({});
  const withPr = buildStructuralHandoff(evidence, { ...CONTEXT, pullRequest: "25" });
  const without = buildStructuralHandoff(evidence, { ...CONTEXT, pullRequest: "" });
  assert.equal(withPr.provenance.pullRequest, 25);
  assert.equal(without.provenance.pullRequest, null);
});

test("empty policy identity becomes null rather than an empty string", () => {
  const evidence = minimalEvidence({});
  const out = buildStructuralHandoff(evidence, { ...CONTEXT, policyDigest: "", policyPath: "" });
  assert.equal(out.evidence.policy.policyDigest, null);
  assert.equal(out.evidence.policy.source.path, null);
  assert.equal(out.evidence.policy.source.sourceSha, CONTEXT.headSha);
});

test("context reads the GitHub-supplied environment", () => {
  const ctx = contextFromEnvironment({
    GITHUB_REPOSITORY: "o/r", ABLOH_HEAD_SHA: "abc", GITHUB_RUN_ATTEMPT: "2",
  });
  assert.equal(ctx.repository, "o/r");
  assert.equal(ctx.headSha, "abc");
  assert.equal(ctx.runAttempt, "2");
  assert.equal(ctx.pullRequest, "", "absent env must be empty string, not undefined");
});

/** The smallest evidence object the builder accepts, for targeted cases. */
function minimalEvidence(overrides) {
  return {
    schema: "attest-results/v2",
    engine: { name: "stryker", version: "8.0.0" },
    target: { baseSha: "b".repeat(40), sha: "a".repeat(40), runner: "vitest", repo: "/tmp/local" },
    scope: [],
    diffCoverage: null,
    rawCoverageDigest: null,
    rawCoverageFormat: null,
    mutationExecution: null,
    mutationScope: [],
    tier: 1,
    mutantsPlanned: 0,
    mutantsRun: 0,
    counts: {
      killed: 0, timeout: 0, survived: 0, "no-coverage": 0,
      "runtime-error": 0, "build-error": 0, "skipped-by-cap": 0,
    },
    scores: {
      rawScore: null, triagedScore: null, denominator: 0,
      errorCount: 0, confirmedEquivalent: 0, triageValidated: false,
    },
    floor: null,
    gate: { status: "cannot-attest", score: null, threshold: 0.7 },
    baseline: null,
    findings: [],
    policy: {
      threshold: 0.7, enforce: false, tier: 1,
      floor: { minMutantsExecuted: 1, maxErrorRate: 0.1, minSamplingFraction: 0.5 },
    },
    rationalesDigest: null,
    rawReportDigest: null,
    skipBaseline: false,
    ...overrides,
  };
}
