import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportSetupTrial } from "./action-boundary.mjs";

/*
 * THE SETUP TRIAL'S REPORT, FILED FROM THE SETUP PULL REQUEST'S OWN JOB.
 *
 * WHAT IS BEING HELD HERE:
 *
 *   SELF-DETECTION IS THE ARTIFACT'S PRESENCE, and nothing else. A `pull_request` run refuses every
 *   measurement input of this Action by design, so there is no flag a setup pull request can pass.
 *   The CLI decides whether a run is a trial - from the merge base, in one place - and a trial is
 *   the only thing that writes `abloh-setup-trial.json`. An ordinary run must therefore reach this
 *   step, find nothing, and cost one stat call.
 *
 *   NOTHING FAILS THE JOB. A trial that walled has already failed its own step, which is what turns
 *   the setup check red; a delivery that could not happen must not add a second red for a reason the
 *   maintainer cannot act on. The report is in the run either way and the service reads finished
 *   runs.
 *
 *   THE IDENTITY GOES IN THE TRIAL DOOR'S OWN HEADER. `authorization` on that route carries the
 *   escape-hatch CI secret for repositories that never installed the App, and presenting a GitHub
 *   identity there would ask the weaker check a question the stronger one answers.
 */

function fixture(trial) {
  const root = mkdtempSync(join(tmpdir(), "abloh-setup-trial-"));
  const output = join(root, "out");
  mkdirSync(output);
  if (trial !== null) writeFileSync(join(output, "abloh-setup-trial.json"), JSON.stringify(trial));
  return output;
}

function environmentFor(output) {
  return {
    ABLOH_OUTPUT_DIR: output,
    SETUP_TRIAL_URL: "https://api.abloh.example/api/v1/setup/trial",
    SETUP_TRIAL_AUDIENCE: "abloh-evidence-handoff",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.example/mint",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  };
}

/** A fetch double: first call mints the identity, second files the report. */
function fetchDouble({ mintOk = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return mintOk
        ? { ok: true, json: async () => ({ value: "header.payload.signature" }) }
        : { ok: false, json: async () => ({}) };
    }
    return { ok: status < 400, status, json: async () => ({}) };
  };
  return { impl, calls };
}

const REPORT = { schema: "abloh/setup-trial/v1", repository: "acme/service", pullRequest: 7 };

test("an ordinary run writes no trial report, so this step does nothing at all", async () => {
  const { impl, calls } = fetchDouble();
  assert.equal(await reportSetupTrial(environmentFor(fixture(null)), impl), 0);
  assert.equal(calls.length, 0, "an ordinary measurement run reached the network");
});

test("a setup trial mints an identity and files the report in the trial door's own header", async () => {
  const { impl, calls } = fetchDouble();
  assert.equal(await reportSetupTrial(environmentFor(fixture(REPORT)), impl), 0);
  assert.equal(calls.length, 2, "one mint, one post");

  assert.match(calls[0].url, /audience=abloh-evidence-handoff/u);
  assert.equal(calls[0].init.headers.authorization, "Bearer request-token");

  assert.equal(calls[1].url, "https://api.abloh.example/api/v1/setup/trial");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers["x-abloh-oidc"], "header.payload.signature");
  assert.equal(
    calls[1].init.headers.authorization,
    undefined,
    "the GitHub identity was presented at the escape hatch's header instead of the trial door's",
  );
  /* THE BYTES ARE THE ARTIFACT'S, unchanged. The service parses this through its own door, and a
     boundary that re-serialized it would be a second producer of the one shape that contract pins. */
  assert.deepEqual(JSON.parse(calls[1].init.body), REPORT);
});

test("a control plane that refuses the report does not fail the setup job", async () => {
  const { impl, calls } = fetchDouble({ status: 403 });
  assert.equal(await reportSetupTrial(environmentFor(fixture(REPORT)), impl), 0);
  assert.equal(calls.length, 2, "a 4xx was retried");
});

test("a transient failure is retried, and a run that never lands still exits 0", async () => {
  const { impl, calls } = fetchDouble({ status: 503 });
  assert.equal(await reportSetupTrial(environmentFor(fixture(REPORT)), impl, [1, 1]), 0);
  /* One mint plus three attempts: the two backoff steps plus the final one. */
  assert.equal(calls.length, 4);
});

test("no identity to mint means the report stays in the run rather than taking the job down", async () => {
  const { impl, calls } = fetchDouble({ mintOk: false });
  assert.equal(await reportSetupTrial(environmentFor(fixture(REPORT)), impl), 0);
  assert.equal(calls.length, 1, "the post was attempted without an identity");
});

test("no configured control plane leaves the report in the run, silently and successfully", async () => {
  const { impl, calls } = fetchDouble();
  const environment = { ...environmentFor(fixture(REPORT)), SETUP_TRIAL_URL: "" };
  assert.equal(await reportSetupTrial(environment, impl), 0);
  assert.equal(calls.length, 0);
});
