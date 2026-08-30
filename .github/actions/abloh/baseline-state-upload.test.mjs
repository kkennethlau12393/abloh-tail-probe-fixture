import assert from "node:assert/strict";
import test from "node:test";

import { buildStructuralHandoff } from "./build-handoff.mjs";
import { buildStructuralUpload } from "./prepare-upload.mjs";

/*
 * WHAT HAPPENED TO THE SUITE, ON ITS WAY OUT OF THE RUNNER.
 *
 * `redBaseline: false` used to be the whole story this block told, and three different runs tell
 * it: a suite that was green, a suite the engine KILLED at its per-run wall having observed
 * nothing, and a suite that was red until its failing tests were excluded. Both producers dropped
 * everything that separated them, so the last two were uploaded, signed and rendered as fully
 * green (external review 2026-08-27, rank 2), and the counts and names behind a red baseline were
 * dropped with them (rank 7).
 *
 * BOTH DOORS, because both exist: `build-handoff.mjs` is what the composite Action runs today and
 * `prepare-upload.mjs` is the self-vouched body. A field that reaches one and not the other makes
 * what a customer's pull request says depend on which door their CI used.
 *
 * The ingest side of the same contract - that these shapes are ACCEPTED, and that a half of one is
 * refused - is `apps/api/src/ci-handoff-projection-contract.test.ts`.
 */

const SHA = "b".repeat(40);
const BASE = "a".repeat(40);

const CONTEXT = {
  repository: "acme/widgets",
  triggerSha: SHA,
  headSha: SHA,
  pullRequest: "25",
  workflowRef: "acme/widgets/.github/workflows/abloh.yml@refs/pull/25/merge",
  workflowSha: "c".repeat(40),
  runId: "17263544120",
  runAttempt: "1",
  artifactDigest: `sha256:${"d".repeat(64)}`,
  policySource: "repository-file",
  policyPath: "abloh.yml",
  policyDigest: `sha256:${"e".repeat(64)}`,
};

const PROVENANCE = { repository: "acme/widgets", headSha: SHA, pullRequest: "25" };

function artifact(baseline) {
  return {
    schema: "attest-results/v2",
    engine: { name: "stryker", version: "9.0.0" },
    target: { repo: "/tmp/checkout", baseSha: BASE, sha: SHA, runner: "vitest" },
    tier: 1,
    mutantsPlanned: 0,
    mutantsRun: 0,
    counts: { killed: 0, timeout: 0, survived: 0, "no-coverage": 0, "runtime-error": 0, "build-error": 0, "skipped-by-cap": 0 },
    scores: { rawScore: null, triagedScore: null, denominator: 0, confirmedEquivalent: 0, triageValidated: false },
    gate: { status: "cannot-attest", score: null, threshold: 70 },
    findings: [],
    baseline,
    skipBaseline: false,
    floor: null,
    rawCoverageDigest: null,
    rawCoverageFormat: null,
    rawReportDigest: null,
    rawCarrierDigest: null,
  };
}

const STOPPED = {
  runs: 1,
  durationsMs: [600_000],
  redBaseline: false,
  runTimedOut: true,
  runTimeoutNotice:
    "baseline run 1 of 3 was stopped at its 10 minute bound after 10 minute(s). This is not a " +
    "failing suite and no score is published for it.",
  runBoundDisclosure: "per-run bound 10 minute(s), the floor, because no repetition of this suite had been measured yet.",
};

const RESCUED = {
  runs: 3,
  durationsMs: [1_000, 1_100, 1_050],
  redBaseline: false,
  testCount: 200,
  quarantine: {
    excluded: 3,
    measured: 197,
    names: ["suite > alpha", "suite > beta", "suite > gamma"],
    failing: ["suite > alpha", "suite > beta"],
    byReason: { unstable: 1, "failing-at-baseline": 2 },
    rescuedRedBaseline: true,
    disclosure: "3 of 200 tests were excluded from measurement.",
  },
};

const RED = {
  runs: 3,
  durationsMs: [900, 910, 890],
  redBaseline: true,
  testCount: 161,
  redBaselineDetail: "12 of 161 test(s) executed failed in every run: parser > rejects a bad token.",
};

test("both doors carry a suite that was stopped at its own bound, with the sentence that says so", () => {
  for (const [door, baseline] of [
    ["handoff", buildStructuralHandoff(artifact(STOPPED), CONTEXT).evidence.baseline],
    ["self-vouched", buildStructuralUpload(artifact(STOPPED), PROVENANCE).results.baseline],
  ]) {
    assert.equal(baseline.runTimedOut, true, door);
    assert.match(baseline.runTimeoutNotice, /stopped at its 10 minute bound/u, door);
    assert.match(baseline.runBoundDisclosure, /per-run bound/u, door);
    assert.equal(baseline.redBaseline, false, `${door}: a killed run is not a failing suite`);
  }
});

test("both doors carry the exclusion that rescued a red baseline, names and tally included", () => {
  for (const [door, baseline] of [
    ["handoff", buildStructuralHandoff(artifact(RESCUED), CONTEXT).evidence.baseline],
    ["self-vouched", buildStructuralUpload(artifact(RESCUED), PROVENANCE).results.baseline],
  ]) {
    assert.equal(baseline.quarantine.rescuedRedBaseline, true, door);
    assert.equal(baseline.quarantine.excluded, 3, door);
    assert.deepEqual(baseline.quarantine.names, RESCUED.quarantine.names, door);
    /* The receiver checks that this tally sums to `excluded`, so a key dropped here refuses the
       whole upload rather than degrading the disclosure. */
    assert.deepEqual(baseline.quarantine.byReason, RESCUED.quarantine.byReason, door);
  }
});

test("both doors carry the counts and names behind a red baseline", () => {
  for (const [door, baseline] of [
    ["handoff", buildStructuralHandoff(artifact(RED), CONTEXT).evidence.baseline],
    ["self-vouched", buildStructuralUpload(artifact(RED), PROVENANCE).results.baseline],
  ]) {
    assert.equal(baseline.redBaselineDetail, RED.redBaselineDetail, door);
  }
});

test("a runner's raw output in a baseline sentence cannot refuse the run it describes", () => {
  /* These sentences are composed on the customer's machine and the ingest door accepts one bounded
     single line. A newline in a notice must cost the tail of a sentence, never the measurement. */
  const messy = {
    ...STOPPED,
    runTimeoutNotice: `stopped at its bound\n\tat /home/runner/work/service\n${"x".repeat(900)}`,
  };
  const { baseline } = buildStructuralHandoff(artifact(messy), CONTEXT).evidence;
  assert.equal(baseline.runTimeoutNotice, "stopped at its bound");
});

test("a green run states the absence rather than dropping the key", () => {
  /* jq's rule, which this envelope keeps: an absent optional field is an explicit null, so the
     key count never shortens under a producer that had nothing to say. */
  const { baseline } = buildStructuralHandoff(
    artifact({ runs: 3, durationsMs: [10, 10, 10], redBaseline: false }),
    CONTEXT,
  ).evidence;
  for (const key of ["runTimeoutNotice", "runBoundDisclosure", "redBaselineDetail", "quarantine"]) {
    assert.ok(key in baseline, `${key} must be present as null, never missing`);
    assert.equal(baseline[key], null);
  }
});
