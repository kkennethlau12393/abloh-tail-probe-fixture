/**
 * THE ACTION'S DIAGNOSTIC SWEEP, and the one refusal it is allowed to run past.
 *
 * WHY THE INPUT EXISTS (`sweep-cannot-run-in-job.md`, census branch, 2026-08-29). `--sweep` is a
 * flag on `abloh run`, and in a customer's CI nothing invokes `abloh run` except this Action, which
 * builds its own argv from its own inputs. None of the thirteen was `sweep`, so no workflow -
 * a customer's or the census's - had any way to ask the in-job step for the ledger that says which
 * stages would have worked. The only route was to edit the argv this Action assembles, which would
 * have measured a product nobody ships.
 *
 * THE RULING THIS FILE ALSO HOLDS (Kenneth, 2026-08-29). A sweep MAY run after an IDENTITY-class
 * boundary refusal - the checkout is not the commit the pull request names, or the runtime is older
 * than Abloh supports - recorded as a clearly-labelled non-attesting diagnostic with the refusal
 * logged first. It must NEVER run after a seal-integrity refusal. The allow-list is
 * `IDENTITY_CLASS_REFUSALS` in the boundary; these tests hold both halves of it, because a rule
 * that only ever gets tested on the side that permits is a rule with no line in it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { buildRunArguments, sweepRequested } from "./action-boundary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOUNDARY = join(HERE, "action-boundary.mjs");
const ACTION = join(HERE, "action.yml");

const roots = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** The merge-ref fixture, and a knob for making the merge rewrite a changed file. */
function repository({ baseAlsoTouches = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "abloh-sweep-input-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const repo = join(workspace, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Abloh Test");
  git(repo, "config", "user.email", "test@abloh.invalid");
  writeFileSync(join(repo, "package.json"), '{"name":"demo","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(repo, "subject.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
  writeFileSync(join(repo, "elsewhere.txt"), "untouched\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "root");
  const root0 = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "contributor");
  writeFileSync(join(repo, "subject.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\n");
  git(repo, "add", "subject.txt");
  git(repo, "commit", "-qm", "the pull request");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  const moved = baseAlsoTouches ?? "elsewhere.txt";
  writeFileSync(
    join(repo, moved),
    moved === "subject.txt"
      ? "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n"
      : "moved on\n",
  );
  git(repo, "add", moved);
  git(repo, "commit", "-qm", "base moves on");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request", "contributor");
  const merge = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "--detach", merge);
  return { root, workspace, repo, root0, base, head, merge };
}

function toolPath(root) {
  const bin = join(root, "stub-bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["npm", "docker"]) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  return `${bin}:${process.env.PATH ?? ""}`;
}

function preflight(fixture, overrides = {}) {
  const output = join(fixture.root, `github-output-${Math.abs(hash(JSON.stringify(overrides)))}`);
  writeFileSync(output, "", { mode: 0o600 });
  const runnerTemp = join(fixture.root, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  const result = spawnSync(process.execPath, [BOUNDARY, "preflight"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: toolPath(fixture.root),
      GITHUB_ACTION_PATH: HERE,
      GITHUB_OUTPUT: output,
      GITHUB_WORKSPACE: fixture.workspace,
      RUNNER_TEMP: runnerTemp,
      REPO_PATH: "repo",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA_VALUE: fixture.merge,
      PR_HEAD_SHA: fixture.head,
      PR_BASE_SHA: fixture.base,
      DECLARED_BASE: "",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      MODEL_GATEWAY_URL: "https://api.abloh.example/api/v1/model/chat/completions",
      MODEL_GATEWAY_AUDIENCE: "https://api.abloh.example/model",
      ...overrides,
    },
  });
  const fields = Object.fromEntries(
    readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  return { ...result, fields, runnerTemp };
}

/** A stable per-case suffix so two preflights in one fixture do not append to one output file. */
function hash(value) {
  let out = 0;
  for (const character of value) out = (out * 31 + character.charCodeAt(0)) | 0;
  return out;
}

/* ------------------------------------------------------------------ the input */

test("the sweep input reaches the CLI as --sweep, and is off unless asked for", () => {
  const root = mkdtempSync(join(tmpdir(), "abloh-sweep-argv-"));
  roots.push(root);
  const repo = join(root, "repo");
  const runnerTemp = join(root, "runner-temp");
  const outputDirectory = join(runnerTemp, "abloh", "1-1");
  mkdirSync(repo, { recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  const environment = {
    GITHUB_EVENT_NAME: "pull_request",
    REPOSITORY_ROOT: repo,
    BASE: "b".repeat(40),
    HEAD_SHA: "a".repeat(40),
    RUNNER_TEMP: runnerTemp,
    ABLOH_OUTPUT_DIR: outputDirectory,
    ABLOH_BASELINE_HISTORY_DIR: join(runnerTemp, "abloh-state", "1-1", "baseline-history"),
    ABLOH_COVERAGE_PROVIDER_CACHE_DIR: join(runnerTemp, "abloh-state", "1-1", "coverage-providers-fresh"),
    ABLOH_V2_STORE_DIR: join(runnerTemp, "abloh-state", "1-1", "engine-v2"),
    ABLOH_TRIAGE_CACHE_DIR: join(runnerTemp, "abloh-state", "1-1", "triage-cache"),
  };
  for (const dir of [
    environment.ABLOH_BASELINE_HISTORY_DIR,
    environment.ABLOH_COVERAGE_PROVIDER_CACHE_DIR,
    environment.ABLOH_V2_STORE_DIR,
    environment.ABLOH_TRIAGE_CACHE_DIR,
  ]) mkdirSync(dir, { recursive: true });

  assert.ok(!buildRunArguments({ ...environment }).includes("--sweep"), "off by default");
  assert.ok(!buildRunArguments({ ...environment, SWEEP: "false" }).includes("--sweep"));
  const swept = buildRunArguments({ ...environment, SWEEP: "true" });
  assert.ok(swept.includes("--sweep"));
  /* THE LEDGER NEEDS NO PATH OF ITS OWN: the CLI writes it beside where `--json` points, and that
     is the runner-temporary directory a collecting harness already takes. */
  const jsonAt = swept.indexOf("--json");
  assert.ok(jsonAt > 0);
  /* Compared by suffix: `buildRunArguments` canonicalises the output directory, and on macOS
     `/var/folders/...` canonicalises to `/private/var/folders/...`. What matters is that the file
     sits in the run's own runner-temporary directory, which is what a harness collects. */
  assert.ok(
    swept[jsonAt + 1].endsWith(join("abloh", "1-1", "attest-results.json")),
    swept[jsonAt + 1],
  );
});

test("a sweep value that is neither true nor false is an error, not a truthy string", () => {
  assert.equal(sweepRequested({ SWEEP: "" }), false);
  assert.equal(sweepRequested({ SWEEP: "false" }), false);
  assert.equal(sweepRequested({ SWEEP: "TRUE" }), true);
  assert.throws(() => sweepRequested({ SWEEP: "yes" }), /sweep must be 'true' or 'false'/u);
});

test("the composite action declares the input and passes it to both steps that need it", () => {
  /* READ AS TEXT, not through a YAML parser. The Action ships as plain files onto a customer's
     runner with no dependencies at all, so this package has none - `workflow-shape.test.mjs` lints
     the published workflow the same way and for the same reason: what runs is the bytes. */
  const source = readFileSync(ACTION, "utf8");
  assert.match(source, /^ {2}sweep:\n/mu, "the input must be declared");
  assert.match(source, /^ {4}default: 'false'$/mu, "a diagnostic is never the default");
  /* BOTH STEPS, and each for its own reason: the run step so the flag reaches the CLI, and the
     preflight so the identity-class ruling can be applied where the refusal happens. */
  const passes = [...source.matchAll(/^ {8}SWEEP: \$\{\{ inputs\.sweep \}\}$/gmu)];
  assert.equal(passes.length, 2, "the preflight and the run step both read it");
  const preflightAt = source.indexOf("id: environment_preflight");
  const runAt = source.indexOf("- name: Run Abloh");
  const [first, second] = passes.map((match) => match.index);
  assert.ok(first > preflightAt && first < runAt, "the preflight step reads it");
  assert.ok(second > runAt, "the run step reads it");
});

/* ------------------------------------------------------------------ the ruling */

test("an identity refusal WITH a sweep continues, labelled as attesting nothing", () => {
  /* The identity-class case: a merge that rewrote a file the pull request also changes. Without a
     sweep this refuses (held below); with one, the diagnostic runs. */
  const fixture = repository({ baseAlsoTouches: "subject.txt" });
  const result = preflight(fixture, { SWEEP: "true" });
  assert.equal(result.status, 0, result.stderr);
  /* THE REFUSAL IS LOGGED FIRST. The ruling's own words: the log must read as "this was refused,
     and here is a diagnostic about it", never as a run that simply happened. */
  assert.match(result.stderr, /Abloh Action boundary: .*the merge rewrote a file/u);
  assert.match(result.stdout, /THIS RUN ATTESTS NOTHING/u);
  assert.equal(result.fields.attesting, "false");
  /* AND IT SWEEPS THE TREE THAT IS ACTUALLY HERE. Claiming to be about the head commit would be the
     false label the whole boundary exists to prevent. */
  assert.equal(result.fields.head, fixture.merge);
});

test("the refusal a sweep ran past is filed beside the ledger it precedes", () => {
  const fixture = repository({ baseAlsoTouches: "subject.txt" });
  const result = preflight(fixture, { SWEEP: "true" });
  assert.equal(result.status, 0, result.stderr);
  const filed = join(result.fields["output-dir"], "abloh-sweep-preceding-refusal.json");
  assert.ok(existsSync(filed), "a collected directory must carry the wall that made it a diagnostic");
  const record = JSON.parse(readFileSync(filed, "utf8"));
  assert.equal(record.attesting, false);
  assert.equal(record.class, "checkout-identity");
  assert.match(record.reason, /the merge rewrote a file/u);
  assert.match(record.remedy, /github\.event\.pull_request\.head\.sha/u);
});

test("the same refusal WITHOUT a sweep still stops the run", () => {
  const fixture = repository({ baseAlsoTouches: "subject.txt" });
  const result = preflight(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /the merge rewrote a file/u);
  assert.doesNotMatch(result.stdout, /THIS RUN ATTESTS NOTHING/u);
});

test("a seal-integrity refusal is NEVER swept past, however loudly a sweep was asked for", () => {
  const fixture = repository();
  /*
   * THE LINE IN THE RULING. Each of these is about the seal rather than about identity: the wrong
   * event entirely, and an input a pull request is using to select its own measurement settings.
   * A diagnostic that ran past one of these would be the product doing the thing it just refused.
   */
  const sealRefusals = [
    [{ GITHUB_EVENT_NAME: "pull_request_target" }, /pull_request_target is unsafe/u],
    [{ GITHUB_EVENT_NAME: "push" }, /Abloh measures pull requests/u],
    [{ TIER: "0" }, /tier/u],
    [{ SEED: "abc123" }, /seed/u],
    [{ ENVIRONMENT_IMAGE: "img@sha256:" + "0".repeat(64) }, /environment-image/u],
    [{ RECORD_NETWORK: "recordings.json" }, /record-network/u],
  ];
  for (const [overrides, expected] of sealRefusals) {
    const result = preflight(fixture, { SWEEP: "true", ...overrides });
    assert.equal(result.status, 2, `${JSON.stringify(overrides)} must stop the run: ${result.stdout}`);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(
      result.stdout,
      /THIS RUN ATTESTS NOTHING/u,
      `${JSON.stringify(overrides)} is a seal refusal and must not become a diagnostic`,
    );
  }
});

test("a sweep changes nothing about a run that was never refused", () => {
  const fixture = repository();
  const result = preflight(fixture, { SWEEP: "true" });
  assert.equal(result.status, 0, result.stderr);
  /* THE ORDINARY MERGE-REF RUN. It is admitted on its own proof, so the head is the pull request's
     head and the run attests - the sweep only decides what the CLI does with the stages. */
  assert.equal(result.fields.head, fixture.head);
  assert.equal(result.fields.attesting, "true");
  assert.doesNotMatch(result.stdout, /THIS RUN ATTESTS NOTHING/u);
  assert.equal(
    existsSync(join(result.fields["output-dir"], "abloh-sweep-preceding-refusal.json")),
    false,
    "nothing was refused, so there is no refusal to file",
  );
});
