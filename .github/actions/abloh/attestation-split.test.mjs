/**
 * THE IDENTITY SPLIT, HELD TO THE ONE PROPERTY IT EXISTS TO BUY.
 *
 * WHAT THE SPLIT IS (Kenneth's ruling of 2026-08-29, from the peer implementation review). On the
 * borrow road abloh's step is the last step of the customer's own test job. `id-token: write` is
 * scoped by GitHub to a whole JOB and exposed to every step in it, so granting it for abloh's step
 * granted it equally to the checkout, the install, every third-party action and every script a pull
 * request can change - all of which run BEFORE abloh. Any of them could mint abloh's audience-bound
 * identity and file a green setup trial abloh never measured, and no claim GitHub publishes would
 * let the service tell that report from a real one.
 *
 * SO THE JOB HOLDS NOTHING AND A SECOND JOB HOLDS THE IDENTITY. Every test below is about one of the
 * two halves of that sentence:
 *
 *   THE MEASURING HALF must be unable to publish, and must leave behind exactly the documents that
 *   were already destined to leave the runner - never the raw report, which embeds the customer's
 *   own source.
 *
 *   THE ATTESTING HALF must publish what it was handed, byte for byte, to an address that the
 *   environment it inherits cannot move.
 *
 * WHAT IS NOT CLAIMED, and is asserted nowhere because it is not true: that the artifact is
 * producer-attested. Anything in the borrowed job can write a file and hand it up. The report is
 * attested to the REPOSITORY, which is what the minted identity says, and no further.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  attest,
  attestationEndpoints,
  refuseAmbientEndpointOverride,
  reportSetupTrial,
  stageForAttestation,
} from "./action-boundary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOUNDARY = join(HERE, "action-boundary.mjs");
const NO_BACKOFF = [];

function temporary(label) {
  return mkdtempSync(join(tmpdir(), `abloh-split-${label}-`));
}

/**
 * A run's output directory, as the measuring step leaves it.
 *
 * THE RAW REPORT IS IN IT ON PURPOSE. It is the file that must never reach an artifact, and a
 * fixture without it would let the staging step pass this suite by doing nothing.
 */
function measuredRun(root, { trial = true, results = true } = {}) {
  const output = join(root, "runner-temp", "abloh", "1234-1");
  mkdirSync(output, { recursive: true });
  if (trial) {
    writeFileSync(
      join(output, "abloh-setup-trial.json"),
      JSON.stringify({ receipt: { stages: [] }, passed: true }),
    );
  }
  if (results) {
    writeFileSync(join(output, "attest-results.json"), JSON.stringify(RESULTS));
    writeFileSync(join(output, "attest-raw-report.json"), JSON.stringify({ source: "SECRET SOURCE" }));
  }
  return output;
}

/** The smallest artifact `buildStructuralHandoff` accepts, so the envelope is real rather than stubbed. */
const RESULTS = {
  schemaVersion: "attest-results/v2",
  target: { directory: ".", ecosystem: "javascript" },
  summary: { score: 1, verdict: "pass" },
};

function stagingEnvironment(root, output, extra = {}) {
  const githubOutput = join(root, "github-output");
  writeFileSync(githubOutput, "", { mode: 0o600 });
  return {
    GITHUB_OUTPUT: githubOutput,
    RUNNER_TEMP: join(root, "runner-temp"),
    ABLOH_OUTPUT_DIR: output,
    GITHUB_REPOSITORY: "acme/demo",
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "0".repeat(40),
    ABLOH_TRIGGER_SHA: "0".repeat(40),
    ABLOH_HEAD_SHA: "1".repeat(40),
    ...extra,
  };
}

function outputFields(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

/** A fetch that records every call and answers 200, so a test can assert what was sent and where. */
function recordingFetch(responses = []) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return responses.shift() ?? { ok: true, status: 200, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

/** The identity endpoint GitHub sets, and the token it answers with. */
function withIdentity(environment) {
  return {
    ...environment,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
  };
}

const IDENTITY_RESPONSE = {
  ok: true,
  status: 200,
  json: async () => ({ value: "aaa.bbb.ccc" }),
};

/* ------------------------------------------------------------------ the measuring half */

test("the staged artifact carries what would have been sent, and never the customer's source", async () => {
  const root = temporary("stage");
  const output = measuredRun(root);
  const environment = stagingEnvironment(root, output);

  assert.equal(await stageForAttestation(environment), 0);
  const fields = outputFields(environment.GITHUB_OUTPUT);
  assert.equal(fields.staged, "true");

  const staged = readdirSync(fields.path).sort();
  /*
   * AN ALLOWLIST STATED AS AN EQUALITY, not as a set of absences. A test that only asserted the raw
   * report is missing would pass the day a fourth file starts being copied; this one fails, which is
   * the behaviour worth having on the boundary between a private runner and an artifact anybody who
   * can read the repository can download.
   */
  assert.deepEqual(staged, ["abloh-handoff.json", "abloh-setup-trial.json"]);
  for (const name of staged) {
    assert.equal(readFileSync(join(fields.path, name), "utf8").includes("SECRET SOURCE"), false);
  }
  /* AND THE ENVELOPE IS THE REAL ONE, built by the same code the direct upload posts. */
  const envelope = JSON.parse(readFileSync(join(fields.path, "abloh-handoff.json"), "utf8"));
  assert.equal(typeof envelope, "object");
  assert.notEqual(envelope, null);
});

test("a run that measured nothing stages nothing, and says so rather than handing up an empty claim", async () => {
  const root = temporary("stage-empty");
  const output = measuredRun(root, { trial: false, results: false });
  const environment = stagingEnvironment(root, output);

  assert.equal(await stageForAttestation(environment), 0);
  const fields = outputFields(environment.GITHUB_OUTPUT);
  assert.equal(fields.staged, "false");
  assert.deepEqual(readdirSync(fields.path), []);
});

test("a trial-only run stages the trial and no envelope, because nothing finished measuring", async () => {
  /* Every setup pull request is this shape: the five stages run, a report is written, and no
     `attest-results.json` exists because a trial measures nothing to publish. An envelope built here
     would be an envelope about a measurement that did not happen. */
  const root = temporary("stage-trial");
  const output = measuredRun(root, { results: false });
  const environment = stagingEnvironment(root, output);

  assert.equal(await stageForAttestation(environment), 0);
  const fields = outputFields(environment.GITHUB_OUTPUT);
  assert.deepEqual(readdirSync(fields.path), ["abloh-setup-trial.json"]);
});

/* ------------------------------------------------------------------ the attesting half */

test("the attestation job files the staged trial with a minted identity", async () => {
  const root = temporary("attest");
  const output = measuredRun(root, { results: false });
  const environment = stagingEnvironment(root, output);
  await stageForAttestation(environment);
  const directory = outputFields(environment.GITHUB_OUTPUT).path;

  const fetchImpl = recordingFetch([IDENTITY_RESPONSE]);
  const status = await attest(
    withIdentity({ ABLOH_ATTESTATION_DIR: directory }),
    fetchImpl,
    NO_BACKOFF,
  );
  assert.equal(status, 0);

  const [mint, post] = fetchImpl.calls;
  assert.match(mint.url, /^https:\/\/token\.actions\.githubusercontent\.com\/oidc\?audience=/u);
  assert.equal(post.url, attestationEndpoints({}).SETUP_TRIAL_URL);
  /* THE TRIAL DOOR'S OWN HEADER, and not `authorization` - that one carries the escape-hatch CI
     secret, and presenting a GitHub identity there would ask the weaker check a question the
     stronger one answers. */
  assert.equal(post.init.headers["x-abloh-oidc"], "aaa.bbb.ccc");
  assert.equal(post.init.headers.authorization, undefined);
});

test("the envelope is posted byte for byte as the measuring job serialized it", async () => {
  /* The control plane deduplicates a re-post on the body digest, and the producer committed to those
     exact bytes when it built them. Re-serializing here would produce a body nobody signed. */
  const root = temporary("attest-envelope");
  const output = measuredRun(root, { trial: false });
  const environment = stagingEnvironment(root, output);
  await stageForAttestation(environment);
  const directory = outputFields(environment.GITHUB_OUTPUT).path;
  const staged = readFileSync(join(directory, "abloh-handoff.json"), "utf8");

  const fetchImpl = recordingFetch([IDENTITY_RESPONSE]);
  await attest(withIdentity({ ABLOH_ATTESTATION_DIR: directory }), fetchImpl, NO_BACKOFF);

  const post = fetchImpl.calls[1];
  assert.equal(post.url, attestationEndpoints({}).HANDOFF_URL);
  assert.equal(post.init.body, staged);
  assert.equal(post.init.headers.authorization, "Bearer aaa.bbb.ccc");
});

test("an attestation job with nothing to file mints nothing and touches no network", async () => {
  /*
   * THE JOB RUNS ON `!cancelled()`, so it runs after a test job that failed before abloh's step ever
   * started - and there is nothing to file then. A refusal here would put a second red job on a
   * pull request whose build already failed, over an absence that is the ordinary consequence of it.
   */
  const root = temporary("attest-nothing");
  const fetchImpl = recordingFetch();
  const status = await attest(
    withIdentity({ ABLOH_ATTESTATION_DIR: join(root, "never-downloaded") }),
    fetchImpl,
    NO_BACKOFF,
  );
  assert.equal(status, 0);
  assert.deepEqual(fetchImpl.calls, []);

  /* AND THE SHAPE THAT ACTUALLY HAPPENS: `actions/download-artifact` resolves its `path` before it
     knows whether anything matched, so the directory usually EXISTS and is empty. A check that only
     handled the missing directory would mint an identity on every such run. */
  const empty = join(root, "downloaded-nothing");
  mkdirSync(empty, { recursive: true });
  const second = recordingFetch();
  assert.equal(await attest(withIdentity({ ABLOH_ATTESTATION_DIR: empty }), second, NO_BACKOFF), 0);
  assert.deepEqual(second.calls, []);
});

/* ------------------------------------------------------------------ the ambient boundary */

test("the attestation job refuses an endpoint the environment tried to move", async () => {
  /*
   * THE ATTACK THIS CLOSES. A workflow-level `env:` block is inherited by every job in the file,
   * including the one abloh added, and it sits far from the job it affects. A single line there could
   * point abloh's control-plane resolution at another host and receive a freshly minted GitHub
   * identity for the repository. The check runs BEFORE anything is minted, so no live credential has
   * been sent by the time it fires.
   */
  for (const name of [
    "ABLOH_DEV_SETUP_TRIAL_URL",
    "ABLOH_DEV_HANDOFF_URL",
    "ABLOH_DEV_MODEL_GATEWAY_URL",
    "SETUP_TRIAL_URL",
    "HANDOFF_AUDIENCE",
  ]) {
    assert.throws(
      () => refuseAmbientEndpointOverride({ [name]: "https://attacker.example/collect" }),
      (error) => {
        assert.match(error.message, new RegExp(`${name} was set in this job's environment`, "u"));
        assert.match(error.message, /workflow-level `env:` block reaches every job/u);
        assert.match(error.message, /pass `control-plane:` to the attestation step/u);
        return true;
      },
      `${name} was not refused`,
    );
  }
  /* AND IT REFUSES BEFORE THE MINT, which is the property a check after the fact would not have. */
  const fetchImpl = recordingFetch([IDENTITY_RESPONSE]);
  await assert.rejects(
    attest(
      withIdentity({ ABLOH_ATTESTATION_DIR: "/nonexistent", ABLOH_DEV_HANDOFF_URL: "https://attacker.example" }),
      fetchImpl,
      NO_BACKOFF,
    ),
  );
  assert.deepEqual(fetchImpl.calls, []);
});

test("the endpoints come from constants, and the one override is an input on the job", () => {
  const shipped = attestationEndpoints({});
  assert.equal(shipped.HANDOFF_URL, "https://api.abloh.dev/api/v1/runs");
  assert.equal(shipped.SETUP_TRIAL_URL, "https://api.abloh.dev/api/v1/setup/trial");
  assert.equal(shipped.HANDOFF_AUDIENCE, "abloh-evidence-handoff");

  /* Our own development tier runs against a tunnel, and it says so on the step - which is the same
     fact a reviewer would see if anybody ever tried to say it on somebody else's behalf. */
  const dev = attestationEndpoints({ ABLOH_CONTROL_PLANE: "https://tunnel.abloh.dev/" });
  assert.equal(dev.HANDOFF_URL, "https://tunnel.abloh.dev/api/v1/runs");
  assert.equal(dev.SETUP_TRIAL_URL, "https://tunnel.abloh.dev/api/v1/setup/trial");
});

/* ------------------------------------------------------------------ the whole seam, end to end */

test("E2E: a forged report from a customer step position cannot publish, and the green one does", async () => {
  /*
   * THE TWO HALVES OF THE DEFECT, RUN THROUGH THE REAL ENTRY POINT.
   *
   * A step in the borrowed job - the checkout, the install, a third-party action, a script a pull
   * request can change - writes a self-consistent green trial report and tries to file it. Under the
   * landed design it could: the job held `id-token: write`, so the mint endpoint was in its
   * environment and the control plane would have seen a valid repository identity. Under the split
   * the job holds nothing, so there is no identity to mint and nothing is sent.
   *
   * THE SAME BYTES FILE FINE FROM THE ATTESTATION JOB, which is what makes this a boundary rather
   * than a breakage: the difference between the two halves is the job, and nothing else.
   */
  const root = temporary("e2e");
  const output = join(root, "runner-temp", "abloh", "1234-1");
  mkdirSync(output, { recursive: true });
  const forged = JSON.stringify({ receipt: { stages: [] }, passed: true, forged: true });
  writeFileSync(join(output, "abloh-setup-trial.json"), forged);

  /* THE CUSTOMER STEP POSITION: a job with no `id-token: write`, which is what the setup pull
     request now writes. GitHub sets neither variable there. */
  const fromTheirJob = recordingFetch();
  const status = await reportSetupTrial(
    {
      GITHUB_ACTIONS: "true",
      ABLOH_OUTPUT_DIR: output,
      SETUP_TRIAL_URL: "https://api.abloh.example/api/v1/setup/trial",
      SETUP_TRIAL_AUDIENCE: "abloh-evidence-handoff",
    },
    fromTheirJob,
    NO_BACKOFF,
  );
  assert.equal(status, 0, "a job with no identity must not fail the customer's build over it");
  assert.deepEqual(fromTheirJob.calls, [], "a step in the borrowed job reached the control plane");

  /* AND THE SAME REPORT, FROM THE ATTESTATION JOB, IS FILED. */
  const environment = stagingEnvironment(root, output);
  await stageForAttestation(environment);
  const directory = outputFields(environment.GITHUB_OUTPUT).path;
  const fromAblohsJob = recordingFetch([IDENTITY_RESPONSE]);
  await attest(
    withIdentity({ GITHUB_ACTIONS: "true", ABLOH_ATTESTATION_DIR: directory }),
    fromAblohsJob,
    NO_BACKOFF,
  );
  assert.equal(fromAblohsJob.calls.length, 2);
  assert.equal(fromAblohsJob.calls[1].init.body, forged);
});

test("E2E: the log names the concrete cause and the job the permission belongs on", () => {
  /*
   * THE REMEDY CONTRACT, AT THE ONE PLACE THAT CAN SEE WHICH JOB IS WHICH. It used to say "add
   * `id-token: write` to the job that runs the Abloh step", which is now the single edit that would
   * undo the split - a maintainer who followed it would hand an identity to every step in their test
   * job and still have no report, because the report is filed from the other job.
   *
   * AND IT NAMES ONE CAUSE, NOT A CATEGORY (Kenneth's ruling, 2026-08-30). A missing permission and
   * a fork are different facts with different owners, and the run knows which it is looking at:
   * `action.yml` hands the boundary `ABLOH_PR_FORK` from the caller's context.
   */
  const root = temporary("e2e-remedy");
  const output = join(root, "runner-temp", "abloh", "1234-1");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "abloh-setup-trial.json"), JSON.stringify({ passed: true }));

  const run = (extra) =>
    spawnSync(process.execPath, [BOUNDARY, "report-setup-trial"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_ACTIONS: "true",
        ABLOH_OUTPUT_DIR: output,
        SETUP_TRIAL_URL: "https://api.abloh.example/api/v1/setup/trial",
        SETUP_TRIAL_AUDIENCE: "abloh-evidence-handoff",
        ...extra,
      },
    });

  const missing = run({ ABLOH_PR_FORK: "false" });
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /\[identity-permission-missing\]/u);
  assert.match(missing.stdout, /the abloh-attest job has no id-token: write/u);
  assert.match(missing.stdout, /rather than on the one that runs your tests/u);
  /* AND IT DOES NOT DRAG IN THE FORK RULE, which is a different cause with a different owner. */
  assert.equal(/comes from a fork/u.test(missing.stdout), false);

  const fork = run({ ABLOH_PR_FORK: "true" });
  assert.equal(fork.status, 0);
  assert.match(fork.stdout, /\[identity-fork-policy\]/u);
  assert.match(fork.stdout, /GitHub's rule rather than a setting in your repository/u);
  /* AND IT ASKS FOR NO EDIT. The fork case is the one where the edit provably cannot work. */
  assert.equal(/belongs on the abloh-attest job/u.test(fork.stdout), false);
});

test("one artifact name, spelled the same in all three places that have to agree on it", () => {
  /*
   * THREE SURFACES, ONE STRING, AND NONE OF THEM CAN IMPORT THE OTHERS. The measuring half uploads
   * it, the attesting half downloads it, and core declares it for anything that has to describe it -
   * and the Action is standalone `.mjs` that cannot import core, so the two YAML files carry the
   * literal. A name that drifted would not fail: the upload would succeed, the download would match
   * nothing, and every setup report would silently stop arriving.
   */
  const template = readFileSync(join(HERE, "..", "..", "packages", "core", "src", "setup-template.ts"), "utf8");
  const declared = /SETUP_TRIAL_ARTIFACT_NAME = "([^"]+)"/u.exec(template);
  assert.ok(declared !== null, "core no longer declares the artifact name");
  const name = declared[1];

  const action = readFileSync(join(HERE, "action.yml"), "utf8");
  assert.match(action, new RegExp(`^ {8}name: ${name}$`, "mu"));
  const attestAction = readFileSync(join(HERE, "attest", "action.yml"), "utf8");
  assert.match(attestAction, new RegExp(`^ {8}pattern: ${name}$`, "mu"));
  /*
   * AND THE DOWNLOAD USES `pattern:` RATHER THAN `name:`. With `name:` the action throws
   * `Artifact '<name>' not found`, and the artifact is legitimately absent whenever the test job
   * failed before abloh's step ran - which is the case this job runs on `!cancelled()` to cover.
   * Verified against actions/download-artifact v8.0.1 `src/download-artifact.ts`, where only the
   * `name` and `artifact-ids` branches throw and the pattern branch filters a listing.
   */
  assert.equal(/^ {8}name:/mu.test(attestAction), false, "the attestation job would fail on an absent artifact");
});

test("E2E: the workflow the setup PR writes has the identity on abloh's job and nowhere else", () => {
  /*
   * THE TWO SIDES OF THE SPLIT MEET IN ONE FILE, and this is the only test that reads it as a
   * workflow rather than as two modules. The CLI writes the edit, the Action declares the input the
   * edit names, and the boundary is the job that holds the grant. A change to any one of the three
   * that the other two did not follow shows up here.
   */
  const cli = join(HERE, "..", "cli", "src", "setup-step.ts");
  assert.ok(existsSync(cli));
  const rendered = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { placeSetupStep } from ${JSON.stringify(cli)};
       const before = ["name: CI", "on: [pull_request]", "jobs:", "  unit:",
         "    runs-on: ubuntu-latest", "    steps:", "      - run: npm ci", "      - run: npm test", ""].join("\\n");
       const placed = placeSetupStep({ file: ".github/workflows/ci.yml", jobId: "unit", before });
       process.stdout.write(placed.after);`,
    ],
    { encoding: "utf8", cwd: join(HERE, "..", "cli") },
  );

  /* THE MEASURING JOB DECLARES NO PERMISSIONS AT ALL. */
  const unit = rendered.slice(rendered.indexOf("  unit:"), rendered.indexOf("  abloh-attest:"));
  assert.equal(/permissions:/u.test(unit), false, "abloh wrote a permission onto the customer's job");
  assert.match(unit, /publish: attestation-job/u);

  /* AND ABLOH'S JOB DECLARES EXACTLY THE ONE. */
  const attestJob = rendered.slice(rendered.indexOf("  abloh-attest:"));
  assert.match(attestJob, /^ {4}permissions:\n {6}id-token: write$/mu);
  assert.match(attestJob, /uses: Vero-Technology\/abloh-action\/attest@[0-9a-f]{40}$/mu);
  assert.match(attestJob, /if: \$\{\{ !cancelled\(\) \}\}/u);

  /* AND THE INPUT THE STEP SETS IS ONE THE ACTION DECLARES. Two halves of one contract, and a
     `with:` key the Action does not know is a key GitHub warns about and then ignores. */
  const action = readFileSync(join(HERE, "action.yml"), "utf8");
  assert.match(action, /^ {2}publish:$/mu);
  assert.match(action, /inputs\.publish == 'attestation-job'/u);
  assert.match(action, /inputs\.publish != 'attestation-job'/u);
});
