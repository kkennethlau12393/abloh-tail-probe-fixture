import assert from "node:assert/strict";
import test from "node:test";

import { buildStructuralHandoff } from "./build-handoff.mjs";
import { buildStructuralUpload } from "./prepare-upload.mjs";

/*
 * WHAT THE RUN CHARGED, ON ITS WAY OUT OF THE RUNNER.
 *
 * Both producers are covered because both exist: `build-handoff.mjs` is what the composite Action
 * runs today, and `prepare-upload.mjs` is the self-vouched body. A cost block that reaches one and
 * not the other is a run whose spend is recorded or lost depending on which door its CI used.
 *
 * The rules asserted here are the three the whole mechanism turns on:
 *
 *   1. The total travels WITH its lanes and its unpriced marker, never as a bare figure.
 *   2. Neither producer re-adds the lanes. The sum is the CLI's, made once; a disagreement is
 *      REFUSED, never silently replaced with a locally computed total.
 *   3. An artifact with no cost block still uploads. Those runs have no cost on record, which is a
 *      different fact from a run that cost nothing.
 */

const SHA = "b".repeat(40);
const BASE = "a".repeat(40);

const COST = {
  lanes: [
    { label: "triage and mutation extensions", dollars: 0.5693 },
    { label: "generation arm", dollars: 1.9293 },
  ],
  dollars: 2.4986,
  unpriced: null,
};

const HANDOFF_CONTEXT = {
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

function artifact(extra = {}) {
  return {
    schema: "attest-results/v2",
    engine: { name: "stryker", version: "9.0.0" },
    target: { repo: "/tmp/checkout", baseSha: BASE, sha: SHA, runner: "vitest" },
    tier: 2,
    mutantsPlanned: 10,
    mutantsRun: 10,
    counts: { killed: 8, timeout: 0, survived: 2, "no-coverage": 0, "runtime-error": 0, "build-error": 0, "skipped-by-cap": 0 },
    scores: { rawScore: 80, triagedScore: 80, denominator: 10, confirmedEquivalent: 0, triageValidated: false },
    gate: { status: "pass", score: 80, threshold: 70 },
    findings: [],
    baseline: null,
    skipBaseline: true,
    floor: null,
    rawCoverageDigest: null,
    rawCoverageFormat: null,
    rawReportDigest: null,
    rawCarrierDigest: null,
    ...extra,
  };
}

const PROVENANCE = { repository: "acme/widgets", headSha: SHA, pullRequest: "25" };

// ---------------------------------------------------------------------------
// build-handoff.mjs — the door the composite Action uses
// ---------------------------------------------------------------------------

test("the handoff carries the cost block whole: total, lanes and unpriced marker", () => {
  const { evidence } = buildStructuralHandoff(artifact({ modelCost: COST }), HANDOFF_CONTEXT);
  assert.deepEqual(evidence.modelCost, COST);
});

test("the handoff emits modelCost as null when the artifact carried none", () => {
  const { evidence } = buildStructuralHandoff(artifact(), HANDOFF_CONTEXT);
  assert.ok("modelCost" in evidence, "the key must exist, or a null becomes an absent key on the wire");
  assert.equal(evidence.modelCost, null, "no cost recorded is not a zero-dollar run");
});

test("the handoff carries an unpriced lane by name, and never folds it in as a zero lane", () => {
  const cost = {
    lanes: [{ label: "triage and mutation extensions", dollars: 0.0123 }],
    dollars: 0.0123,
    unpriced: { label: "generation arm", reason: "ABLOH_MODEL_RATE_CARD is not set" },
  };
  const { evidence } = buildStructuralHandoff(artifact({ modelCost: cost }), HANDOFF_CONTEXT);
  assert.deepEqual(evidence.modelCost.unpriced, cost.unpriced);
  assert.equal(evidence.modelCost.lanes.length, 1);
  assert.equal(evidence.modelCost.dollars, 0.0123, "the priced lane's figure is a floor, and is still stated");
});

test("the handoff does not re-add the lanes: a disagreeing total is forwarded, not corrected", () => {
  /* The producer is the only summer. This door's job is to carry the answer; the ingest door is
     where a disagreement becomes a refusal. Silently substituting a total here would put a figure
     on the record that no surface ever printed. */
  const broken = { lanes: COST.lanes, dollars: 0.5693, unpriced: null };
  const { evidence } = buildStructuralHandoff(artifact({ modelCost: broken }), HANDOFF_CONTEXT);
  assert.equal(evidence.modelCost.dollars, 0.5693);
});

test("a newline in the unpriced reason cannot destroy the upload it describes", () => {
  const cost = {
    lanes: [],
    dollars: 0,
    unpriced: { label: "generation arm", reason: "no rate card\nat /home/runner/work/x" },
  };
  const { evidence } = buildStructuralHandoff(artifact({ modelCost: cost }), HANDOFF_CONTEXT);
  assert.equal(evidence.modelCost.unpriced.reason, "no rate card");
});

test("an unknown key inside the cost block never reaches the wire", () => {
  const cost = { ...COST, secretThing: 1, lanes: [{ ...COST.lanes[0], promptText: "leak" }] };
  const serialized = JSON.stringify(buildStructuralHandoff(artifact({ modelCost: cost }), HANDOFF_CONTEXT));
  assert.ok(!serialized.includes("secretThing"));
  assert.ok(!serialized.includes("promptText"));
});

// ---------------------------------------------------------------------------
// prepare-upload.mjs — the self-vouched body
// ---------------------------------------------------------------------------

test("the structural upload packs the cost block", () => {
  const { results } = buildStructuralUpload(artifact({ modelCost: COST }), PROVENANCE);
  assert.deepEqual(results.modelCost, COST);
});

test("an artifact with no cost block uploads exactly as it always has", () => {
  const { results } = buildStructuralUpload(artifact(), PROVENANCE);
  assert.equal("modelCost" in results, false, "an older CLI's upload gains nothing, not even a null");
});

test("the structural upload refuses a total that disagrees with its own lanes", () => {
  assert.throws(
    () =>
      buildStructuralUpload(
        artifact({ modelCost: { lanes: COST.lanes, dollars: 0.5693, unpriced: null } }),
        PROVENANCE,
      ),
    /modelCost\.dollars must equal the sum/u,
  );
});

test("the structural upload refuses a malformed cost block rather than dropping it", () => {
  for (const broken of [
    { lanes: "0.74", dollars: 0.74, unpriced: null },
    { lanes: [{ label: "a", dollars: -1 }], dollars: -1, unpriced: null },
    { lanes: [], dollars: 0, unpriced: { label: "arm" } },
    { lanes: [{ label: "a\nb", dollars: 0 }], dollars: 0, unpriced: null },
  ]) {
    assert.throws(() => buildStructuralUpload(artifact({ modelCost: broken }), PROVENANCE));
  }
});
