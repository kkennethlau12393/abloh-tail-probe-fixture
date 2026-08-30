/**
 * THE `vitejs/vite` ROW, REPRODUCED AT THE STEP THAT COULD NOT EXPLAIN IT.
 *
 * Certification census, wave 3, run 33249763448, job "Build&Test: node-26, ubuntu-latest". Read off
 * the job's own log, in order:
 *
 *     Abloh                                   = failure, exit 2
 *     File the setup report                   = success
 *     Validate completed measurement artifact = success, complete=false
 *     Upload measured evidence                = skipped
 *     census - keep the run artifact          : "No files were found with the provided path"
 *
 * Every step did what it was written to do. The census could still only file the row as
 * `no-artifact` and then reverse-engineer a cause out of log prose, because the refusal existed
 * nowhere except on stderr four steps earlier.
 *
 * BOTH HALVES ARE TESTED HERE, because either alone would have passed on the real run:
 *
 *   - a refusal record IS read back, with its code, its owner, its stage and its next action;
 *   - a directory with NO record gets its own distinct sentence, because since the CLI's one-door
 *     invariant that state means something specific - the run never reached its own exit - and
 *     reporting it as a refusal would be inventing a cause.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { explainMissingArtifact, readRunRefusal, validateArtifact } from "./action-boundary.mjs";

/** Collects what the boundary would have written into the job log. */
function sink() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

function outputDirectory() {
  return mkdtempSync(join(tmpdir(), "abloh-missing-artifact-"));
}

/** The record `apps/cli/src/run-outcome.ts` writes, as the vite run would have written it. */
const VITE_RECORD = {
  schema: "abloh-run-refusal/v1",
  attesting: false,
  exitCode: 2,
  code: "package-manager-cache-missing",
  stage: "environment",
  owner: "environment",
  summary:
    "Corepack pnpm@10.34.5 is not present in the offline cache abloh reads, and abloh could not " +
    "fetch it",
  nextAction:
    "Check that this machine can reach the registry corepack fetches pnpm from and that " +
    "pnpm@10.34.5 is a version that exists, then push again",
  reportId: null,
};

test("the step that finds no artifact reads back why there is none", () => {
  const directory = outputDirectory();
  try {
    writeFileSync(join(directory, "abloh-refusal.json"), `${JSON.stringify(VITE_RECORD, null, 2)}\n`);
    const out = sink();
    const record = explainMissingArtifact({ ABLOH_OUTPUT_DIR: directory }, out);
    assert.ok(record !== null);
    const log = out.lines.join("");
    assert.match(log, /no measurement was produced/u);
    assert.match(log, /Corepack pnpm@10\.34\.5 is not present in the offline cache abloh reads/u);
    assert.match(log, /refusal code package-manager-cache-missing/u);
    assert.match(log, /owned by environment/u);
    assert.match(log, /at the environment stage/u);
    assert.match(log, /Check that this machine can reach the registry/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a run that never reached its own exit is said to be that, not dressed as a refusal", () => {
  const directory = outputDirectory();
  try {
    const out = sink();
    assert.equal(explainMissingArtifact({ ABLOH_OUTPUT_DIR: directory }, out), null);
    const log = out.lines.join("");
    assert.match(log, /left no refusal record, so it did not reach its own exit/u);
    assert.doesNotMatch(log, /refusal code/u, "there is no code to name, so none is named");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the artifact and the refusal are two answers to one question, and only one is ever there", () => {
  const directory = outputDirectory();
  try {
    /* The vite shape exactly: `validate-artifact` returns nothing, so the shell writes
       `complete=false` and the explanation step is what runs next. */
    assert.equal(
      validateArtifact({ ABLOH_OUTPUT_DIR: directory, ABLOH_ARTIFACT_NAME: "attest-results.json" }),
      null,
    );
    writeFileSync(join(directory, "abloh-refusal.json"), `${JSON.stringify(VITE_RECORD)}\n`);
    assert.ok(readRunRefusal(join(directory, "abloh-refusal.json")) !== null);

    /* And the measured shape: the artifact is there, so nothing asks for a refusal at all. */
    writeFileSync(join(directory, "attest-results.json"), "{}\n");
    assert.ok(
      validateArtifact({ ABLOH_OUTPUT_DIR: directory, ABLOH_ARTIFACT_NAME: "attest-results.json" }) !== null,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a record this boundary cannot vouch for is ignored rather than half-read", () => {
  const directory = outputDirectory();
  const path = join(directory, "abloh-refusal.json");
  try {
    for (const bytes of [
      "not json at all",
      JSON.stringify({ schema: "something-else/v1", summary: "hello" }),
      JSON.stringify({ schema: "abloh-run-refusal/v1" }),
      JSON.stringify({ schema: "abloh-run-refusal/v1", summary: "   " }),
    ]) {
      writeFileSync(path, bytes);
      assert.equal(readRunRefusal(path), null, `must not be read: ${bytes.slice(0, 40)}`);
    }
    /* AND AN OVERSIZE ONE, because this file is on a runner's disk and its destination is a public
       job log. A refusal record is four short sentences; anything larger is not this file. */
    writeFileSync(path, JSON.stringify({ schema: "abloh-run-refusal/v1", summary: "x".repeat(64 * 1024) }));
    assert.equal(readRunRefusal(path), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("control characters in a record cannot rewrite the job log's own framing", () => {
  const directory = outputDirectory();
  const path = join(directory, "abloh-refusal.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        ...VITE_RECORD,
        summary: "a refusal\n##[error]something the boundary never said",
      }),
    );
    const record = readRunRefusal(path);
    assert.ok(record !== null);
    assert.doesNotMatch(record.summary, /\n/u, "a newline would let a record write its own log lines");
    assert.match(record.summary, /a refusal ##\[error\]/u, "the bytes survive, flattened to one line");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ the third record: a sweep ledger */

/**
 * A SUCCESSFUL SWEEP TOLD THE MAINTAINER THEIR JOB WAS CANCELLED (first full corpus pass,
 * 2026-08-30, finding 3).
 *
 * Reproduced on the rig's own CLEAN control scenario, which walls nowhere and exits 0. Every link
 * is mechanical: a sweep writes no `attest-results.json` by design, so the validate step answers
 * `complete=false` and calls this boundary; the boundary read only `abloh-refusal.json`; the sweep
 * had left `abloh-sweep.json` instead; and the read returned null, so a run that did exactly what
 * it was asked printed "A cancelled job or a runner that went away is the usual cause."
 *
 * `apps/cli/src/run-outcome.ts` states the invariant this violated in its own words: a run leaves
 * ONE of three records - a measurement, a sweep ledger, or a refusal. The boundary knew two.
 *
 * `sweep` is a public input of `action.yml`, so this reached any customer who set it, and every one
 * of the twenty-nine corpus rows carried the sentence because every rehearsal is a sweep.
 */
const CLEAN_SWEEP = {
  schema: "abloh-wall-sweep/v1",
  mode: "sweep",
  attesting: false,
  entries: [
    { stage: "detect", state: "passed", wallMs: 12, note: "command via npm", refusal: null },
    { stage: "baseline", state: "passed", wallMs: 400, note: null, refusal: null },
  ],
  terminal: null,
  budget: { totalMs: 1000, spentMs: 412 },
};

const WALLED_SWEEP = {
  ...CLEAN_SWEEP,
  entries: [
    { stage: "detect", state: "passed", wallMs: 12, note: null, refusal: null },
    {
      stage: "baseline",
      state: "failed",
      wallMs: 90,
      note: null,
      refusal: {
        summary: "red baseline - cannot attest on a failing suite. The test command exited 1",
        localDetail: "THIS IS LOCAL ONLY and must never reach a public job log",
      },
    },
    {
      stage: "mutation",
      state: "failed",
      wallMs: 0,
      note: null,
      neverStarted: true,
      refusal: { summary: "the baseline never went green, so no mutant could be judged", localDetail: null },
    },
  ],
};

test("a successful sweep is never reported as a cancelled job", () => {
  const directory = outputDirectory();
  try {
    writeFileSync(join(directory, "abloh-sweep.json"), `${JSON.stringify(CLEAN_SWEEP, null, 2)}\n`);
    const out = sink();
    const found = explainMissingArtifact({ ABLOH_OUTPUT_DIR: directory }, out);
    assert.equal(found.kind, "sweep-ledger");
    assert.equal(found.wallCount, 0);
    const log = out.lines.join("");
    assert.doesNotMatch(log, /cancelled/u, "nothing was cancelled and nothing went away");
    assert.doesNotMatch(log, /did not reach its own exit/u);
    assert.match(log, /none was meant to be/u, "a sweep attests nothing BY DESIGN");
    assert.match(log, /found no wall/u);
    assert.match(log, /abloh-sweep\.json/u, "and the ledger is named so a reader can open it");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a sweep that found walls names each one through the refusal registry's own sentence", () => {
  const directory = outputDirectory();
  try {
    writeFileSync(join(directory, "abloh-sweep.json"), `${JSON.stringify(WALLED_SWEEP)}\n`);
    const out = sink();
    const found = explainMissingArtifact({ ABLOH_OUTPUT_DIR: directory }, out);
    assert.equal(found.wallCount, 2);
    const log = out.lines.join("");
    assert.match(log, /found 2 wall\(s\)/u);
    assert.match(log, /wall at the baseline stage: red baseline - cannot attest on a failing suite/u);
    assert.match(log, /This stage never started against that wall/u);
    /* THE DECLARED PRIVACY IS WHAT HAPPENS. `localDetail` is local-only by the sweep's own rule and
       this writes into a log that is public on a fork's pull request. */
    assert.doesNotMatch(log, /LOCAL ONLY/u);
    assert.doesNotMatch(log, /cancelled/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an init validation run is named as what it is, not as a sweep and not as a cancellation", () => {
  const directory = outputDirectory();
  try {
    writeFileSync(
      join(directory, "abloh-init-validation.json"),
      `${JSON.stringify({ ...CLEAN_SWEEP, mode: "validate" })}\n`,
    );
    const out = sink();
    const found = explainMissingArtifact({ ABLOH_OUTPUT_DIR: directory }, out);
    assert.equal(found.mode, "validate");
    assert.match(out.lines.join(""), /an abloh init validation run/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a refusal record still wins over a sweep ledger, because it is the more specific answer", () => {
  /* Both can exist when a sweep's own exit refuses. The refusal names a code, an owner, a stage and
     a next action; the ledger names stages. The reader gets the one that can be acted on. */
  const directory = outputDirectory();
  try {
    writeFileSync(join(directory, "abloh-sweep.json"), `${JSON.stringify(CLEAN_SWEEP)}\n`);
    writeFileSync(join(directory, "abloh-refusal.json"), `${JSON.stringify(VITE_RECORD)}\n`);
    const out = sink();
    assert.equal(explainMissingArtifact({ ABLOH_OUTPUT_DIR: directory }, out).code, "package-manager-cache-missing");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a document this boundary cannot vouch for falls through to the cancelled-job sentence", () => {
  /* THE ORIGINAL SENTENCE IS RIGHT FOR WHAT IT DESCRIBES AND STAYS EXACTLY AS IT IS. What was wrong
     was that one of the three records a run may leave was not on this side of the boundary. */
  const directory = outputDirectory();
  const path = join(directory, "abloh-sweep.json");
  try {
    for (const bytes of [
      "not json at all",
      JSON.stringify({ schema: "something-else/v1", entries: [] }),
      /* `attesting: false` IS IN THE DOCUMENT'S OWN BYTES, and a document claiming otherwise is not
         one this may summarise as "no measurement was meant to be". */
      JSON.stringify({ schema: "abloh-wall-sweep/v1", attesting: true, entries: [] }),
    ]) {
      writeFileSync(path, bytes);
      const out = sink();
      assert.equal(explainMissingArtifact({ ABLOH_OUTPUT_DIR: directory }, out), null, bytes.slice(0, 30));
      assert.match(out.lines.join(""), /did not reach its own exit/u);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
