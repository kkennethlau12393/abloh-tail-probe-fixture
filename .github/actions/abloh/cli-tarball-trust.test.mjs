/**
 * WHO MEASURES THE PULL REQUEST IS NOT THE PULL REQUEST'S TO DECIDE.
 *
 * WHAT THIS FIXES (assumption audit, 2026-08-29, rank 19 / AUTH-18). `cli-tarball` names npm specs
 * the Action installs into a private prefix and then EXECUTES as `bin/abloh`, with the renamed
 * `MODEL_OIDC_REQUEST_*` credentials in that process's environment and with whatever it writes
 * trusted as this run's evidence. It was absent from the list of inputs a `pull_request` run
 * refuses - the list that already holds `tier`, `policy`, `seed`, `environment-image`,
 * `test-command` and both recording inputs - even though it is strictly more powerful than any of
 * them: those weaken a measurement, this replaces the thing that does the measuring.
 *
 * THE CONTRACT, in one sentence: a `cli-tarball` is admitted only when the pull request changes no
 * CI definition, so its value came from the base branch rather than from the pull request. The full
 * argument - including why the input is not simply deleted, and what the rule does not cover - is
 * at `admitCliOverride` in `action-boundary.mjs`.
 *
 * FIXTURES ARE REAL GIT, because the rule is a fact about a diff and a described diff would prove
 * nothing about the read that has to take it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOUNDARY = join(HERE, "action-boundary.mjs");

const roots = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A head checkout of a pull request that changes exactly the paths it is given.
 *
 * The base branch already carries a workflow, so "the pull request did not change a CI definition"
 * is a real statement about a repository that HAS one rather than about a repository with none.
 */
function pullRequest({ changes }) {
  const root = mkdtempSync(join(tmpdir(), "abloh-cli-tarball-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const repo = join(workspace, "repo");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Abloh Test");
  git(repo, "config", "user.email", "test@abloh.invalid");
  writeFileSync(join(repo, "package.json"), '{"name":"demo","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: ci\non: pull_request\n");
  writeFileSync(join(repo, "src.js"), "export const one = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "-q", "-b", "contributor");
  for (const [path, body] of Object.entries(changes)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "the pull request");
  const head = git(repo, "rev-parse", "HEAD");
  return { root, workspace, repo, base, head };
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
  const output = join(fixture.root, "github-output");
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
      GITHUB_SHA_VALUE: fixture.head,
      PR_HEAD_SHA: fixture.head,
      PR_BASE_SHA: fixture.base,
      DECLARED_BASE: "",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      ...overrides,
    },
  });
  const fields = Object.fromEntries(
    readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  return { ...result, fields };
}

/* ------------------------------------------------------------------ what is refused */

test("a pull request that edits the workflow may not also choose the CLI", () => {
  const fixture = pullRequest({
    changes: { ".github/workflows/ci.yml": "name: ci\non: pull_request\n# and a tarball input\n" },
  });
  const result = preflight(fixture, { CLI_TARBALL: "./contributor.tgz" });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /may only come from the base branch/u);
  assert.match(result.stderr, /\.github\/workflows\/ci\.yml/u, "the refusal names what it read");
  assert.match(result.stderr, /land the CI change on the base branch first/u, "and what to do");
});

test("a local composite action anywhere in the diff refuses the same way", () => {
  /* A workflow that is not itself changed can still invoke `./tools/abloh-wrapper`, so the file
     that would pass the input is the action definition rather than the workflow. */
  const fixture = pullRequest({ changes: { "tools/abloh-wrapper/action.yml": "runs:\n  using: composite\n" } });
  const result = preflight(fixture, { CLI_TARBALL: "https://evil.example/abloh.tgz" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /tools\/abloh-wrapper\/action\.yml/u);
});

test("the refusal happens before any private staging is created", () => {
  /* A refusal about WHO measures must cost nothing beyond the reads that were needed anyway - and
     leaving an output directory behind would make a rerun's `leafMustBeNew` collide. */
  const fixture = pullRequest({ changes: { ".github/workflows/ci.yml": "name: ci\non: pull_request\n#\n" } });
  const result = preflight(fixture, { CLI_TARBALL: "./x.tgz" });
  assert.equal(result.status, 2);
  assert.equal(result.fields["output-dir"], undefined, "nothing was staged and nothing was emitted");
});

/* ------------------------------------------------------------------ what is still admitted */

test("the census's shape is admitted: the workflow is the base's and the head reverts source", () => {
  /*
   * THE ONE REAL CONSUMER (`apps/study-live`). It commits the edited workflow, `cli-tarball` and
   * all, to the fork's DEFAULT BRANCH, and its head branch reverts a source fix and nothing else -
   * so the value in the running workflow is the base branch's, which is what this rule requires.
   */
  const fixture = pullRequest({ changes: { "src.js": "export const one = 2;\n" } });
  const result = preflight(fixture, { CLI_TARBALL: "./.abloh-census/engine/abloh-cli.tgz ./.abloh-census/engine/core.tgz" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.fields["cli-tarball"],
    "./.abloh-census/engine/abloh-cli.tgz ./.abloh-census/engine/core.tgz",
    "the admitted value is echoed for the install step to read",
  );
});

test("a run that asks for nothing pays nothing and emits an empty admission", () => {
  const fixture = pullRequest({ changes: { ".github/workflows/ci.yml": "name: ci\non: pull_request\n#\n" } });
  /* THE SAME PULL REQUEST THAT WAS REFUSED ABOVE, with the input absent: editing your own CI is
     ordinary work and must stay ordinary. The rule is about the input, never about the diff. */
  const result = preflight(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.fields["cli-tarball"], "");
});

/* ------------------------------------------------------------------ the wiring that carries it */

test("action.yml installs the admitted output and never the raw input", () => {
  const yaml = readFileSync(join(HERE, "action.yml"), "utf8");
  const install = yaml.slice(yaml.indexOf("- name: Install Abloh CLI"));
  assert.match(
    install.slice(0, install.indexOf("- name: Prepare coverage")),
    /CLI_TARBALL: \$\{\{ steps\.environment_preflight\.outputs\.cli-tarball \}\}/u,
    "the install step must read the boundary's admission",
  );
  assert.match(
    yaml,
    /CLI_TARBALL: \$\{\{ inputs\.cli-tarball \}\}/u,
    "and the raw input must reach the preflight, which is what decides",
  );
  assert.match(
    yaml,
    /IT MUST COME FROM THE BASE BRANCH/u,
    "the contract is stated where a caller reads the input",
  );
});
