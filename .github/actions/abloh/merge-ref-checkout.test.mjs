/**
 * THE CENSUS ROWS WHERE ABLOH REFUSED THE DEFAULT SHAPE OF PULL-REQUEST CI, recreated as real git.
 *
 * WHAT HAPPENED (postflip-generated-c1, 2026-08-29, `product/apps/study-live/report/postflip-c1.md`).
 * Six of the fourteen borrow-road repositories died on one line - `electron/asar`,
 * `Fission-AI/OpenSpec`, `ngx-formly/ngx-formly`, `unjs/jiti`, `react-native-community/cli` and
 * `vitejs/vite`. From `OpenSpec`'s run 33226670400, `Test (linux-bash)`, verbatim:
 *
 *   PR_HEAD_SHA: ccbc6ba2bb42ecff9f57e3a50c1f39abd6f9a64d
 *   GITHUB_SHA_VALUE: 54e279c78f3a6176618e154b4c9b0f2a8c3bf6fa
 *   Abloh Action boundary: exact pull-request head required;
 *   expected ccbc6ba2bb42ecff9f57e3a50c1f39abd6f9a64d, found 54e279c78f3a6176618e154b4c9b0f2a8c3bf6fa
 *
 * The found sha is `github.sha`, which on a `pull_request` event is GitHub's own test-merge commit,
 * and `actions/checkout` with no `ref:` checks out `refs/pull/N/merge` - that commit. The borrow
 * road appends Abloh's step to the maintainer's own job, so Abloh inherits their checkout. The
 * product was refusing the ordinary shape of the thing it exists to measure.
 *
 * EVERY FIXTURE HERE IS A REAL REPOSITORY WITH A REAL MERGE COMMIT. Nothing is described: the
 * lineage the boundary proves is git's own record, so a fixture that asserted parents rather than
 * creating them would prove nothing about the read that has to find them.
 *
 * WHAT IS HELD. That the merge-ref checkout is admitted and reported as the HEAD sha; that a merge
 * which rewrote a file the pull request also changes is still refused, because that is the case the
 * original equality check was right about; that a checkout which is neither is refused; and that
 * every refusal carries the one-line edit. The full argument is in
 * `packages/core/src/merge-ref-checkout.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

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
 * A repository whose HEAD is GitHub's merge commit, exactly as `refs/pull/N/merge` gives it.
 *
 * THE PARENT ORDER IS GITHUB'S: base first, head second. `git merge <head>` while ON the base
 * produces that order, which is why the fixture merges rather than assembling a commit by hand -
 * an order the boundary reads out of a real merge is the order it will read on a real runner.
 */
function mergeRefRepository({ baseAlsoTouches = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "abloh-merge-ref-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const repo = join(workspace, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Abloh Test");
  git(repo, "config", "user.email", "test@abloh.invalid");
  writeFileSync(join(repo, "package.json"), '{"name":"demo","scripts":{"test":"node --test"}}\n');
  /* NINE LINES, and the two sides below edit the first and the last of them. Git conflicts on
     changes to ADJACENT lines, and GitHub never publishes `refs/pull/N/merge` for a conflicting
     pull request - so a fixture whose edits collide would be testing a shape that cannot reach the
     runner. What has to be modelled is the CLEAN merge that still rewrites the file. */
  writeFileSync(join(repo, "subject.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
  writeFileSync(join(repo, "elsewhere.txt"), "untouched\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "root");
  const root0 = git(repo, "rev-parse", "HEAD");

  /* The contributor's branch: the pull request's own commit. */
  git(repo, "checkout", "-q", "-b", "contributor");
  writeFileSync(join(repo, "subject.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\n");
  git(repo, "add", "subject.txt");
  git(repo, "commit", "-qm", "the pull request");
  const head = git(repo, "rev-parse", "HEAD");

  /* The base branch moving on, which is what makes the merge commit's tree differ from head's.
     `baseAlsoTouches` decides WHICH file it moves, and that is the whole difference between a
     merge Abloh can measure and one it must refuse. */
  git(repo, "checkout", "-q", "main");
  const movedFile = baseAlsoTouches ?? "elsewhere.txt";
  writeFileSync(
    join(repo, movedFile),
    movedFile === "subject.txt"
      ? "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n"
      : "moved on\n",
  );
  git(repo, "add", movedFile);
  git(repo, "commit", "-qm", "base moves on");
  const base = git(repo, "rev-parse", "HEAD");

  /* GitHub's test merge. Detached, exactly as `refs/pull/N/merge` is checked out. */
  git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request", "contributor");
  const merge = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "--detach", merge);
  return { root, workspace, repo, root0, base, head, merge };
}

/**
 * THE BASE-SIDE RENAME, which is the same unsound merge reached by a NAME rather than by a blob.
 *
 * THE AUDIT'S OWN REPRO (assumption audit, 2026-08-29, rank 25), rebuilt as real git: an ancestor
 * holding `old.txt`, a base branch that renames it to `new.txt`, a pull request that edits
 * `old.txt`, and GitHub's clean merge - git applies the edit to the renamed path, so the merge tree
 * holds `new.txt` and NO `old.txt` at all.
 *
 * WHY IT WAS ADMITTED. With git's default rename detection the two reads name that one file
 * differently: `base...head` reports `old.txt` and `head..merge` reports `new.txt`. The
 * intersection is empty, gate (3) is vacuously satisfied, and the boundary answers `merge-ref` for
 * a tree that does not contain the pull request's path. The evidence then claims to have measured
 * `old.txt`, which was never executed. The audit reproduced exactly that with:
 *
 *   $ git diff --name-only <ancestor>...<head>   -> old.txt
 *   $ git diff --name-only <head> <merge>        -> new.txt
 *   classifyPullRequestCheckout(...)             -> { kind: 'merge-ref' }
 *
 * `--no-renames` on both reads is what makes the merge report `old.txt` AND `new.txt`, so the
 * intersection finds `old.txt` and the checkout is refused with the same remedy as any other merge
 * that rewrote a changed file.
 */
function baseRenameRepository() {
  const root = mkdtempSync(join(tmpdir(), "abloh-merge-ref-rename-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const repo = join(workspace, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Abloh Test");
  git(repo, "config", "user.email", "test@abloh.invalid");
  writeFileSync(join(repo, "package.json"), '{"name":"demo","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(repo, "old.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "root");
  const root0 = git(repo, "rev-parse", "HEAD");

  /* The pull request edits the file under its OLD name, because that is the name on its branch. */
  git(repo, "checkout", "-q", "-b", "contributor");
  writeFileSync(join(repo, "old.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\n");
  git(repo, "add", "old.txt");
  git(repo, "commit", "-qm", "the pull request");
  const head = git(repo, "rev-parse", "HEAD");

  /* The base branch renames it, and changes nothing else - so the merge is clean and the ONLY
     difference between the head tree and the merge tree is which name the bytes live under. */
  git(repo, "checkout", "-q", "main");
  git(repo, "mv", "old.txt", "new.txt");
  git(repo, "commit", "-qm", "base renames the file");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request", "contributor");
  const merge = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "--detach", merge);
  return { root, workspace, repo, root0, base, head, merge };
}

/** A repository whose HEAD IS the pull request's head - the shape that always worked. */
function headRepository() {
  const fixture = mergeRefRepository();
  git(fixture.repo, "checkout", "-q", "--detach", fixture.head);
  return fixture;
}

/**
 * Stubs for the three tools the preflight requires on PATH, so this file tests the identity proof
 * and not Docker. `git` is the real one: everything being proved is git's own record.
 */
function toolPath(root) {
  const bin = join(root, "stub-bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ["npm", '#!/bin/sh\nexit 0\n'],
    ["docker", '#!/bin/sh\nexit 0\n'],
  ]) {
    const path = join(bin, name);
    writeFileSync(path, body);
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
      GITHUB_SHA_VALUE: fixture.merge,
      PR_HEAD_SHA: fixture.head,
      PR_BASE_SHA: fixture.base,
      DECLARED_BASE: "",
      GITHUB_RUN_ID: "33226670400",
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
  return { ...result, fields };
}

/* ------------------------------------------------------------------ the row */

test("OpenSpec's row: a merge-ref checkout is admitted and reported as the HEAD sha", () => {
  const fixture = mergeRefRepository();
  assert.notEqual(fixture.merge, fixture.head, "the fixture must actually be a merge checkout");
  const result = preflight(fixture);
  assert.equal(result.status, 0, result.stderr);
  /* THE SEAL IS UNCHANGED. `head` is what the artifact's `target.sha`, the control plane's
     `provenance.headSha` and the check run's `head_sha` all become - so a merge sha here would put
     the customer's check on a commit that is not on their branch. */
  assert.equal(result.fields.head, fixture.head);
  assert.equal(result.fields.base, fixture.base);
  /* AND IT SAYS WHAT IT DID. A run that silently accepted a different commit than the one it
     reports would be the thing the old equality check was protecting against. */
  assert.match(result.stdout, /GitHub's merge of this pull request/u);
  assert.match(result.stdout, new RegExp(fixture.head.slice(0, 12), "u"));
});

test("the sentence that lost six repositories is gone", () => {
  const result = preflight(mergeRefRepository());
  assert.doesNotMatch(result.stderr, /exact pull-request head required/u);
});

test("an exact head checkout is unchanged, and pays nothing for any of this", () => {
  const fixture = headRepository();
  const result = preflight(fixture, { GITHUB_SHA_VALUE: fixture.head });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.fields.head, fixture.head);
  assert.doesNotMatch(result.stdout, /GitHub's merge/u, "no merge narration on a head checkout");
});

/* ------------------------------------------------------------------ what it still refuses */

test("a merge that rewrote a file the pull request also changes is still refused", () => {
  /* THE CASE THE ORIGINAL RULE WAS RIGHT ABOUT. Here `subject.txt` moved on BOTH sides, so the
     merge's blob is neither side's bytes - the diff would describe head's lines while the providers
     read the merge's. That is exactly "the diff describes one tree while the providers measure
     another", and it is the one shape a merge-ref checkout must not be measured in. */
  const fixture = mergeRefRepository({ baseAlsoTouches: "subject.txt" });
  const result = preflight(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /the merge rewrote a file the pull request also changes/u);
  assert.match(result.stderr, /subject\.txt/u, "the refusal names the file");
  assert.match(result.stderr, /github\.event\.pull_request\.head\.sha/u, "the remedy contract");
});

test("a merge that renamed a file the pull request changes is refused, not admitted", () => {
  const fixture = baseRenameRepository();

  /* THE FIXTURE IS THE AUDIT'S, PROVED AS GIT RATHER THAN ASSERTED. The merge tree must hold the
     new name and not the old one, or the false admission this pins is not the shape being built. */
  const inMerge = git(fixture.repo, "ls-tree", "-r", "--name-only", fixture.merge).split("\n");
  assert.ok(inMerge.includes("new.txt"), "the merge tree carries the renamed path");
  assert.ok(!inMerge.includes("old.txt"), "and does not carry the pull request's own path");

  /* AND THE DEFECT'S MECHANISM, so a future reader can see WHY it was admitted rather than only
     that it now is not: with rename detection on, the two lists share no name at all. */
  const withRenames = (...range) =>
    git(fixture.repo, "diff", "--name-only", ...range).split("\n").filter((line) => line !== "");
  assert.deepEqual(withRenames(`${fixture.base}...${fixture.head}`), ["old.txt"]);
  assert.deepEqual(withRenames(fixture.head, fixture.merge), ["new.txt"]);

  const result = preflight(fixture);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /the merge rewrote a file the pull request also changes/u);
  assert.match(result.stderr, /old\.txt/u, "the refusal names the pull request's own path");
  assert.match(result.stderr, /github\.event\.pull_request\.head\.sha/u, "the remedy contract");
});

test("a checkout that is not this run's commit is refused, however plausible its lineage", () => {
  const fixture = mergeRefRepository();
  /* The lineage is real - this IS a merge of the two shas - but `github.sha` says GitHub started
     the run somewhere else, so nothing ties what is on disk to the event the shas came from. */
  const result = preflight(fixture, { GITHUB_SHA_VALUE: fixture.root0 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /neither this pull request's head .* nor the commit GitHub started this run on/su);
});

test("with no github.sha at all, a checkout that is not the head cannot be proven", () => {
  const fixture = mergeRefRepository();
  const result = preflight(fixture, { GITHUB_SHA_VALUE: "" });
  assert.equal(result.status, 2);
  /* AN ABSENT FACT IS NOT A WAIVER. Without the trigger sha, "a merge of those two commits" cannot
     become "THIS RUN's merge of them", and the second half is the half that binds it to the event. */
  assert.match(result.stderr, /nor the commit GitHub started this run on/u);
});

test("a merge whose second parent is not this pull request's head is refused", () => {
  const fixture = mergeRefRepository();
  /* Same checkout, but the event claims a different head. Nothing about the tree changed; what
     changed is whether git's record agrees with what the pull request says it is. */
  const result = preflight(fixture, { PR_HEAD_SHA: fixture.root0 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /is not a merge of this pull request's base .* and head/su);
});
