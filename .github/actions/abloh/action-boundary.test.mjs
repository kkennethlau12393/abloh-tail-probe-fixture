import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertSupportedNodeVersion,
  buildPrepareArguments,
  buildRunArguments,
  DEFAULT_CLI_SPEC,
  parsePackageSpecs,
  identityConditionOf,
  modelArmOffLine,
  runAbloh,
  callerJobStatus,
  validateActionInputs,
  ensureBaseCommitReachable,
  validateArtifact,
} from "./action-boundary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOUNDARY = join(HERE, "action-boundary.mjs");
const ACTION = join(HERE, "action.yml");
const ACTUAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const ACTUAL_NODE = process.execPath;
const ACTUAL_NPM = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();

function temporary(label) {
  return mkdtempSync(join(tmpdir(), `abloh-action-${label}-`));
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function toolPath(root, { docker = true, npm = ACTUAL_NPM } = {}) {
  const bin = join(root, "tools");
  mkdirSync(bin, { recursive: true });
  symlinkSync(ACTUAL_GIT, join(bin, "git"));
  symlinkSync(ACTUAL_NODE, join(bin, "node"));
  symlinkSync(npm, join(bin, "npm"));
  if (docker) writeExecutable(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
  return bin;
}

function git(repo, ...args) {
  return execFileSync(ACTUAL_GIT, ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function repository(root, kind = "javascript") {
  const workspace = join(root, "workspace");
  const repo = join(workspace, "repo with space");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Abloh Test");
  git(repo, "config", "user.email", "test@abloh.invalid");
  if (kind === "python") {
    writeFileSync(join(repo, "pyproject.toml"), "[project]\nname='demo'\nversion='0.0.0'\n");
  } else {
    writeFileSync(join(repo, "package.json"), '{"name":"demo","scripts":{"test":"node --test"}}\n');
  }
  writeFileSync(join(repo, "subject.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "subject.txt"), "head\n");
  git(repo, "add", "subject.txt");
  git(repo, "commit", "-qm", "head");
  const head = git(repo, "rev-parse", "HEAD");
  return { workspace, repo, base, head };
}

function preflightEnvironment(root, fixture, extra = {}) {
  const output = join(root, "github-output");
  writeFileSync(output, "", { mode: 0o600 });
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp);
  return {
    ...process.env,
    PATH: toolPath(root),
    GITHUB_ACTION_PATH: HERE,
    GITHUB_OUTPUT: output,
    GITHUB_WORKSPACE: fixture.workspace,
    RUNNER_TEMP: runnerTemp,
    REPO_PATH: "repo with space",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_SHA_VALUE: fixture.head,
    PR_HEAD_SHA: fixture.head,
    PR_BASE_SHA: fixture.base,
    DECLARED_BASE: fixture.base,
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
    MODEL_GATEWAY_URL: "https://api.abloh.example/api/v1/model/chat/completions",
    MODEL_GATEWAY_AUDIENCE: "https://api.abloh.example/model",
    ...extra,
  };
}

function execute(command, environment) {
  return spawnSync(process.execPath, [BOUNDARY, command], {
    encoding: "utf8",
    env: environment,
  });
}

function outputFields(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

test("preflight binds the exact PR head/base and creates private staging outside the checkout", () => {
  const root = temporary("preflight");
  const fixture = repository(root);
  const environment = preflightEnvironment(root, fixture);
  const result = execute("preflight", environment);
  assert.equal(result.status, 0, result.stderr);
  const fields = outputFields(environment.GITHUB_OUTPUT);
  assert.equal(fields.base, fixture.base);
  assert.equal(fields.head, fixture.head);
  assert.equal(fields["repository-root"], realpathSync(fixture.repo));
  assert.match(fields["output-dir"], /runner-temp\/abloh\/1234-1$/u);
  assert.match(fields["baseline-dir"], /runner-temp\/abloh-state\/1234-1\/baseline-history$/u);
  assert.match(fields["coverage-cache-dir"], /runner-temp\/abloh-state\/1234-1\/coverage-providers-fresh$/u);
  assert.match(fields["v2-store-dir"], /runner-temp\/abloh-state\/1234-1\/engine-v2$/u);
  assert.match(fields["triage-cache-dir"], /runner-temp\/abloh-state\/1234-1\/triage-cache$/u);
  assert.equal(lstatSync(fields["output-dir"]).isSymbolicLink(), false);
  assert.equal(git(fixture.repo, "status", "--porcelain"), "");
});

test("the engine-v2 state directory is created private, outside the checkout, and is cached", () => {
  /*
   * WITHOUT THIS PAIR NOTHING SURVIVES A RUN. There was one cache pair in this Action, for baseline
   * history, so the carry-forward store, the predictor, pool 2 and the line map all started cold on
   * every single Action run - and a second push on a pull request re-asked every verdict it already
   * had.
   *
   * The restore prefix is deliberately repository-wide rather than pull-request-wide: a rerun
   * restores its own branch's last run, and a pull request's first run restores the base branch's
   * records, which are valid for every file it did not touch. GitHub scopes cache READS to the
   * branch and its base, so one pull request still cannot read another's.
   */
  const root = temporary("v2-store");
  const fixture = repository(root);
  const environment = preflightEnvironment(root, fixture);
  assert.equal(execute("preflight", environment).status, 0);
  const directory = outputFields(environment.GITHUB_OUTPUT)["v2-store-dir"];

  const info = lstatSync(directory);
  assert.equal(info.isDirectory(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(info.mode & 0o077, 0, "per-repository state must not be group- or world-readable");
  assert.equal(directory.startsWith(realpathSync(fixture.repo)), false, "state must sit outside the checkout");

  const action = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "action.yml"), "utf8");
  assert.match(action, /Restore engine-v2 per-repository state/u);
  assert.match(action, /Save engine-v2 per-repository state/u);
  assert.match(action, /ABLOH_V2_STORE_DIR: \$\{\{ steps\.environment_preflight\.outputs\.v2-store-dir \}\}/u);
  assert.match(action, /restore-keys:\s*\|\s*\n\s*abloh-v2-store-v1-\$\{\{ runner\.os \}\}-\$\{\{ github\.repository_id \}\}-/u);

  /* THE COVERAGE PROVIDER CACHE STAYS UNCACHED, and the two must not drift into looking alike. That
     directory holds executable code this run will execute; this one holds data whose every use is
     bounded by a rule that holds whatever the data says. */
  assert.doesNotMatch(action, /path: \$\{\{ steps\.environment_preflight\.outputs\.coverage-cache-dir \}\}\s*\n\s*key:/u);
});

test("the triage verdict cache is created, passed to the CLI, and cached like the v2 store", () => {
  /*
   * THE OTHER HALF OF CARRY-FORWARD, WHICH THIS ACTION USED TO THROW AWAY EVERY PUSH.
   *
   * Triage verdicts are the expensive half of the saving and they do not live in the v2 store: they
   * live in the CLI's `--cache-dir`, whose default is `~/.abloh/triage-cache`. A hosted runner's
   * home directory is destroyed with the job, and the Action passed no `--cache-dir` and cached no
   * such path - so every push re-asked every verdict it already had. Measured 2026-08-23: a shared
   * triage cache carried 13 of 15 verdicts and took a run from $1.59 to $0.98.
   *
   * Three facts, and the feature needs all three: the directory exists outside the checkout, the
   * CLI is told to use it, and the runner persists it across jobs under the repository's own key.
   */
  const root = temporary("triage-cache");
  const fixture = repository(root);
  const environment = preflightEnvironment(root, fixture);
  assert.equal(execute("preflight", environment).status, 0);
  const fields = outputFields(environment.GITHUB_OUTPUT);
  const directory = fields["triage-cache-dir"];

  const info = lstatSync(directory);
  assert.equal(info.isDirectory(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(info.mode & 0o077, 0, "carried verdicts must not be group- or world-readable");
  assert.equal(directory.startsWith(realpathSync(fixture.repo)), false, "state must sit outside the checkout");

  const action = readFileSync(ACTION, "utf8");
  assert.match(action, /Restore triage verdict cache/u);
  assert.match(action, /Save triage verdict cache/u);
  assert.match(
    action,
    /ABLOH_TRIAGE_CACHE_DIR: \$\{\{ steps\.environment_preflight\.outputs\.triage-cache-dir \}\}/u,
  );
  assert.match(
    action,
    /restore-keys:\s*\|\s*\n\s*abloh-triage-cache-v1-\$\{\{ runner\.os \}\}-\$\{\{ github\.repository_id \}\}-/u,
  );

  /* AND THE CLI IS ACTUALLY TOLD. A cached directory nothing writes to is an empty cached
     directory, which is exactly the state this change replaces. */
  const runnerTemp = join(root, "runner-temp");
  const args = buildRunArguments({
    GITHUB_EVENT_NAME: "pull_request",
    REPOSITORY_ROOT: fields["repository-root"],
    BASE: fixture.base,
    HEAD_SHA: fixture.head,
    RUNNER_TEMP: runnerTemp,
    ABLOH_OUTPUT_DIR: fields["output-dir"],
    ABLOH_TRIAGE_CACHE_DIR: directory,
  });
  const at = args.indexOf("--cache-dir");
  assert.notEqual(at, -1, "the run must name the triage cache directory");
  assert.equal(args[at + 1], realpathSync(directory));

  /* NOT A CALLER-CONTROLLED PATH: it is checked exactly as the output directory is. */
  assert.throws(
    () => buildRunArguments({
      GITHUB_EVENT_NAME: "pull_request",
      REPOSITORY_ROOT: fields["repository-root"],
      BASE: fixture.base,
      HEAD_SHA: fixture.head,
      RUNNER_TEMP: runnerTemp,
      ABLOH_OUTPUT_DIR: fields["output-dir"],
      ABLOH_TRIAGE_CACHE_DIR: fields["repository-root"],
    }),
    /triage cache directory/u,
  );
});

test("preflight refuses synthetic target events, head/base substitution, and missing Docker", async (t) => {
  await t.test("pull_request_target", () => {
    const root = temporary("target-event");
    const fixture = repository(root);
    const result = execute("preflight", preflightEnvironment(root, fixture, {
      GITHUB_EVENT_NAME: "pull_request_target",
    }));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /pull_request_target is unsafe/u);
  });
  /*
   * EVERY EVENT THAT IS NOT A PULL REQUEST (Kenneth, 2026-08-21).
   *
   * `push` is the one customers actually ran, and it is checked beside two others so the rule
   * reads as "only pull_request is admitted" rather than "push is denied" — a denylist would let
   * `schedule` or `workflow_dispatch` in through the gap.
   */
  for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
    await t.test(`${eventName} is refused with the sentence that says what Abloh measures`, () => {
      const root = temporary(`event-${eventName}`);
      const fixture = repository(root);
      const result = execute("preflight", preflightEnvironment(root, fixture, {
        GITHUB_EVENT_NAME: eventName,
      }));
      assert.equal(result.status, 2);
      assert.match(
        result.stderr,
        /Abloh measures pull requests; run this on pull_request events/u,
      );
    });
  }
  await t.test("wrong head", () => {
    const root = temporary("wrong-head");
    const fixture = repository(root);
    const result = execute("preflight", preflightEnvironment(root, fixture, {
      PR_HEAD_SHA: fixture.base,
    }));
    assert.equal(result.status, 2);
    /* A checkout that is not the head is admitted only when it is PROVEN to be GitHub's merge of
       this pull request - see `merge-ref-checkout.ts`. This one is an ordinary commit with one
       parent, so the lineage proof fails and the refusal says which merge it was looking for. */
    assert.match(result.stderr, /is not a merge of this pull request's base/u);
    assert.match(result.stderr, /github\.event\.pull_request\.head\.sha/u, "the remedy contract");
  });
  await t.test("wrong declared base", () => {
    const root = temporary("wrong-base");
    const fixture = repository(root);
    const result = execute("preflight", preflightEnvironment(root, fixture, {
      DECLARED_BASE: fixture.head,
    }));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /pull-request base/u);
  });
  await t.test("missing Docker", () => {
    const root = temporary("missing-docker");
    const fixture = repository(root);
    const environment = preflightEnvironment(root, fixture);
    environment.PATH = toolPath(join(root, "without-docker"), { docker: false });
    const result = execute("preflight", environment);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /docker must be installed/u);
  });
  await t.test("missing npm", () => {
    const root = temporary("missing-npm");
    const fixture = repository(root);
    const environment = preflightEnvironment(root, fixture);
    unlinkSync(join(environment.PATH, "npm"));
    const result = execute("preflight", environment);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /npm must be installed/u);
  });
  await t.test("unreachable Docker daemon", () => {
    const root = temporary("dead-docker");
    const fixture = repository(root);
    const environment = preflightEnvironment(root, fixture);
    writeExecutable(join(environment.PATH, "docker"), "#!/bin/sh\nexit 1\n");
    const result = execute("preflight", environment);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /reachable daemon/u);
  });
});

test("preflight refuses hostile repository paths, symlink escapes, and occupied output staging", async (t) => {
  await t.test("lexical escape", () => {
    const root = temporary("repo-escape");
    const fixture = repository(root);
    const result = execute("preflight", preflightEnvironment(root, fixture, { REPO_PATH: "../outside" }));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /canonical relative POSIX path/u);
  });
  await t.test("symlink escape", () => {
    const root = temporary("repo-link");
    const fixture = repository(root);
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(fixture.workspace, "linked"));
    const result = execute("preflight", preflightEnvironment(root, fixture, { REPO_PATH: "linked" }));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /resolves outside/u);
  });
  await t.test("control characters", () => {
    const root = temporary("repo-control");
    const fixture = repository(root);
    const result = execute("preflight", preflightEnvironment(root, fixture, { REPO_PATH: "repo\nwith space" }));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /control-free/u);
  });
  await t.test("pre-created output symlink", () => {
    const root = temporary("output-link");
    const fixture = repository(root);
    const environment = preflightEnvironment(root, fixture);
    mkdirSync(join(environment.RUNNER_TEMP, "abloh"));
    symlinkSync(fixture.repo, join(environment.RUNNER_TEMP, "abloh", "1234-1"));
    const result = execute("preflight", environment);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /staging leaf already exists/u);
  });
  await t.test("runner temporary directory inside checkout", () => {
    const root = temporary("output-overlap");
    const fixture = repository(root);
    const environment = preflightEnvironment(root, fixture);
    environment.RUNNER_TEMP = join(fixture.repo, ".runner-temp");
    mkdirSync(environment.RUNNER_TEMP);
    const result = execute("preflight", environment);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must not overlap the measured repository/u);
  });
});

function fakeCli(root) {
  const prefix = join(root, "runner-temp", "abloh-cli", "1234-1");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(prefix, "lib"), { recursive: true });
  const target = join(prefix, "lib", "cli.mjs");
  writeExecutable(target, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.ACTION_RECORD_PATH, JSON.stringify({ argv: process.argv.slice(2), env: { model: process.env.MODEL_API_KEY, modelAlt: process.env.MODEL_API_KEY_ALT, oidcUrl: process.env.MODEL_OIDC_REQUEST_URL, oidcAudience: process.env.MODEL_OIDC_AUDIENCE, endpoint: process.env.MODEL_ENDPOINT, auth: process.env.MODEL_AUTH, staleEndpoint: process.env.ATTEST_MODEL_ENDPOINT, staleAuth: process.env.ATTEST_MODEL_AUTH, staleOidcUrl: process.env.ATTEST_MODEL_OIDC_REQUEST_URL, github: process.env.GITHUB_TOKEN, api: process.env.API_TOKEN, output: process.env.ABLOH_OUTPUT_DIR, liveUrl: process.env.ABLOH_LIVE_PROGRESS_URL, liveOidcUrl: process.env.ABLOH_LIVE_PROGRESS_OIDC_REQUEST_URL, liveOidcToken: process.env.ABLOH_LIVE_PROGRESS_OIDC_REQUEST_TOKEN, liveAudience: process.env.ABLOH_LIVE_PROGRESS_OIDC_AUDIENCE, commandCenter: process.env.ABLOH_COMMAND_CENTER_ORIGIN, liveRaw: process.env.LIVE_PROGRESS_URL, admissionUrl: process.env.ABLOH_CHECK_ADMISSION_URL, admissionOidcUrl: process.env.ABLOH_CHECK_ADMISSION_OIDC_REQUEST_URL, admissionOidcToken: process.env.ABLOH_CHECK_ADMISSION_OIDC_REQUEST_TOKEN, admissionAudience: process.env.ABLOH_CHECK_ADMISSION_OIDC_AUDIENCE, admissionRaw: process.env.CHECK_ADMISSION_URL } }));\n`);
  symlinkSync("../lib/cli.mjs", join(prefix, "bin", "abloh"));
  return { cli: join(prefix, "bin", "abloh"), prefix };
}

test("the executable run boundary routes JS and Python identically without shell interpretation", async (t) => {
  for (const kind of ["javascript", "python"]) {
    await t.test(kind, async () => {
      const root = temporary(`run-${kind}`);
      const fixture = repository(root, kind);
      const environment = preflightEnvironment(root, fixture);
      assert.equal(execute("preflight", environment).status, 0);
      const fields = outputFields(environment.GITHUB_OUTPUT);
      const installed = fakeCli(root);
      const record = join(root, "invocation.json");
      const pwned = join(root, "pwned");
      const testCommand = `node --test 'literal;touch ${pwned}'`;
      const oidc = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJhYmxvaCJ9.signature";
      const runEnvironment = {
        ...process.env,
        RUNNER_TEMP: environment.RUNNER_TEMP,
        REPOSITORY_ROOT: fields["repository-root"],
        BASE: fixture.base,
        HEAD_SHA: fixture.head,
        TIER: "1",
        SUBDIR: "packages/demo",
        POLICY: "config/abloh.yml",
        ENVIRONMENT_IMAGE: `registry.example:5000/node@sha256:${"a".repeat(64)}`,
        TEST_COMMAND: testCommand,
        SEED: "b".repeat(32),
        ABLOH_OUTPUT_DIR: fields["output-dir"],
        ABLOH_TRIAGE_CACHE_DIR: fields["triage-cache-dir"],
        ABLOH_CLI_PATH: installed.cli,
        ABLOH_CLI_PREFIX: installed.prefix,
        ACTION_RECORD_PATH: record,
        MODEL_GATEWAY_URL: "https://api.abloh.example/api/v1/model/chat/completions",
        MODEL_GATEWAY_AUDIENCE: "https://api.abloh.example/model",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc?x=1",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-oidc-request-secret",
        ATTEST_MODEL_API_KEY: undefined,
        ATTEST_MODEL_API_KEY_ALT: undefined,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GITHUB_TOKEN: "github-secret-sentinel",
        API_TOKEN: "api-secret-sentinel",
      };
      const requested = [];
      const status = await runAbloh(runEnvironment, async (url, options) => {
        requested.push({ url: String(url), authorization: options?.headers?.authorization });
        return new Response(JSON.stringify({ value: oidc }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      assert.equal(status, 0);
      /* NOTHING is minted here any more. A token obtained now is presented minutes later — after
         baseline, coverage, mutation and per-test attribution — and a short-lived GitHub identity
         has expired by then. Observed on a real tier-2 run: the gateway answered 401 and the CLI
         reported "the provider is unusable (binary missing or auth dead)". The CLI is handed the
         MINTING ENDPOINT and obtains the credential when it makes the call. */
      assert.deepEqual(requested, [], "the run boundary must not mint an identity it will not use");
      const invocation = JSON.parse(readFileSync(record, "utf8"));
      assert.equal(invocation.argv.includes("--lang"), false, "language routing belongs to the CLI");
      assert.equal(invocation.argv[invocation.argv.indexOf("--test-command") + 1], testCommand);
      assert.equal(invocation.argv[invocation.argv.indexOf("--repo") + 1], realpathSync(fixture.repo));
      assert.equal(invocation.env.model, undefined, "no pre-minted key is handed to the CLI");
      assert.equal(
        invocation.env.oidcUrl,
        "https://token.actions.githubusercontent.com/oidc?x=1",
        "the CLI receives the endpoint that mints the identity, not the identity",
      );
      assert.equal(invocation.env.oidcAudience, "https://api.abloh.example/model");
      assert.equal(invocation.env.modelAlt, undefined, "nor to the alternate slot");
      assert.equal(invocation.env.endpoint, "https://api.abloh.example/api/v1/model/chat/completions");
      assert.equal(invocation.env.auth, "bearer");
      /* ONE FAMILY REACHES THE CLI, NOT TWO. This boundary used to write the v1 lane's
         `ATTEST_MODEL_*` names and nothing else, so engine-v2 - which reads `MODEL_*` - had no
         endpoint on any Action run and the shipped customer path triaged and then generated
         NOTHING. It now writes the canonical names, and deliberately does not write the deprecated
         ones alongside: putting two names for one credential into this environment is the fault
         being removed, not a safety net. */
      assert.equal(invocation.env.staleEndpoint, undefined, "the deprecated family must not be written too");
      assert.equal(invocation.env.staleAuth, undefined);
      assert.equal(invocation.env.staleOidcUrl, undefined);
      assert.equal(invocation.env.github, undefined);
      assert.equal(invocation.env.api, undefined);
      assert.equal(invocation.env.output, undefined, "customer tests do not receive Action staging paths");
      /* LIVE PROGRESS IS ABSENT HERE, and that is the point: this environment names no
         LIVE_PROGRESS_URL, so the child sees none of its variables and the CLI streams nothing -
         byte for byte the run every repository got before live progress existed. */
      assert.equal(invocation.env.liveUrl, undefined);
      assert.equal(invocation.env.liveOidcUrl, undefined);
      assert.equal(invocation.env.liveOidcToken, undefined);
      assert.equal(invocation.env.liveAudience, undefined);
      assert.equal(readFileSync(environment.GITHUB_OUTPUT, "utf8").includes("secret-sentinel"), false);
      assert.equal(git(fixture.repo, "status", "--porcelain"), "");
      assert.throws(() => readFileSync(pwned), /ENOENT/u);
    });
  }
});

test("live progress reaches the CLI as a mint endpoint, never as a token the Action obtained", async () => {
  /*
   * The same rule the model gateway learned: a composed v2 check runs long past the life of a
   * GitHub OIDC token, so what crosses into the CLI is the endpoint that mints one, not one that
   * was minted here. A SEPARATE AUDIENCE, because a live-progress identity must buy exactly one
   * in-progress check-run update and nothing a model-gateway identity buys.
   */
  const root = temporary("run-live-progress");
  const fixture = repository(root);
  const environment = preflightEnvironment(root, fixture);
  assert.equal(execute("preflight", environment).status, 0);
  const fields = outputFields(environment.GITHUB_OUTPUT);
  const installed = fakeCli(root);
  const record = join(root, "invocation.json");
  const requested = [];
  const status = await runAbloh(
    {
      ...process.env,
      RUNNER_TEMP: environment.RUNNER_TEMP,
      REPOSITORY_ROOT: fields["repository-root"],
      BASE: fixture.base,
      HEAD_SHA: fixture.head,
      ABLOH_OUTPUT_DIR: fields["output-dir"],
      ABLOH_TRIAGE_CACHE_DIR: fields["triage-cache-dir"],
      ABLOH_CLI_PATH: installed.cli,
      ABLOH_CLI_PREFIX: installed.prefix,
      ACTION_RECORD_PATH: record,
      LIVE_PROGRESS_URL: "https://api.abloh.example/api/v1/runs/live-progress",
      LIVE_PROGRESS_AUDIENCE: "abloh-live-progress",
      COMMAND_CENTER_ORIGIN: "https://abloh.example",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc?x=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-oidc-request-secret",
      ATTEST_MODEL_API_KEY: undefined,
      ATTEST_MODEL_API_KEY_ALT: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    async (url) => {
      requested.push(String(url));
      return new Response("{}", { status: 200 });
    },
  );
  assert.equal(status, 0);
  assert.deepEqual(requested, [], "the run boundary mints no live-progress identity either");
  const invocation = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(invocation.env.liveUrl, "https://api.abloh.example/api/v1/runs/live-progress");
  assert.equal(invocation.env.liveOidcUrl, "https://token.actions.githubusercontent.com/oidc?x=1");
  assert.equal(invocation.env.liveOidcToken, "github-oidc-request-secret");
  assert.equal(invocation.env.liveAudience, "abloh-live-progress");
  assert.equal(invocation.env.commandCenter, "https://abloh.example");
  /* The Action's own orchestration names never reach the measured suite, exactly as the gateway's
     do not: what the CLI reads is the ABLOH_-prefixed pass-through above. */
  assert.equal(invocation.env.liveRaw, undefined);
});

test("preflight admission reaches the CLI as a mint endpoint, under its own audience", async () => {
  /*
   * The third pass-through and the smallest grant: an identity that buys one ANSWER - whether this
   * run may start and whether its generation arm is funded. Its own audience, because a token
   * minted to move a check run must not be spendable on an admission and the other way about.
   *
   * ABSENT MEANS OFF is asserted by the run-boundary test above, which names no CHECK_ADMISSION_URL
   * and sees none of these variables reach the child.
   */
  const root = temporary("run-check-admission");
  const fixture = repository(root);
  const environment = preflightEnvironment(root, fixture);
  assert.equal(execute("preflight", environment).status, 0);
  const fields = outputFields(environment.GITHUB_OUTPUT);
  const installed = fakeCli(root);
  const record = join(root, "invocation.json");
  const requested = [];
  const status = await runAbloh(
    {
      ...process.env,
      RUNNER_TEMP: environment.RUNNER_TEMP,
      REPOSITORY_ROOT: fields["repository-root"],
      BASE: fixture.base,
      HEAD_SHA: fixture.head,
      ABLOH_OUTPUT_DIR: fields["output-dir"],
      ABLOH_TRIAGE_CACHE_DIR: fields["triage-cache-dir"],
      ABLOH_CLI_PATH: installed.cli,
      ABLOH_CLI_PREFIX: installed.prefix,
      ACTION_RECORD_PATH: record,
      CHECK_ADMISSION_URL: "https://api.abloh.example/api/v1/runs/admission",
      CHECK_ADMISSION_AUDIENCE: "abloh-check-admission",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc?x=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-oidc-request-secret",
      ATTEST_MODEL_API_KEY: undefined,
      ATTEST_MODEL_API_KEY_ALT: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    async (url) => {
      requested.push(String(url));
      return new Response("{}", { status: 200 });
    },
  );
  assert.equal(status, 0);
  assert.deepEqual(requested, [], "the run boundary mints no admission identity either");
  const invocation = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(invocation.env.admissionUrl, "https://api.abloh.example/api/v1/runs/admission");
  assert.equal(invocation.env.admissionOidcUrl, "https://token.actions.githubusercontent.com/oidc?x=1");
  assert.equal(invocation.env.admissionOidcToken, "github-oidc-request-secret");
  assert.equal(invocation.env.admissionAudience, "abloh-check-admission");
  /* The Action's own orchestration name never reaches the measured suite. */
  assert.equal(invocation.env.admissionRaw, undefined);
  /* And a live-progress identity is not what was handed over: one audience, one capability. */
  assert.equal(invocation.env.liveAudience, undefined);
});

test("the customer Action refuses direct model-provider credentials", async () => {
  const root = temporary("direct-model-secret");
  const fixture = repository(root);
  const environment = preflightEnvironment(root, fixture);
  assert.equal(execute("preflight", environment).status, 0);
  const fields = outputFields(environment.GITHUB_OUTPUT);
  const installed = fakeCli(root);
  await assert.rejects(
    runAbloh({
      ...environment,
      REPOSITORY_ROOT: fields["repository-root"],
      BASE: fixture.base,
      HEAD_SHA: fixture.head,
      ABLOH_OUTPUT_DIR: fields["output-dir"],
      ABLOH_TRIAGE_CACHE_DIR: fields["triage-cache-dir"],
      ABLOH_CLI_PATH: installed.cli,
      ABLOH_CLI_PREFIX: installed.prefix,
      ATTEST_MODEL_API_KEY: "raw-provider-secret",
    }),
    /must not be supplied to the customer Action/u,
  );
});

test("run argument admission rejects path, image, seed, and staging attacks before the CLI", async (t) => {
  const root = temporary("run-admission");
  const fixture = repository(root);
  const runnerTemp = join(root, "runner-temp");
  const output = join(runnerTemp, "abloh", "1-1");
  const triageCache = join(runnerTemp, "abloh-state", "1-1", "triage-cache");
  mkdirSync(output, { recursive: true });
  mkdirSync(triageCache, { recursive: true });
  const common = {
    REPOSITORY_ROOT: fixture.repo,
    BASE: fixture.base,
    HEAD_SHA: fixture.head,
    TIER: "1",
    RUNNER_TEMP: runnerTemp,
    ABLOH_OUTPUT_DIR: output,
    ABLOH_TRIAGE_CACHE_DIR: triageCache,
  };
  await t.test("subdir escape", () => assert.throws(
    () => buildRunArguments({ ...common, SUBDIR: "../escape" }),
    /canonical relative/u,
  ));
  await t.test("policy escape", () => assert.throws(
    () => buildRunArguments({ ...common, POLICY: "/tmp/abloh.yml" }),
    /canonical relative/u,
  ));
  await t.test("mutable image", () => assert.throws(
    () => buildRunArguments({ ...common, ENVIRONMENT_IMAGE: "node:24" }),
    /immutable/u,
  ));
  await t.test("seed injection", () => assert.throws(
    () => buildRunArguments({ ...common, SEED: "a; touch x" }),
    /hexadecimal/u,
  ));
  await t.test("checkout output", () => assert.throws(
    () => buildRunArguments({ ...common, ABLOH_OUTPUT_DIR: fixture.repo }),
    /must stay inside RUNNER_TEMP/u,
  ));
});

/*
 * THE DEPRECATED `tier` INPUT REACHES THE CLI, BECAUSE THE V1 ENGINE STILL ACTS ON IT.
 *
 * The privacy tier is deprecated (Kenneth, 2026-08-14) and the v2 engine has no tier in it, so the
 * Action briefly accepted the input and dropped it. The shipped engine default is v1, where the
 * tier decides whether LLM triage runs and whether proven test bodies and changed source spans are
 * uploaded - so dropping the flag moved a `tier: 0` workflow onto the tier-2 defaults and began
 * uploading what that customer had opted out of. This is the regression test for that: a workflow
 * that writes `tier: 0` must reach the CLI as `--tier 0`, today, on the engine running today.
 */
test("a workflow's tier input reaches the CLI, and a malformed one is refused", async (t) => {
  const root = temporary("tier-forwarded");
  const fixture = repository(root);
  const runnerTemp = join(root, "runner-temp");
  const output = join(runnerTemp, "abloh", "1-1");
  const triageCache = join(runnerTemp, "abloh-state", "1-1", "triage-cache");
  mkdirSync(output, { recursive: true });
  mkdirSync(triageCache, { recursive: true });
  const common = {
    REPOSITORY_ROOT: fixture.repo,
    BASE: fixture.base,
    HEAD_SHA: fixture.head,
    RUNNER_TEMP: runnerTemp,
    ABLOH_OUTPUT_DIR: output,
    ABLOH_TRIAGE_CACHE_DIR: triageCache,
  };

  await t.test("a workflow that sets tier: 0 runs at tier 0", () => {
    const args = buildRunArguments({ ...common, GITHUB_EVENT_NAME: "push", TIER: "0" });
    const at = args.indexOf("--tier");
    assert.notEqual(at, -1, "the customer's tier must reach the CLI");
    assert.equal(args[at + 1], "0");
  });

  await t.test("and one that sets tier: 1 runs at tier 1", () => {
    const args = buildRunArguments({ ...common, GITHUB_EVENT_NAME: "push", TIER: "1" });
    assert.equal(args[args.indexOf("--tier") + 1], "1");
  });

  await t.test("a run that names no tier gets no flag, so the policy's own value stands", () => {
    const args = buildRunArguments({ ...common, GITHUB_EVENT_NAME: "push" });
    assert.equal(args.includes("--tier"), false);
  });

  await t.test("a value that is not a tier is refused rather than forwarded", () => {
    assert.throws(
      () => buildRunArguments({ ...common, GITHUB_EVENT_NAME: "push", TIER: "9" }),
      /tier must be 0, 1, or 2/u,
    );
    assert.throws(() => validateActionInputs({ TIER: "9", UPLOAD: "false" }), /tier must be 0, 1, or 2/u);
  });

  await t.test("the caller's own job status is admitted on a pull request and checked", () => {
    /*
     * IT HAS TO BE READABLE ON `pull_request`, which is the only event this Action runs on, so it is
     * deliberately not on `PULL_REQUEST_OVERRIDE_INPUTS`. It passes that list's own test: the worst a
     * value here can do is stop a pull request being measured, which blocks a merge rather than
     * passing one.
     */
    assert.doesNotThrow(() =>
      buildRunArguments({
        ...common,
        GITHUB_EVENT_NAME: "pull_request",
        ABLOH_CALLER_JOB_STATUS: "failure",
      }),
    );
    /* ABSENT IS THE ORDINARY VALUE: every standalone workflow and every local run says nothing. */
    assert.equal(callerJobStatus({}), "");
    assert.equal(callerJobStatus({ ABLOH_CALLER_JOB_STATUS: "Failure" }), "failure");
    /* AND AN UNREADABLE ONE IS REFUSED RATHER THAN TREATED AS SILENCE, because treating it as
       silence would measure a half-built tree on exactly the run the field exists to stop. */
    assert.throws(
      () => buildRunArguments({ ...common, ABLOH_CALLER_JOB_STATUS: "red" }),
      /job-status must be one of/u,
    );
  });

  await t.test("a pull request may not set it; the trusted merge-base policy decides", () => {
    assert.throws(
      () => buildRunArguments({ ...common, GITHUB_EVENT_NAME: "pull_request", TIER: "0" }),
      /trusted merge-base abloh\.yml.*tier/u,
    );
  });

  await t.test("the input is still declared, so a workflow naming it is not an unknown input", () => {
    const declared = readFileSync(join(HERE, "action.yml"), "utf8");
    assert.match(declared, /^ {2}tier:$/mu);
    assert.match(declared, /Deprecated, and still honoured/u);
  });
});

test("pull-request run arguments contain no caller-controlled measurement override", async (t) => {
  const root = temporary("trusted-pr-argv");
  const fixture = repository(root);
  const runnerTemp = join(root, "runner-temp");
  const output = join(runnerTemp, "abloh", "1-1");
  const triageCache = join(runnerTemp, "abloh-state", "1-1", "triage-cache");
  mkdirSync(output, { recursive: true });
  mkdirSync(triageCache, { recursive: true });
  const common = {
    GITHUB_EVENT_NAME: "pull_request",
    REPOSITORY_ROOT: fixture.repo,
    BASE: fixture.base,
    HEAD_SHA: fixture.head,
    TIER: "",
    SUBDIR: "",
    POLICY: "",
    ENVIRONMENT_IMAGE: "",
    TEST_COMMAND: "",
    SEED: "",
    RUNNER_TEMP: runnerTemp,
    ABLOH_OUTPUT_DIR: output,
    ABLOH_TRIAGE_CACHE_DIR: triageCache,
  };
  const args = buildRunArguments(common);
  for (const flag of ["--tier", "--subdir", "--policy", "--environment-image", "--test-command", "--seed"]) {
    assert.equal(args.includes(flag), false, `${flag} must come only from trusted merge-base policy`);
  }
  assert.deepEqual(args.slice(0, 7), [
    "run", "--repo", realpathSync(fixture.repo), "--base", fixture.base, "--head", fixture.head,
  ]);

  /* `tier` is on this list again: under the v1 engine a lower tier measures on weaker terms, which
     is exactly what a pull request must not be able to choose for itself. */
  const attacks = [
    ["TIER", "0", "tier"],
    ["SUBDIR", "packages/weak", "subdir"],
    ["POLICY", "weak.yml", "policy"],
    ["ENVIRONMENT_IMAGE", `attacker.invalid/node@sha256:${"a".repeat(64)}`, "environment-image"],
    ["TEST_COMMAND", "node fake-green-suite.mjs", "test-command"],
    ["SEED", "a", "seed"],
  ];
  for (const [name, value, label] of attacks) {
    await t.test(label, () => assert.throws(
      () => buildRunArguments({ ...common, [name]: value }),
      new RegExp(`trusted merge-base abloh\\.yml.*${label}`, "u"),
    ));
  }
});

test("all public Action inputs are admitted before the expensive run starts", () => {
  assert.doesNotThrow(() => validateActionInputs({
    TIER: "1",
    UPLOAD: "false",
    SUBDIR: "packages/demo app",
    POLICY: "config/abloh.yml",
    ENVIRONMENT_IMAGE: `registry.example/node@sha256:${"a".repeat(64)}`,
    TEST_COMMAND: "node --test 'test file.mjs'",
    SEED: "A",
    MODEL_GATEWAY_URL: "https://api.abloh.example/api/v1/model/chat/completions",
    MODEL_GATEWAY_AUDIENCE: "https://api.abloh.example/model",
  }));
  /* The tier is deprecated and still acted on by the v1 engine, so its shape is judged here: a
     malformed value must fail at the boundary rather than reach the CLI as an argument. */
  assert.throws(() => validateActionInputs({ TIER: "9", UPLOAD: "false" }), /tier must be 0, 1, or 2/u);
  assert.throws(() => validateActionInputs({ UPLOAD: "yes" }), /upload must be true or false/u);
  /* UPLOAD IS NOW ADMITTED. It used to be refused as "token-bearing", which was true of a shared
     secret and untrue of the GitHub OIDC identity the upload step actually mints — scoped to one
     audience, valid for minutes, and authorizing only "post evidence about this repo at this commit",
     which a job running the customer's tests can do anyway. The limit that remains is the GRADE: the
     control plane records no artifact digest for this path, so it can never read `service-verified`. */
  assert.doesNotThrow(() => validateActionInputs({
    UPLOAD: "true",
    MODEL_GATEWAY_URL: "https://api.abloh.example/api/v1/model/chat/completions",
    MODEL_GATEWAY_AUDIENCE: "https://api.abloh.example/model",
  }));
  assert.throws(() => validateActionInputs({ PR_COMMENT: "cli" }), /PR reporting is unavailable/u);
  assert.throws(() => validateActionInputs({ SUBDIR: "--uncommitted" }), /canonical relative/u);
  assert.throws(() => validateActionInputs({ POLICY: "config/../abloh.yml" }), /canonical relative/u);
  assert.throws(() => validateActionInputs({ TEST_COMMAND: "--uncommitted" }), /must begin with an executable/u);
});

test("pull-request preflight refuses every measurement override before repository execution", async (t) => {
  /* `tier` is here for the same reason it is in the argument-vector list above. */
  const attacks = [
    ["TIER", "0", "tier"],
    ["SUBDIR", "packages/demo", "subdir"],
    ["POLICY", "config/abloh.yml", "policy"],
    ["ENVIRONMENT_IMAGE", `attacker.invalid/node@sha256:${"a".repeat(64)}`, "environment-image"],
    ["TEST_COMMAND", "node fake-green-suite.mjs", "test-command"],
    ["SEED", "a", "seed"],
  ];
  for (const [name, value, label] of attacks) {
    await t.test(label, () => {
      const root = temporary(`trusted-pr-preflight-${label}`);
      const fixture = repository(root);
      const result = execute("preflight", preflightEnvironment(root, fixture, { [name]: value }));
      assert.equal(result.status, 2);
      assert.match(result.stderr, /trusted merge-base abloh\.yml/u);
      assert.match(result.stderr, new RegExp(label, "u"));
    });
  }
});

test("the Action enforces the CLI's Node >=20.6 runtime boundary", () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion("20.6.0"));
  assert.doesNotThrow(() => assertSupportedNodeVersion("24.18.0"));
  assert.throws(() => assertSupportedNodeVersion("20.5.1"), /Node >=20\.6/u);
  assert.throws(() => assertSupportedNodeVersion("18.20.8"), /Node >=20\.6/u);
});

test("CLI package specs are argument data and the executable must stay under its private prefix", () => {
  assert.deepEqual(parsePackageSpecs("one.tgz https://example.invalid/two.tgz;touch-pwned"), [
    "one.tgz",
    "https://example.invalid/two.tgz;touch-pwned",
  ]);
  assert.throws(() => parsePackageSpecs("--force"), /unsafe package spec/u);
});

/*
 * NOTHING TO PACK, FOR THE FIRST TIME.
 *
 * `cli-tarball` was required because no part of Abloh was on npm: a caller had to pack the CLI and
 * its six workspace dependencies and pass all seven paths, which is why our own e2e repository was
 * the only one that could run this action. With @abloh/cli published, absent means "install the
 * release".
 */
test("an absent cli-tarball installs the published release, pinned", () => {
  assert.deepEqual(parsePackageSpecs(undefined), [DEFAULT_CLI_SPEC]);
  assert.deepEqual(parsePackageSpecs(""), [DEFAULT_CLI_SPEC]);
  assert.deepEqual(parsePackageSpecs("   "), [DEFAULT_CLI_SPEC]);
  /* Pinned, never `latest`: a caller who pinned this action by SHA has already chosen which Abloh
     they run, and resolving a floating tag would change that under them. */
  assert.match(DEFAULT_CLI_SPEC, /^@abloh\/cli@\d+\.\d+\.\d+$/u);
});

test("an explicit cli-tarball still wins, for a build that is not on the registry", () => {
  assert.deepEqual(parsePackageSpecs("./abloh-cli-0.1.0.tgz ./abloh-core-0.1.0.tgz"), [
    "./abloh-cli-0.1.0.tgz",
    "./abloh-core-0.1.0.tgz",
  ]);
});

test("the executable installer keeps package specs literal and binds the CLI to private staging", () => {
  const root = temporary("install-cli");
  const runnerTemp = join(root, "runner-temp");
  const tools = join(root, "fake-tools");
  mkdirSync(runnerTemp);
  mkdirSync(tools);
  const record = join(root, "npm-argv.txt");
  const environmentRecord = join(root, "npm-environment.txt");
  const pwned = join(root, "pwned");
  writeExecutable(join(tools, "npm"), `#!/bin/sh
set -eu
: > "$ACTION_RECORD_PATH"
printf '%s|%s|%s' "\${ATTEST_MODEL_API_KEY-}" "\${GITHUB_TOKEN-}" "\${npm_config_ignore_scripts-}" > "$ACTION_ENV_RECORD_PATH"
prefix=""
while [ "$#" -gt 0 ]; do
  printf '%s\\n' "$1" >> "$ACTION_RECORD_PATH"
  if [ "$1" = "--prefix" ]; then
    shift
    prefix="$1"
    printf '%s\\n' "$1" >> "$ACTION_RECORD_PATH"
  fi
  shift
done
test -n "$prefix"
mkdir -p "$prefix/bin" "$prefix/lib"
printf '#!/bin/sh\\nexit 0\\n' > "$prefix/lib/abloh"
chmod 755 "$prefix/lib/abloh"
ln -s ../lib/abloh "$prefix/bin/abloh"
`);
  const output = join(root, "github-output");
  writeFileSync(output, "");
  const hostileSpec = `https://example.invalid/cli.tgz;touch-${pwned}`;
  const result = execute("install-cli", {
    ...process.env,
    PATH: `${tools}:/usr/bin:/bin`,
    RUNNER_TEMP: runnerTemp,
    GITHUB_RUN_ID: "99",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_OUTPUT: output,
    CLI_TARBALL: `core.tgz ${hostileSpec}`,
    ACTION_RECORD_PATH: record,
    ACTION_ENV_RECORD_PATH: environmentRecord,
    ATTEST_MODEL_API_KEY: "model-install-secret",
    GITHUB_TOKEN: "github-install-secret",
  });
  assert.equal(result.status, 0, result.stderr);
  const fields = outputFields(output);
  assert.equal(realpathSync(fields.path).startsWith(`${realpathSync(fields.prefix)}/`), true);
  const argv = readFileSync(record, "utf8").trim().split("\n");
  assert.deepEqual(argv.slice(0, 9), [
    "install",
    "-g",
    "--prefix",
    fields.prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--",
    "core.tgz",
  ]);
  assert.equal(argv.at(-1), hostileSpec);
  assert.equal(readFileSync(environmentRecord, "utf8"), "||true");
  assert.throws(() => readFileSync(pwned), /ENOENT/u);
});

test("artifact boundary rejects symlinks", () => {
  const root = temporary("artifact");
  const output = join(root, "output");
  mkdirSync(output);
  writeFileSync(join(output, "attest-results.json"), "{}\n");
  assert.equal(
    validateArtifact({ ABLOH_OUTPUT_DIR: output, ABLOH_ARTIFACT_NAME: "attest-results.json" }),
    join(realpathSync(output), "attest-results.json"),
  );
  symlinkSync("attest-results.json", join(output, "linked.json"));
  assert.throws(
    () => validateArtifact({ ABLOH_OUTPUT_DIR: output, ABLOH_ARTIFACT_NAME: "linked.json" }),
    /regular non-symlink/u,
  );
});

test("the composite Action uses the executable boundary and never reconstructs customer setup", () => {
  const source = readFileSync(ACTION, "utf8");
  for (const command of ["preflight", "install-cli", "run", "validate-artifact", "upload"]) {
    assert.match(source, new RegExp(`action-boundary\\.mjs[\"']? ${command}`, "u"));
  }
  assert.doesNotMatch(source, /actions\/checkout@/u);
  assert.doesNotMatch(source, /(?:npm ci|pnpm install|yarn install|pip install|poetry install)/u);
  assert.match(source, /steps\.environment_preflight\.outputs\.output-dir/u);
  assert.match(source, /steps\.environment_preflight\.outputs\.head/u);
  assert.match(source, /steps\.environment_preflight\.outputs\.base/u);
  assert.match(source, /steps\.artifact_state\.outputs\.complete == 'true'/u);
  assert.match(source, /GITHUB_EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.doesNotMatch(source, /(?:GITHUB_TOKEN|API_TOKEN|github-token|api-token|post-report|prepare-upload\.mjs|upload-url)/u);
  assert.doesNotMatch(source, /inputs\.(?:upload|pr-comment)/u);
  /* The upload step exists and is OIDC-only: the handoff address is resolved and carries no
     long-lived credential. The doesNotMatch above already forbids GITHUB_TOKEN/API_TOKEN anywhere in
     the file, so the two together say "uploads, but never with a shared secret".

     The address stopped being a customer input: `handoff-url` and `handoff-audience` were two of our
     own URLs that every handed-out workflow had to carry correctly, and one of them shipped WRONG.
     They are deployment constants now, written to the job environment by the resolve step, so what
     this test pins is the constant itself rather than an input that no longer exists.

     THE CONSTANTS MOVED OUT OF THE YAML AND INTO THE BOUNDARY (assumption audit rank 11): they were
     eleven `echo "NAME=${OVERRIDE:-default}"` lines redirected into $GITHUB_ENV, and an ambient
     override carrying a newline wrote a second environment record nobody declared. The step now
     calls `resolve-control-plane`, which validates each value before it is written, so the address
     is pinned where it is now spelled. */
  assert.doesNotMatch(source, /inputs\.handoff-(?:url|audience)/u);
  assert.match(source, /action-boundary\.mjs["']? resolve-control-plane/u);
  assert.doesNotMatch(source, />> "\$GITHUB_ENV"/u, "no step may write $GITHUB_ENV through a shell redirection");
  const boundary = readFileSync(BOUNDARY, "utf8");
  assert.match(boundary, /HANDOFF_URL: url\("ABLOH_DEV_HANDOFF_URL", "https:\/\/api\.abloh\.dev\/api\/v1\/runs"\)/u);
  assert.match(boundary, /HANDOFF_AUDIENCE: audience\("ABLOH_DEV_HANDOFF_AUDIENCE", "abloh-evidence-handoff"\)/u);
  assert.doesNotMatch(source, /Restore version-bound coverage adapters/u);
  assert.doesNotMatch(source, /Save version-bound coverage adapters/u);
  assert.doesNotMatch(source, /\/tmp\/attest-post-report/u);
});

test("prepare builds a trusted argv, refuses PR overrides, and soft-fails CLI errors", async (t) => {
  await t.test("argv shape with the preflight-minted cache dir", () => {
    const root = temporary("prepare-argv");
    const runnerTemp = join(root, "runner-temp");
    const cacheDir = join(runnerTemp, "abloh-state", "1-1", "coverage-providers-fresh");
    mkdirSync(cacheDir, { recursive: true });
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const args = buildPrepareArguments({
      GITHUB_EVENT_NAME: "push",
      REPOSITORY_ROOT: repo,
      RUNNER_TEMP: runnerTemp,
      ABLOH_COVERAGE_PROVIDER_CACHE_DIR: cacheDir,
      SUBDIR: "packages/api",
    });
    assert.deepEqual(args, [
      "prepare",
      "--repo", realpathSync(repo),
      "--cache-dir", realpathSync(cacheDir),
      "--subdir", "packages/api",
    ]);
  });

  await t.test("pull_request events refuse a caller-controlled subdir", () => {
    const root = temporary("prepare-pr");
    const runnerTemp = join(root, "runner-temp");
    const cacheDir = join(runnerTemp, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    assert.throws(() => buildPrepareArguments({
      GITHUB_EVENT_NAME: "pull_request",
      REPOSITORY_ROOT: repo,
      RUNNER_TEMP: runnerTemp,
      ABLOH_COVERAGE_PROVIDER_CACHE_DIR: cacheDir,
      SUBDIR: "packages/api",
    }), /pull_request runs must derive/u);
  });

  await t.test("a cache dir outside RUNNER_TEMP or overlapping the repo is refused", () => {
    const root = temporary("prepare-escape");
    const runnerTemp = join(root, "runner-temp");
    mkdirSync(runnerTemp, { recursive: true });
    const repo = join(root, "repo");
    mkdirSync(join(repo, "cache"), { recursive: true });
    const outside = join(root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    for (const bad of [outside, join(repo, "cache")]) {
      assert.throws(() => buildPrepareArguments({
        GITHUB_EVENT_NAME: "push",
        REPOSITORY_ROOT: repo,
        RUNNER_TEMP: runnerTemp,
        ABLOH_COVERAGE_PROVIDER_CACHE_DIR: bad,
      }), /coverage cache/u);
    }
  });

  await t.test("a failing CLI prepare warns and exits 0; boundary errors still fail", async () => {
    const root = temporary("prepare-soft");
    const runnerTemp = join(root, "runner-temp");
    const cacheDir = join(runnerTemp, "abloh-state", "1-1", "coverage-providers-fresh");
    mkdirSync(cacheDir, { recursive: true });
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const { cli, prefix } = fakeCli(root);
    writeExecutable(join(prefix, "lib", "cli.mjs"), `#!${process.execPath}\nprocess.exit(2);\n`);
    const environment = {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: "push",
      REPOSITORY_ROOT: repo,
      RUNNER_TEMP: runnerTemp,
      ABLOH_COVERAGE_PROVIDER_CACHE_DIR: cacheDir,
      ABLOH_CLI_PATH: cli,
      ABLOH_CLI_PREFIX: prefix,
    };
    const soft = execute("prepare", environment);
    assert.equal(soft.status, 0, soft.stderr);
    assert.match(soft.stderr, /diff coverage will record cannot-attest/u);

    const broken = execute("prepare", { ...environment, ABLOH_COVERAGE_PROVIDER_CACHE_DIR: join(root, "elsewhere2") });
    assert.equal(broken.status, 2, "boundary validation failures must stay fatal");
  });
});

test("a job with no OIDC identity keeps measuring, and names the cause rather than a category", () => {
  /*
   * THE SENTENCE THIRTEEN OF FOURTEEN BORROW REPOSITORIES USED TO END ON.
   *
   * `electron/asar` run 33239137362 is the measured case: the repository's own lint, build and test
   * steps all passed and abloh's step alone FAILED, over a permission the maintainer had never been
   * asked for. Abloh does not ask for it any more and does not write it - `apps/cli/src/setup-step.ts`
   * carries the reason, which is that GitHub scopes it to a whole job and every step in it - so a
   * run without it is an ordinary run with one arm off rather than a red X.
   *
   * AND IT NAMES WHICH CAUSE (Kenneth's ruling, 2026-08-30). One line used to cover a missing
   * permission and a fork at once, which offered an edit to the one case where no edit works. The
   * two are told apart before anything is printed.
   */
  const missing = modelArmOffLine("permission-missing", { GITHUB_JOB: "unit" });
  assert.match(missing, /The model-backed arm needs an identity in the job that runs your suite/u);
  assert.match(missing, /measures mechanically/u);
  assert.match(missing, /id-token: write/u);
  assert.match(missing, /reach every step in the job/u);
  /* AND IT DOES NOT DRAG THE FORK RULE IN, because this run is not a fork run. */
  assert.equal(/from a fork/u.test(missing), false);

  const fork = modelArmOffLine("fork-policy", { GITHUB_JOB: "unit" });
  assert.match(fork, /comes from a fork/u);
  assert.match(fork, /The model-backed arm needed that identity/u);
  assert.match(fork, /GitHub's rule rather than a setting in your repository/u);
  /* AND IT ASKS FOR NO EDIT. "There is no permission to add" is the sentence saying so; what must
     never appear is an instruction to add one, which is what the two separate causes buy. */
  assert.match(fork, /no permission to add and nothing here for you to fix/u);
  assert.equal(/Add it yourself/u.test(fork), false);

  /* THE CAUSE IS KEYED ON THE MINT ENDPOINT AND THE FORK FLAG, and an identity that exists is not a
     condition at all - `null`, rather than a fourth name. */
  assert.equal(identityConditionOf({ MODEL_GATEWAY_URL: "https://api.abloh.example/model" }), "permission-missing");
  assert.equal(identityConditionOf({ ABLOH_PR_FORK: "true" }), "fork-policy");
  assert.equal(
    identityConditionOf({
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc?x=1",
    }),
    null,
  );
});

test("a run with no model gateway is admitted, and a supplied one is still validated", () => {
  /* The Action refused to start with "model-gateway-url must be a non-empty control-free string"
     on a real pull request. Nothing mechanical reaches a model — diff coverage and mutation — so
     that refused runs which would never have called one, and a repository
     wanting structural evidence with no AI could not use the Action at all.

     The boundary cannot decide this by tier: assertTrustedPullRequestInputs refuses a `tier` input
     on a pull_request outright, so the tier is unknown here by design. Absence is carried through
     instead, and a policy naming a hosted provider fails in resolveProvider with a message that
     names the missing variable. */
  const absentRoot = temporary("gateway-absent");
  const noGateway = preflightEnvironment(absentRoot, repository(absentRoot));
  delete noGateway.MODEL_GATEWAY_URL;
  delete noGateway.MODEL_GATEWAY_AUDIENCE;
  assert.equal(execute("preflight", noGateway).status, 0, "a run without a gateway must be admitted");

  /* Supplied means validated, never silently ignored: a malformed value a reader believes is in
     force has to be refused where it is written. */
  const badRoot = temporary("gateway-bad");
  const insecure = preflightEnvironment(badRoot, repository(badRoot), {
    MODEL_GATEWAY_URL: "http://insecure.example/model",
  });
  const rejected = execute("preflight", insecure);
  assert.notEqual(rejected.status, 0, "a non-HTTPS gateway is still refused");
  assert.match(rejected.stderr, /model-gateway-url/u);

  /* A URL without its audience is a half-configured gateway, not an absent one. */
  const audRoot = temporary("gateway-no-aud");
  const noAudience = preflightEnvironment(audRoot, repository(audRoot));
  delete noAudience.MODEL_GATEWAY_AUDIENCE;
  const halfConfigured = execute("preflight", noAudience);
  assert.notEqual(halfConfigured.status, 0, "a gateway URL without an audience is refused");
  assert.match(halfConfigured.stderr, /model-gateway-audience/u);
});

test("a half-configured handoff is refused BEFORE the suite runs, not after it", () => {
  /* handoff-url and handoff-audience were validated for the first time in uploadEvidence — the
     last step. So a missing audience ran the whole measurement first (baseline, coverage and
     mutation), published it to
     staging, and then threw it away on "handoff-audience must be a non-empty control-free string".
     Observed on a real run: minutes of CI spent to report an input that was knowable before the
     first test executed. */
  const pairRoot = temporary("handoff-pair");
  const halfConfigured = preflightEnvironment(pairRoot, repository(pairRoot), {
    HANDOFF_URL: "https://api.abloh.example/api/v1/orgs/acme/runs/handoff",
  });
  const refused = execute("preflight", halfConfigured);
  assert.notEqual(refused.status, 0, "a handoff URL without its audience must fail at preflight");
  assert.match(refused.stderr, /handoff-audience/u);

  /* No handoff at all is a measure-only run, which is a supported configuration. */
  const noneRoot = temporary("handoff-none");
  const measureOnly = preflightEnvironment(noneRoot, repository(noneRoot));
  assert.equal(execute("preflight", measureOnly).status, 0, "measure-only must still be admitted");

  /* Both supplied is admitted here and re-validated at the upload boundary. */
  const bothRoot = temporary("handoff-both");
  const configured = preflightEnvironment(bothRoot, repository(bothRoot), {
    HANDOFF_URL: "https://api.abloh.example/api/v1/orgs/acme/runs/handoff",
    HANDOFF_AUDIENCE: "abloh-evidence-handoff",
  });
  assert.equal(execute("preflight", configured).status, 0, "a complete handoff pair is admitted");
});

test("a base that is not on the runner is FETCHED, and only what a fetch cannot repair refuses", async (t) => {
  /*
   * WHAT THIS REPLACED, TWICE. First `git cat-file -e <sha>^{commit}` wrote nothing to stderr and
   * exited 1, so a base that is not on the runner reached the customer as
   *   `git cat-file failed: fatal: Not a valid object name <40 hex>^{commit}`
   * - a plumbing command they never ran, about an object id they never typed. Then that was
   * reworded into a refusal naming SHALLOW and `fetch-depth: 0`, which is a true sentence about a
   * run that could have worked: `actions/checkout` clones at depth 1 by DEFAULT, so this is most
   * real CI, and the commit is one bounded fetch away on the remote the checkout came from.
   *
   * So the shallow case now RUNS. What still refuses is what no fetch can produce - a commit on
   * neither the runner nor the remote - and it is still told apart from the shallow case, because
   * sending a force-push victim to edit `fetch-depth` sends them to change a file that was right.
   *
   * Real clones throughout: shallowness is a property of the object store, and a fixture that
   * merely pretended would pass against a check that never worked.
   */
  const root = temporary("base-presence");
  const origin = join(root, "origin");
  const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", origin], { encoding: "utf8" });
  g(origin, "config", "user.email", "t@t");
  g(origin, "config", "user.name", "t");
  writeFileSync(join(origin, "a.txt"), "one\n");
  g(origin, "add", "-A");
  g(origin, "commit", "-qm", "base");
  const base = g(origin, "rev-parse", "HEAD");
  /* Enough commits after the base that a depth-1 clone cannot see it, and few enough that the
     first rung of the ladder (50) reaches it. */
  for (let n = 0; n < 6; n += 1) {
    writeFileSync(join(origin, `b${n}.txt`), `${n}\n`);
    g(origin, "add", "-A");
    g(origin, "commit", "-qm", `head-${n}`);
  }

  const environment = { PATH: process.env.PATH, HOME: process.env.HOME };

  await t.test("a SHALLOW checkout is deepened until the base is diffable, not refused", () => {
    const shallow = join(root, "shallow");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin}`, shallow], { encoding: "utf8" });
    assert.equal(
      execFileSync("git", ["-C", shallow, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim(),
      "true",
      "the fixture must really be shallow, or this proves nothing",
    );
    assert.throws(
      () => execFileSync("git", ["-C", shallow, "cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" }),
      "the base must really be outside the clone depth before the deepen",
    );

    const outcome = ensureBaseCommitReachable(shallow, base, environment);
    assert.equal(outcome.state, "deepened");
    assert.ok(outcome.depth > 0, "a shallow repair is a bounded deepen, not an object fetch");
    /* END TO END: the diff the run actually needs now works, which is the whole claim. */
    assert.doesNotThrow(() =>
      execFileSync("git", ["-C", shallow, "diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }));
  });

  await t.test("a base FETCHED alone into a shallow clone has no merge base, and is deepened too", () => {
    /* The second shallow shape the audit found: preflight passed because the commit was present,
       and the run then died inside `git diff` with "no merge base". Presence is not reachability. */
    const grafted = join(root, "grafted");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin}`, grafted], { encoding: "utf8" });
    execFileSync("git", ["-C", grafted, "fetch", "-q", "--no-tags", "--depth=1", "origin", base], { encoding: "utf8" });
    assert.doesNotThrow(() =>
      execFileSync("git", ["-C", grafted, "cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" }));
    assert.throws(
      () => execFileSync("git", ["-C", grafted, "merge-base", base, "HEAD"], { stdio: "ignore" }),
      "the fixture must really have no merge base before the deepen",
    );

    assert.equal(ensureBaseCommitReachable(grafted, base, environment).state, "deepened");
    assert.doesNotThrow(() =>
      execFileSync("git", ["-C", grafted, "diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }));
  });

  await t.test("a force-pushed base still ON the remote is fetched into a full clone and runs", () => {
    /* The commit is gone from every remote BRANCH but still served by the remote, which is what a
       force-push actually leaves behind for the length of the reflog. It used to refuse; the
       declared SHA is now fetched directly, with no `--depth` so the customer's full history is
       never truncated. */
    const full = join(root, "force-pushed");
    execFileSync("git", ["clone", "-q", `file://${origin}`, full], { encoding: "utf8" });
    g(origin, "checkout", "-q", "-b", "rewritten");
    writeFileSync(join(origin, "rewrite.txt"), "rewritten\n");
    g(origin, "add", "-A");
    g(origin, "commit", "-qm", "the base as it was before the force-push");
    const rewritten = g(origin, "rev-parse", "HEAD");
    g(origin, "checkout", "-q", "main");
    g(origin, "branch", "-qD", "rewritten");
    assert.throws(
      () => execFileSync("git", ["-C", full, "cat-file", "-e", `${rewritten}^{commit}`], { stdio: "ignore" }),
      "the fixture must really be missing the commit before the fetch",
    );

    const outcome = ensureBaseCommitReachable(full, rewritten, environment);
    assert.equal(outcome.state, "deepened");
    assert.equal(outcome.depth, 0, "a full clone is repaired by an object fetch, never by --depth");
    assert.equal(
      execFileSync("git", ["-C", full, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim(),
      "false",
      "repairing a full clone must never leave it shallow",
    );
  });

  await t.test("a base on NEITHER side is a force-push, and is NOT told to change fetch-depth", () => {
    const full = join(root, "full");
    execFileSync("git", ["clone", "-q", `file://${origin}`, full], { encoding: "utf8" });
    const gone = `${"0".repeat(39)}1`;
    assert.throws(
      () => ensureBaseCommitReachable(full, gone, environment),
      (error) => {
        assert.match(error.message, /force-pushed|rewritten/, "the likely cause must be named");
        assert.doesNotMatch(error.message, /fetch-depth/, "a deeper fetch cannot bring back a commit that is gone");
        assert.match(error.message, new RegExp(gone));
        return true;
      },
    );
  });

  await t.test("a shallow checkout with no reachable base refuses with the workflow line", () => {
    /* No remote object to find, so the ladder is spent and the refusal stands - and this is the
       one place `fetch-depth: 0` is still the answer. */
    const shallow = join(root, "shallow-gone");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin}`, shallow], { encoding: "utf8" });
    const gone = `${"0".repeat(39)}2`;
    assert.throws(
      () => ensureBaseCommitReachable(shallow, gone, environment),
      (error) => {
        assert.match(error.message, new RegExp(gone));
        return true;
      },
    );
  });

  await t.test("a base that IS present passes silently, touching no network", () => {
    const full = join(root, "full-ok");
    execFileSync("git", ["clone", "-q", `file://${origin}`, full], { encoding: "utf8" });
    /* Point the remote at nothing: a checkout that already has its base must never fetch. */
    execFileSync("git", ["-C", full, "remote", "set-url", "origin", `file://${join(root, "absent")}`], { encoding: "utf8" });
    assert.equal(ensureBaseCommitReachable(full, base, environment).state, "already-reachable");
  });
});
