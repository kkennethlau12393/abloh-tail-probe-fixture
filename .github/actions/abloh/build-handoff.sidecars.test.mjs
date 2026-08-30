import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStructuralHandoff } from "./build-handoff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(HERE, "build-handoff.mjs");

/** The runner's own validator, lifted out of the template the same way the differential test does. */

/** Run it exactly as the step does: payload on disk, path in the environment. */
function runValidator(validatorPath, dir, envelope) {
  const payloadPath = join(dir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify(envelope));
  try {
    execFileSync(process.execPath, [validatorPath], {
      encoding: "utf8",
      env: { ...process.env, ABLOH_STRUCTURAL_PAYLOAD: payloadPath },
    });
    return null;
  } catch (error) {
    return String(error.stdout ?? "") + String(error.stderr ?? "") || "rejected";
  }
}

/*
 * The tier-2 sidecars in the envelope.
 *
 * Two files that used to stay on the runner now travel at tier 2: the model's triage rationale and the
 * generated tests the fix loop proved. The properties worth pinning are that they appear ONLY at tier
 * 2, that their bytes are forwarded unchanged so the receiver's digest check can succeed, and that a
 * run without them produces an envelope byte-identical to before they existed.
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

/* Evidence in the shape the CURRENT producer emits — the same fixture the differential test
   validates against, so a rejection here means the sidecars, not a thin fixture. */
const v2Evidence = (tier = 1) => ({
  schema: "attest-results/v2",
  engine: { name: "stryker", version: "8.0.0" },
  target: { baseSha: BASE_SHA, sha: SHA, runner: "vitest" },
  scope: [],
  diffCoverage: null,
  rawCoverageDigest: null,
  rawCoverageFormat: null,
  mutationExecution: null,
  mutationScope: [],
  tier,
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
    threshold: 0.7, enforce: false, tier,
    floor: { minMutantsExecuted: 1, maxErrorRate: 0.1, minSamplingFraction: 0.5 },
  },
  rationalesDigest: HEX,
  rawReportDigest: HEX,
  skipBaseline: false,
});

const rationales = JSON.stringify([{ mutantId: "m", rationale: "The boundary is unchecked." }]);
const proofs = JSON.stringify([{ mutantId: "m", verdict: "proven", testBody: "test('x', () => {})" }]);

test("at tier 2 the sidecar bytes ride the envelope unchanged", () => {
  const envelope = buildStructuralHandoff(v2Evidence(2), CTX, { rationales, fixProofs: proofs });
  assert.equal(envelope.sidecars.rationales, rationales, "forwarded verbatim, so the digest verifies");
  assert.equal(envelope.sidecars.fixProofs, proofs);
  /* The receiver checks these against the digest the evidence already declared, so any re-encoding
     here — even a semantically identical one — would break verification. */
  assert.equal(
    createHash("sha256").update(envelope.sidecars.rationales, "utf8").digest("hex"),
    createHash("sha256").update(rationales, "utf8").digest("hex"),
  );
});

test("below tier 2 the key is absent even when the files are handed in", () => {
  for (const tier of [0, 1]) {
    const envelope = buildStructuralHandoff(v2Evidence(tier), CTX, { rationales, fixProofs: proofs });
    assert.ok(
      !Object.hasOwn(envelope, "sidecars"),
      `tier ${tier} must not carry sidecars even when offered`,
    );
  }
});

test("a run with no sidecars is byte-identical to one built without the argument", () => {
  /* This is what keeps the differential contract against the retired jq filter meaningful: adding the
     feature must not change the bytes of any envelope that does not use it. */
  const withoutArgument = JSON.stringify(buildStructuralHandoff(v2Evidence(2), CTX));
  for (const handedIn of [undefined, null, {}, { rationales: "" }]) {
    assert.equal(
      JSON.stringify(buildStructuralHandoff(v2Evidence(2), CTX, handedIn)),
      withoutArgument,
      "nothing to send must produce no key",
    );
  }
});

test("one sidecar present is not turned into two", () => {
  const envelope = buildStructuralHandoff(v2Evidence(2), CTX, { rationales });
  assert.deepEqual(Object.keys(envelope.sidecars), ["rationales"]);
});

/* ------------------------------------------------------------------ the v2 engine's proofs */

/*
 * The v2 arm is TIERLESS, so its two additions travel at every tier: the block that carries
 * `proofsDigest`, and the sidecar that digest commits to. Before this, a v2 run proved tests in CI
 * and none of it reached the control plane - the uploader read four v1 filenames and the envelope
 * had no key for the block at all.
 */

const engineV2Proofs = JSON.stringify({
  schema: "abloh-engine-v2-proofs/v1",
  candidates: [{ candidateId: "c1", gapId: "9".repeat(64), testBody: "test('x', () => {})" }],
  exitProofs: [{ candidateId: "c1", gapId: "9".repeat(64), verdict: "proven" }],
});

const v2Block = (extra = {}) => ({
  schema: "abloh-engine-v2/v1",
  state: "completed",
  proofsDigest: createHash("sha256").update(engineV2Proofs, "utf8").digest("hex"),
  proven: 1,
  ...extra,
});

test("the v2 proofs sidecar rides at EVERY tier, because the v2 engine has none", () => {
  for (const tier of [0, 1, 2]) {
    const envelope = buildStructuralHandoff(
      { ...v2Evidence(tier), engineV2: v2Block() },
      CTX,
      { engineV2Proofs },
    );
    assert.equal(
      envelope.sidecars.engineV2Proofs,
      engineV2Proofs,
      `tier ${tier} must forward the v2 proofs verbatim`,
    );
  }
});

test("the v2 block travels with the run, so its proofs digest is checkable", () => {
  const envelope = buildStructuralHandoff(
    { ...v2Evidence(0), engineV2: v2Block() },
    CTX,
    { engineV2Proofs },
  );
  assert.deepEqual(envelope.evidence.engineV2, v2Block());
  /* The commitment and the bytes must agree at the boundary, which is the whole point of sending
     both: the acceptor verifies one against the other and refuses a mismatch. */
  assert.equal(
    createHash("sha256").update(envelope.sidecars.engineV2Proofs, "utf8").digest("hex"),
    envelope.evidence.engineV2.proofsDigest,
  );
});

test("a v2 failure reason cannot destroy the run it describes", () => {
  /* The v2 arm's unexpected-failure path interpolates a caught error's own message into `reason`,
     and the control plane requires printable single-line ASCII there - so an error carrying a
     newline would have the whole upload refused for a diagnostic. Normalised at the boundary, the
     same way `fixLoop.reason` is. */
  const envelope = buildStructuralHandoff(
    {
      ...v2Evidence(1),
      engineV2: { schema: "abloh-engine-v2/v1", state: "unavailable", reason: "engine-v2 failed:\n  at x\n" },
    },
    CTX,
  );
  assert.equal(envelope.evidence.engineV2.reason.includes("\n"), false);
  assert.match(envelope.evidence.engineV2.reason, /engine-v2 failed/u);
});

test("a run on the v1 arm sends a null v2 block and no v2 sidecar", () => {
  const envelope = buildStructuralHandoff(v2Evidence(2), CTX, { rationales });
  assert.equal(envelope.evidence.engineV2, null);
  assert.equal(Object.hasOwn(envelope.sidecars, "engineV2Proofs"), false);
});

test("readSidecar forwards bytes verbatim and tolerates a missing file", async () => {
  /* main() reads the two paths from the environment; a run with no fix loop has no proofs file, and
     that must be silence rather than a failed upload. */
  const dir = mkdtempSync(join(tmpdir(), "abloh-sidecar-read-"));
  const evidencePath = join(dir, "attest-results.json");
  const rationalesPath = join(dir, "attest-rationales.json");
  writeFileSync(evidencePath, JSON.stringify(v2Evidence(2)));
  writeFileSync(rationalesPath, rationales);

  const built = execFileSync(process.execPath, [SOURCE_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      ABLOH_EVIDENCE_PATH: evidencePath,
      ABLOH_RATIONALES_PATH: rationalesPath,
      /* Deliberately absent on disk. */
      ABLOH_FIX_PROOFS_PATH: join(dir, "attest-fix-proofs.json"),
      GITHUB_REPOSITORY: CTX.repository,
      GITHUB_WORKFLOW_REF: CTX.workflowRef,
      GITHUB_WORKFLOW_SHA: CTX.workflowSha,
      GITHUB_RUN_ID: CTX.runId,
      GITHUB_RUN_ATTEMPT: CTX.runAttempt,
      ABLOH_TRIGGER_SHA: CTX.triggerSha,
      ABLOH_HEAD_SHA: CTX.headSha,
      ABLOH_PULL_REQUEST: CTX.pullRequest,
      ABLOH_LOCAL_ARTIFACT_DIGEST: CTX.artifactDigest,
    },
  });
  const envelope = JSON.parse(built);
  assert.equal(envelope.sidecars.rationales, rationales, "bytes must survive the round trip exactly");
  assert.ok(
    !Object.hasOwn(envelope.sidecars, "fixProofs"),
    "a missing sidecar file is silence, not a failure",
  );
});

const richFinding = () => ({
  mutantId: "src/a.ts:1:1:X",
  file: "src/a.ts",
  startLine: 1,
  endLine: 1,
  mutator: "BooleanLiteral",
  status: "survived",
  coveredBy: 1,
  originalText: "quote.expiresAt > now",
  replacement: "true",
  startColumn: 3,
  endColumn: 24,
  triage: null,
});

/* One survivor, with the counts the validator cross-checks against it: it conserves
   mutantsPlanned/mutantsRun and gives the score a denominator. */
const withFindings = (tier) => ({
  ...v2Evidence(tier),
  mutantsPlanned: 1,
  mutantsRun: 1,
  findings: [richFinding()],
  counts: { ...v2Evidence(tier).counts, survived: 1 },
  scores: { ...v2Evidence(tier).scores, rawScore: 0, denominator: 1 },
});

test("tier 2 uploads the mutated span; tier 0 and 1 strip it on the runner", () => {
  /*
   * THE ASYMMETRY THIS EXISTS TO PREVENT. The server widened its allowlist for tier 2 while the action
   * still picked the same seven structural keys, so the span was thrown away on the runner and the
   * server's willingness to keep it was unreachable. Widening one side alone fails silently, which is
   * why both directions are asserted here.
   */
  const [kept] = buildStructuralHandoff(withFindings(2), CTX).evidence.findings;
  assert.equal(kept.originalText, "quote.expiresAt > now", "tier 2 must carry the source slice");
  assert.equal(kept.replacement, "true");
  assert.equal(kept.startColumn, 3);
  assert.equal(kept.endColumn, 24);

  for (const tier of [0, 1]) {
    const [stripped] = buildStructuralHandoff(withFindings(tier), CTX).evidence.findings;
    assert.deepEqual(
      Object.keys(stripped).sort(),
      ["coveredBy", "endLine", "file", "mutantId", "mutator", "startLine", "status", "triage"],
      `tier ${tier} must upload only the structural fields`,
    );
  }
});

test("the action's tier-2 key list matches the server's", () => {
  /* Read from both sources rather than restated, so drift fails here instead of in production. */
  const action = readFileSync(SOURCE_PATH, "utf8");
  const server = readFileSync(
    join(HERE, "..", "api", "src", "draft.ts"),
    "utf8",
  );
  const names = (text, marker) => {
    const start = text.indexOf(marker);
    assert.notEqual(start, -1, `${marker} not found`);
    const body = text.slice(start, text.indexOf("]", start));
    return [...body.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]).sort();
  };
  assert.deepEqual(
    names(action, "const TIER2_FINDING_KEYS = ["),
    names(server, "const TIER2_ADDITIONAL_FINDING_FIELDS: ReadonlySet<string> = new Set(["),
    "the producer and the receiver must permit exactly the same tier-2 fields",
  );
});

/*
 * POOL 2's OWN SIDECAR, and its own commitment.
 *
 * A second file rather than a wider first one: the loop commits to `proofsDigest` before the pool has
 * run, so the pool's bodies could only reach that file by rewriting bytes already committed to. The
 * commitment for these lives on the agent-bug disclosure, and it travels inside the same block.
 */
const engineV2Pool2 = JSON.stringify({
  schema: "abloh-engine-v2-pool2-evidence/v1",
  sha: "abc",
  entries: [
    {
      bugId: "1".repeat(64),
      route: "suite-survived",
      description: "December formats throw in Arabic",
      witness: { testFile: "test/ar.test.js", testName: "w", testBody: "expect(f).not.toThrow()" },
    },
  ],
});

const pool2Digest = createHash("sha256").update(engineV2Pool2, "utf8").digest("hex");

const v2BlockWithPool = () =>
  v2Block({
    disclosure: {
      execution: { runnerId: "docker", sealed: true, executed: 3, reusedPreparation: false, matrixSkipped: 0 },
      budget: { rounds: 1, roundsRun: 1, modelCalls: 4, modelCallsUsed: 4, executionCap: 40, stoppedOnDryRound: true, stoppedOnBudget: false },
      agentBugs: {
        evidenceDigest: pool2Digest,
        promptVersion: "engine-v2-bug-pool/2",
        model: "internal",
        generatedAtSha: "abc",
        pinned: true,
        generated: 1,
        graduated: 0,
        generationRefused: 0,
        unplaceable: 0,
        witnessProven: 1,
        witnessRefused: 0,
        holdReasons: {},
        suiteKilled: 0,
        suiteSurvived: 1,
        notExecuted: 0,
        executions: 3,
        survivors: [{ bugId: "1".repeat(64), file: "src/ar.js", startLine: 41, witness: "proven" }],
      },
    },
  });

test("pool 2's evidence rides at EVERY tier, for the same reason the proofs sidecar does", () => {
  for (const tier of [0, 1, 2]) {
    const envelope = buildStructuralHandoff(
      { ...v2Evidence(tier), engineV2: v2BlockWithPool() },
      CTX,
      { engineV2Pool2 },
    );
    assert.equal(
      envelope.sidecars.engineV2Pool2,
      engineV2Pool2,
      `tier ${tier} must forward pool 2's evidence verbatim`,
    );
  }
});

test("the commitment for pool 2's evidence travels with it, inside the signed block", () => {
  const envelope = buildStructuralHandoff(
    { ...v2Evidence(0), engineV2: v2BlockWithPool() },
    CTX,
    { engineV2Pool2 },
  );
  /* Bytes and commitment must agree at the boundary: the acceptor verifies one against the other and
     refuses a mismatch, and without the digest travelling the sidecar arrives uncheckable. */
  assert.equal(
    createHash("sha256").update(envelope.sidecars.engineV2Pool2, "utf8").digest("hex"),
    envelope.evidence.engineV2.disclosure.agentBugs.evidenceDigest,
  );
  /* And the SIGNED survivor list travels with it, because that list - not the sidecar's own `route`
     field - is what decides which bugs a customer may be shown. */
  assert.deepEqual(envelope.evidence.engineV2.disclosure.agentBugs.survivors, [
    { bugId: "1".repeat(64), file: "src/ar.js", startLine: 41, witness: "proven" },
  ]);
});

test("a run whose pool did not carry sends no pool-2 key at all", () => {
  const envelope = buildStructuralHandoff(
    { ...v2Evidence(0), engineV2: v2Block() },
    CTX,
    { engineV2Proofs },
  );
  assert.equal("engineV2Pool2" in (envelope.sidecars ?? {}), false, "absence is the signal downstream reads");
});

test("the uploader reads pool 2's file from beside the artifact, under its v2 name", () => {
  /* `abloh-`, not `attest-`: the attest prefix is v1 vocabulary. The uploader read four fixed v1
     filenames once, which is how the v2 proofs file went unopened for a whole release. */
  const boundary = readFileSync(join(HERE, "action-boundary.mjs"), "utf8");
  /* The NAME is what this pins. What else `readOptionalFile` is handed - today a list it reports
     withheld sidecars on - is not this test's subject, so the match stops at the filename. */
  assert.match(boundary, /engineV2Pool2: readOptionalFile\(join\(outputDirectory, "abloh-engine-v2-pool2\.json"\)/u);
});
