import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadEvidence } from "./action-boundary.mjs";

/*
 * The composite Action's evidence upload.
 *
 * This is the step that makes a customer install work at all: the Action used to refuse to upload,
 * so a PR sat on "Waiting for CI evidence" forever. What makes it safe is that it holds no shared
 * secret — a GitHub OIDC identity is minted after measurement, used once, and passed to nothing.
 */

const SHA = "b".repeat(40);

function fixture(results) {
  const root = mkdtempSync(join(tmpdir(), "abloh-upload-"));
  const output = join(root, "out");
  mkdirSync(output);
  writeFileSync(join(output, "attest-results.json"), JSON.stringify(results));
  return { root, output };
}

const evidence = (tier = 1) => ({
  schema: "attest-results/v2",
  engine: { name: "stryker", version: "8.0.0" },
  target: { baseSha: "a".repeat(40), sha: SHA, runner: "vitest" },
  tier,
  mutantsPlanned: 0,
  mutantsRun: 0,
  findings: [],
});

function environmentFor(output) {
  return {
    ABLOH_OUTPUT_DIR: output,
    HANDOFF_URL: "https://api.abloh.example/api/v1/orgs/acme/runs",
    HANDOFF_AUDIENCE: "https://api.abloh.example/handoff",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.example/mint",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    GITHUB_REPOSITORY: "acme/service",
    GITHUB_WORKFLOW_REF: "acme/service/.github/workflows/ci.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: "c".repeat(40),
    GITHUB_RUN_ID: "777",
    GITHUB_RUN_ATTEMPT: "1",
    ABLOH_TRIGGER_SHA: "d".repeat(40),
    ABLOH_HEAD_SHA: SHA,
    ABLOH_PULL_REQUEST: "42",
  };
}

/** A fetch double: first call mints the identity, second is the upload. */
function fetchDouble({ mintOk = true, uploadStatus = 201 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return mintOk
        ? { ok: true, json: async () => ({ value: "header.payload.signature" }) }
        : { ok: false, json: async () => ({}) };
    }
    return { ok: uploadStatus < 400, status: uploadStatus, json: async () => ({}) };
  };
  return { impl, calls };
}

test("the upload mints an identity, then posts the envelope with it", async () => {
  const { output } = fixture(evidence());
  const { impl, calls } = fetchDouble();
  assert.equal(await uploadEvidence(environmentFor(output), impl), 0);
  assert.equal(calls.length, 2, "one mint, one post");

  /* The mint asks GitHub for the configured audience — nothing else is sent. */
  assert.match(calls[0].url, /audience=https%3A%2F%2Fapi\.abloh\.example%2Fhandoff/u);
  assert.equal(calls[0].init.headers.authorization, "Bearer request-token");

  /* The upload carries the minted identity, not any shared secret. */
  const post = calls[1];
  assert.equal(post.url, "https://api.abloh.example/api/v1/orgs/acme/runs");
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.headers.authorization, "Bearer header.payload.signature");

  const envelope = JSON.parse(post.init.body);
  assert.equal(envelope.schema, "abloh-ci-handoff/v2");
  assert.equal(envelope.provenance.headSha, SHA);
  assert.equal(envelope.provenance.repository, "acme/service");
});

test("the artifact digest is computed from the bytes actually sent", async () => {
  /*
   * contextFromEnvironment reads the digest from ABLOH_LOCAL_ARTIFACT_DIGEST, which the reusable
   * workflow sets from a shell sha256sum. This step has no such shell local, and an absent value
   * becomes "" — which the control plane refuses. So it is computed here, and this asserts it matches
   * the file rather than being some other run's digest.
   */
  const results = evidence();
  const { output } = fixture(results);
  const { impl, calls } = fetchDouble();
  await uploadEvidence(environmentFor(output), impl);
  const envelope = JSON.parse(calls[1].init.body);
  const expected = createHash("sha256").update(JSON.stringify(results)).digest("hex");
  assert.equal(envelope.artifactDigest, `sha256:${expected}`);
});

test("tier-2 sidecars are picked up beside the artifact; tier 1 sends none", async () => {
  const rationales = JSON.stringify({ schema: "attest-rationales/v1", rationales: { m: "why" } });

  const two = fixture(evidence(2));
  writeFileSync(join(two.output, "attest-rationales.json"), rationales);
  const first = fetchDouble();
  await uploadEvidence(environmentFor(two.output), first.impl);
  const withSidecars = JSON.parse(first.calls[1].init.body);
  assert.equal(withSidecars.sidecars.rationales, rationales, "bytes forwarded verbatim");

  const one = fixture(evidence(1));
  writeFileSync(join(one.output, "attest-rationales.json"), rationales);
  const second = fetchDouble();
  await uploadEvidence(environmentFor(one.output), second.impl);
  const below = JSON.parse(second.calls[1].init.body);
  assert.ok(!Object.hasOwn(below, "sidecars"), "tier 1 must not send them even when present on disk");
});

test("the v2 proofs file is picked up by its own name, at a tier that sends no v1 sidecar", async () => {
  /*
   * THE FILENAME IS THE WHOLE BUG. The uploader read four fixed `attest-` names; a v2 run writes
   * `abloh-engine-v2-proofs.json`, so every test the v2 engine proved stayed on the runner and no
   * proposal could ever reach a customer's tooling. Asserted at tier 1 deliberately: the v2 arm is
   * tierless, and the line above shows tier 1 sending no v1 sidecar at all.
   */
  const proofs = JSON.stringify({ schema: "abloh-engine-v2-proofs/v1", candidates: [], exitProofs: [] });
  const { output } = fixture({
    ...evidence(1),
    engineV2: { schema: "abloh-engine-v2/v1", state: "completed", proofsDigest: "f".repeat(64) },
  });
  writeFileSync(join(output, "abloh-engine-v2-proofs.json"), proofs);
  const { impl, calls } = fetchDouble();
  await uploadEvidence(environmentFor(output), impl);
  const envelope = JSON.parse(calls[1].init.body);
  assert.equal(envelope.sidecars.engineV2Proofs, proofs, "bytes forwarded verbatim");
  assert.equal(envelope.evidence.engineV2.proofsDigest, "f".repeat(64), "and the commitment with them");
});

test("a refused upload fails the step and does not echo the remote body", async () => {
  /* The status is disclosed; the body is not. A remote string in a public build log is how a
     service's internals end up somewhere the customer can read them. */
  const { output } = fixture(evidence());
  const { impl } = fetchDouble({ uploadStatus: 403 });
  await assert.rejects(() => uploadEvidence(environmentFor(output), impl), /HTTP 403/u);
});

test("a failed mint fails the step before anything is posted", async () => {
  const { output } = fixture(evidence());
  const { impl, calls } = fetchDouble({ mintOk: false });
  await assert.rejects(() => uploadEvidence(environmentFor(output), impl), /could not mint/u);
  assert.equal(calls.length, 1, "nothing is posted without an identity");
});

test("a missing handoff URL or audience is refused, not silently skipped", async () => {
  const { output } = fixture(evidence());
  const { impl } = fetchDouble();
  const base = environmentFor(output);
  await assert.rejects(() => uploadEvidence({ ...base, HANDOFF_URL: "" }, impl), /handoff-url/u);
  await assert.rejects(() => uploadEvidence({ ...base, HANDOFF_AUDIENCE: "" }, impl), /handoff-audience/u);
  /* And a non-HTTPS or credential-bearing URL never gets a token minted for it. */
  await assert.rejects(
    () => uploadEvidence({ ...base, HANDOFF_URL: "http://api.abloh.example/x" }, impl),
    /handoff-url/u,
  );
});

/** Capture what the step printed, so a claim about what a customer is told is checked, not believed. */
/**
 * What the step PRINTED, captured without swallowing it.
 *
 * THE CHUNKS ARE FORWARDED, and that is not a nicety. `node --test` runs this file in a child
 * process and the child reports every test result to the parent over its own stdout. A capture
 * that returned `true` without forwarding ate those reports: five tests in this file - including
 * both plan-limit ones - ran to completion, asserted correctly, and were never counted. The run
 * said `pass 11` over sixteen tests and exited 0, so the suite was green about work it had not
 * checked. Measured 2026-08-28 with `--test-reporter=tap`: `ok` lines 11 through 15 never arrived.
 *
 * Forwarding puts the Action's own log lines in the test output beside the results, which they
 * already were, and every assertion here reads the captured copy rather than the stream.
 */
async function printedBy(run) {
  const original = process.stdout.write.bind(process.stdout);
  const lines = [];
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return original(chunk, ...rest);
  };
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return lines.join("");
}

test("a sidecar too large to forward is NAMED, not silently dropped", async () => {
  /*
   * THE SILENT DROP. `readOptionalFile` returns undefined for a file that is absent AND for one past
   * the 16 MiB bound, and the caller cannot tell those apart. A v2 run big enough to exceed it -
   * the loop's sidecar carries every candidate of every round with its body, plus the triage records
   * and the ledger, and nothing caps it producer-side - therefore uploaded an envelope with no v2
   * evidence in it. The control plane then saw no sidecar rather than a refused one, so
   * `acceptEngineV2Proofs` returned no proofs AND no refusal: the customer's proven tests vanished
   * with no line in the job log, nothing in the egress audit, and nothing on the run page.
   *
   * The measurement itself is still valid, so this is a NAMED omission rather than a failed step -
   * the same shape as the plan-limit case above.
   */
  const { output } = fixture({
    ...evidence(1),
    engineV2: { schema: "abloh-engine-v2/v1", state: "completed", proofsDigest: "f".repeat(64) },
  });
  const oversize = `{"schema":"abloh-engine-v2-proofs/v1","pad":"${"x".repeat(17 * 1024 * 1024)}"}`;
  writeFileSync(join(output, "abloh-engine-v2-proofs.json"), oversize);
  const { impl, calls } = fetchDouble();
  const printed = await printedBy(() => uploadEvidence(environmentFor(output), impl));

  const envelope = JSON.parse(calls[1].init.body);
  assert.ok(
    envelope.sidecars === undefined || envelope.sidecars.engineV2Proofs === undefined,
    "the oversize bytes are still not forwarded",
  );
  assert.match(printed, /abloh-engine-v2-proofs\.json/u, "the file is named");
  assert.match(printed, /16 MiB/u, "and the bound it passed");
  assert.match(printed, /rerun|re-run|smaller|narrow/iu, "and what the customer can do about it");
});

test("an absent sidecar stays silent — an omission is only worth naming when bytes existed", async () => {
  /* The counterpart the rule above must not break: most runs write no v2 sidecar at all, and a line
     about every file a run did not produce is noise that trains a reader to skip the log. */
  const { output } = fixture(evidence(1));
  const { impl } = fetchDouble();
  const printed = await printedBy(() => uploadEvidence(environmentFor(output), impl));
  assert.doesNotMatch(printed, /abloh-engine-v2-proofs\.json/u);
});

/*
 * A fetch double whose upload leg answers from a SCRIPT: one entry per attempt, so a test can say
 * "fail, fail, then take it" and assert the run survived. `null` means the connection itself died.
 */
/**
 * A scripted control plane.
 *
 * A step is a status, `null` for a dropped connection, or `[status, body]` when the test cares
 * about what the answer SAID - which the 402 path does, because that body is printed for the
 * customer and reading the wrong key out of it is how a plan sentence became a false one.
 */
function scriptedUpload(script) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return { ok: true, json: async () => ({ value: "header.payload.signature" }) };
    const step = calls.length - 2;
    const answer = step < script.length ? script[step] : script.at(-1);
    if (answer === null) throw new Error("socket hang up");
    const [status, body] = Array.isArray(answer) ? answer : [answer, {}];
    return { ok: status < 400, status, json: async () => body };
  };
  return { impl, calls };
}

test("a transient upload failure is retried, and the paid-for measurement still lands", async () => {
  /*
   * WHAT THIS REPLACED. One dropped connection after a full measurement - baseline, coverage and
   * mutation - lost the whole run on `the evidence upload could not reach
   * the control plane`. The evidence lives on a runner that is about to disappear, so nothing
   * about it was recoverable, and nothing about the measurement was wrong.
   */
  const { output } = fixture(evidence());
  const { impl, calls } = scriptedUpload([null, 503, 201]);
  assert.equal(await uploadEvidence(environmentFor(output), impl, [0, 0]), 0);
  assert.equal(calls.length, 4, "one mint, then three posts, the last of which landed");

  /* BYTE-IDENTICAL on every attempt. The control plane deduplicates a re-post on body digest, so
     a request that landed and lost its response must not arrive as a second, different run. */
  const bodies = new Set(calls.slice(1).map((call) => call.init.body));
  assert.equal(bodies.size, 1, "every attempt sends the same bytes, or dedup cannot hold");
});

test("a retry that never lands still fails, and says so once the bound is spent", async () => {
  const { output } = fixture(evidence());
  const { impl, calls } = scriptedUpload([null, null, null]);
  await assert.rejects(
    () => uploadEvidence(environmentFor(output), impl, [0, 0]),
    /could not reach the control plane/u,
  );
  assert.equal(calls.length, 4, "one mint and exactly three posts - the bound is a bound");
});

test("a decision the control plane MADE is never retried", async () => {
  /* 403 is an answer about this envelope, and asking again cannot change it. Retrying a refusal
     would turn one clear failure into three and delay the job for nothing. */
  const { output } = fixture(evidence());
  const { impl, calls } = scriptedUpload([403]);
  await assert.rejects(() => uploadEvidence(environmentFor(output), impl, [0, 0]), /HTTP 403/u);
  assert.equal(calls.length, 2, "one mint, one post, no retry");
});

test("a plan-limit answer stays neutral rather than being retried into a failure", async () => {
  const { output } = fixture(evidence());
  const { impl, calls } = scriptedUpload([402]);
  const printed = await printedBy(() => uploadEvidence(environmentFor(output), impl, [0, 0]));
  assert.equal(calls.length, 2, "402 is an answer, not a transient failure");
  assert.match(printed, /evidence not uploaded/u);
});

test("the 402 prints the sentence the control plane sent, not the one this file guessed", async () => {
  /*
   * THE DEFECT THIS TEST EXISTS FOR. The refusal body is `{ error: { code, message } }` and this
   * boundary read `body.message`, so the read missed on every real 402 and the fallback spoke
   * instead: "this repository is beyond what your plan covers". On the pull-request check ceiling
   * that is FALSE - the repository is covered, the pull request has been pushed to enough times -
   * and the sentence that says what to do next never reached the log.
   *
   * The test above could not see it: an empty mocked body reaches the fallback either way, and
   * asserting only "evidence not uploaded" agrees with the bug. `refusal-envelope-contract.test.ts`
   * pins the reader against the envelope this service really builds.
   */
  const { output } = fixture(evidence());
  const message =
    "This pull request has been checked 10 times, which is the most abloh checks one pull request " +
    "in a row, and only the upload was declined. Open a new pull request and it will be checked normally.";
  const { impl } = scriptedUpload([[402, { error: { code: "PULL_REQUEST_CHECK_CEILING", message } }]]);
  const printed = await printedBy(() => uploadEvidence(environmentFor(output), impl, [0, 0]));
  assert.match(printed, /Open a new pull request/u, "the answer's own words");
  assert.doesNotMatch(printed, /beyond what your plan covers/u, "the fallback is not the truth here");
});

test("a 402 with nothing readable in it still says something true", async () => {
  /* The fallback stays, and stays honest: a plan outcome with no sentence is still a plan outcome,
     and the job log must not go silent about why nothing was uploaded. */
  const { output } = fixture(evidence());
  const { impl } = scriptedUpload([[402, {}]]);
  const printed = await printedBy(() => uploadEvidence(environmentFor(output), impl, [0, 0]));
  assert.match(printed, /beyond what your plan covers/u);
});

test("a retried attempt is announced, so a slow upload is not a silent stall", async () => {
  const { output } = fixture(evidence());
  const { impl } = scriptedUpload([429, 201]);
  const printed = await printedBy(() => uploadEvidence(environmentFor(output), impl, [0, 0]));
  assert.match(printed, /retrying/u);
  assert.match(printed, /HTTP 429/u, "with what actually happened");
});
