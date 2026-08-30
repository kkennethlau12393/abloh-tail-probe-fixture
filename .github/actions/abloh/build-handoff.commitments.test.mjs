import assert from "node:assert/strict";
import test from "node:test";
import { buildStructuralHandoff } from "./build-handoff.mjs";

/*
 * EVERY SIDECAR'S BYTES TRAVEL WITH THE DIGEST THAT MAKES THEM CHECKABLE.
 *
 * The control plane stores an uploaded sidecar only when its bytes hash to a commitment the artifact
 * made before the upload — "no commitment, no storage", enforced in derived-sidecar.ts. That rule is the whole reason these documents count as evidence rather than
 * attachments, and it means a dropped digest is not a cosmetic omission: it silently converts a
 * verified document into a refused one, with the bytes still paid for and shipped.
 *
 * One was dropped and nothing caught it: `redactedReportDigest` was never emitted at all, while
 * `mutationRedacted` bytes were. It surfaced as `sidecar.malformed` in the stored run's egress
 * audit, with the per-mutant redacted report missing from every run ever uploaded through the
 * action.
 *
 * The per-instance fixes are one line each. This test is the general one: it pairs each forwarded
 * sidecar with the commitment that verifies it and fails if a producer ever forwards bytes the
 * receiver has no way to check. Adding a sidecar means adding a row here.
 */

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const HEX = "f".repeat(64);

const CTX = {
  repository: "acme/service",
  triggerSha: SHA,
  headSha: SHA,
  pullRequest: "42",
  workflowRef: `acme/service/.github/workflows/abloh.yml@${"c".repeat(40)}`,
  workflowSha: "c".repeat(40),
  runId: "777",
  runAttempt: "1",
  artifactDigest: `sha256:${"d".repeat(64)}`,
  policySource: "repository-file",
  policyPath: "abloh.yml",
  policyDigest: `sha256:${HEX}`,
};

/** Evidence carrying every commitment a real tier-2 run stamps. */
const evidence = () => ({
  schema: "attest-results/v2",
  engine: { name: "stryker", version: "8.0.0" },
  target: { baseSha: BASE_SHA, sha: SHA, runner: "vitest" },
  scope: [],
  diffCoverage: null,
  rawCoverageDigest: `${"1".repeat(64)}`,
  rawCoverageFormat: "istanbul-coverage-final-v1",
  redactedReportDigest: `${"2".repeat(64)}`,
  mutationExecution: null,
  mutationScope: [],
  tier: 2,
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
    threshold: 0.7, enforce: false, tier: 2,
    floor: { minMutantsExecuted: 1, maxErrorRate: 0.1, minSamplingFraction: 0.5 },
  },
  rationalesDigest: `${"3".repeat(64)}`,
  rawReportDigest: `${"4".repeat(64)}`,
  skipBaseline: false,
});

/**
 * Each forwarded sidecar, and where in the envelope its commitment must appear.
 *
 * `read` navigates the built envelope rather than naming a flat key, because two of these live inside
 * blocks that pass through closed allowlists — which is exactly where one of them was lost.
 */
const COMMITMENTS = [
  {
    sidecar: "coverage",
    commitment: "evidence.rawCoverageDigest",
    read: (envelope) => envelope.evidence.rawCoverageDigest,
    expected: "1".repeat(64),
  },
  {
    sidecar: "mutationRedacted",
    commitment: "evidence.redactedReportDigest",
    read: (envelope) => envelope.evidence.redactedReportDigest,
    expected: "2".repeat(64),
  },
  {
    sidecar: "rationales",
    commitment: "evidence.rationalesDigest",
    read: (envelope) => envelope.evidence.rationalesDigest,
    expected: "3".repeat(64),
  },
];

test("every sidecar's commitment survives into the envelope", () => {
  const envelope = buildStructuralHandoff(evidence(), CTX, {
    coverage: "{}",
    mutationRedacted: "{}",
    rationales: "[]",
  });

  for (const { sidecar, commitment, read, expected } of COMMITMENTS) {
    assert.equal(
      read(envelope),
      expected,
      `${commitment} was dropped — the control plane would refuse the ${sidecar} sidecar as ` +
        "malformed, because bytes it cannot check against a commitment are not stored",
    );
  }
});

test("a run that stamped no commitments still emits the keys as null", () => {
  /* Absent is null, never a missing key: the receiver's shape check lists these, and `undefined`
     would be dropped by JSON.stringify and read as a producer that never heard of them. */
  const bare = evidence();
  bare.rawCoverageDigest = null;
  bare.redactedReportDigest = null;
  const envelope = buildStructuralHandoff(bare, CTX);
  assert.equal(envelope.evidence.rawCoverageDigest, null);
  assert.equal(envelope.evidence.redactedReportDigest, null);
  assert.ok(Object.hasOwn(envelope.evidence, "redactedReportDigest"));
});
