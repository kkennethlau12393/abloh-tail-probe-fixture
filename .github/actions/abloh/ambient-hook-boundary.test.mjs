/**
 * THE TRUSTED BOOTSTRAP BOUNDARY: NOTHING OF THE REPOSITORY'S RUNS BEFORE THE ACTION'S OWN CODE.
 *
 * WHAT THIS PINS (assumption audit, 2026-08-29, rank 2 / AUTH-20). A composite action is inlined
 * into the caller's job, so it inherits the workflow's and the job's `env:` maps - and GitHub
 * restricts only what `$GITHUB_ENV` may set, never `env:` itself. An exact search over the Action
 * at `5c9270ef` found no handling of either hook at either layer:
 *
 *   $ rg -n 'BASH_ENV|NODE_OPTIONS' product/apps/action/action.yml product/apps/action/action-boundary.mjs
 *   (no matches)
 *
 * and both reproduced in one line each:
 *
 *   $ BASH_ENV=<(printf 'printf "BASH_ENV_EXECUTED\n"\n') bash -c ':'
 *   BASH_ENV_EXECUTED
 *   $ NODE_OPTIONS='--import=data:text/javascript,console.log(%22NODE_OPTIONS_EXECUTED%22)' node -e ''
 *   NODE_OPTIONS_EXECUTED
 *
 * So repository-selected code ran with the raw inherited job environment - including the renamed
 * OIDC request credentials - before any input check or credential scrub. `unset` inside a run step
 * cannot fix it: by the time a run step has a first line, the hook has already fired.
 *
 * EVERY EXECUTION TEST BELOW RUNS THE SHELL COMMAND THIS FILE READS OUT OF `action.yml`, and each
 * one carries its NEGATIVE CONTROL: the same fixture through GitHub's default `bash --noprofile
 * --norc -eo pipefail`, which must still be hijacked. A guard that passes because the fixture is
 * inert proves nothing, and this is the exact failure `docs/lessons/verifying-rules.md` is about.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { neutralizeAmbientInterpreterHooks } from "./action-boundary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTION_YML = readFileSync(join(HERE, "action.yml"), "utf8");
const BOUNDARY_SOURCE = readFileSync(join(HERE, "action-boundary.mjs"), "utf8");

const roots = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "abloh-ambient-hook-"));
  roots.push(root);
  return root;
}

/**
 * Every `run:` step in `action.yml`, as its declared shell command and its script body.
 *
 * PARSED FROM THE FILE RATHER THAN LISTED HERE, because a step added tomorrow with `shell: bash`
 * is exactly the regression this file exists to catch, and a hand-written list would not see it.
 * The parse is deliberately dumb - two-space step keys at a fixed indent - for the reason the
 * merge-ref parity test gives about clever parsers being a third thing that can be wrong.
 */
function runSteps() {
  const lines = ACTION_YML.split("\n");
  const steps = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^    - name: /u.test(line)) {
      if (current !== null) steps.push(current);
      current = { name: line.slice("    - name: ".length).trim(), shell: null, body: [] };
      continue;
    }
    if (current === null) continue;
    const shell = /^      shell: (.*)$/u.exec(line);
    if (shell !== null) current.shell = shell[1];
    if (line === "      run: |") {
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (!lines[cursor].startsWith("        ") && lines[cursor].trim() !== "") break;
        current.body.push(lines[cursor].slice(8));
      }
    }
  }
  if (current !== null) steps.push(current);
  return steps.filter((step) => step.body.length > 0);
}

/** The eight names the boundary declares, read out of its own list rather than repeated here. */
function declaredHooks() {
  const at = BOUNDARY_SOURCE.indexOf("const AMBIENT_INTERPRETER_HOOKS = [");
  assert.ok(at > 0, "action-boundary.mjs must declare AMBIENT_INTERPRETER_HOOKS");
  const block = BOUNDARY_SOURCE.slice(at, BOUNDARY_SOURCE.indexOf("];", at));
  return [...block.matchAll(/"([A-Z][A-Z0-9_]*)"/gu)].map(([, name]) => name);
}

/** The `shell:` command as an argv, with `{0}` replaced by the script this fixture wrote. */
function shellArgv(shell, scriptPath) {
  return shell.split(/\s+/u).map((token) => (token === "{0}" ? scriptPath : token));
}

function runScript(argv, environment) {
  const [command, ...args] = argv;
  return spawnSync(command, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...environment },
  });
}

/* ------------------------------------------------------------------ the file's shape */

test("every run step neutralizes every declared hook before its interpreter starts", () => {
  const hooks = declaredHooks();
  assert.deepEqual(
    hooks,
    ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE"],
    "the set is the claim; changing it changes what the comment above it promises",
  );
  const steps = runSteps();
  assert.ok(steps.length >= 9, `expected the Action's run steps, found ${steps.length}`);
  for (const step of steps) {
    assert.ok(step.shell !== null, `${step.name}: every run step must declare its shell`);
    for (const hook of hooks) {
      assert.ok(
        step.shell.includes(`-u ${hook} `),
        `${step.name}: the shell command must strip ${hook} before bash reads it`,
      );
    }
    /* THE SHELL SEMANTICS ARE UNCHANGED. `env -u` is a prefix on GitHub's own invocation, not a
       replacement for it: dropping `--noprofile --norc` would open the startup files this closes,
       and dropping `-eo pipefail` would silently make every script below stop failing. */
    assert.match(
      step.shell,
      /^env(?: -u [A-Z][A-Z0-9_]*)+ bash --noprofile --norc -eo pipefail \{0\}$/u,
      `${step.name}: the shell must remain GitHub's bash invocation behind an env -u prefix`,
    );
    assert.equal(
      step.body[0],
      'while read -r _ _ abloh_fn; do unset -f "$abloh_fn" || :; done < <(declare -F)',
      `${step.name}: the imported-function purge must be the first line, before anything is called`,
    );
  }
});

test("no run step is left on a plain `shell: bash`", () => {
  assert.ok(
    !/^      shell: bash\s*$/mu.test(ACTION_YML),
    "a step on GitHub's default bash inherits BASH_ENV, which is the whole defect",
  );
});

/* ------------------------------------------------------------------ BASH_ENV, reproduced */

test("BASH_ENV cannot execute before a step's first line, and the fixture proves it could", () => {
  const root = scratch();
  const hook = join(root, "hook.sh");
  writeFileSync(hook, 'printf "BASH_ENV_EXECUTED\\n"\n');
  const script = join(root, "step.sh");
  const step = runSteps()[0];
  writeFileSync(script, `${step.body[0]}\nset -euo pipefail\nprintf "STEP_RAN\\n"\n`);

  const guarded = runScript(shellArgv(step.shell, script), { BASH_ENV: hook });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /STEP_RAN/u, "the step itself must still run");
  assert.doesNotMatch(guarded.stdout, /BASH_ENV_EXECUTED/u, "nothing of the caller's ran first");

  /* THE NEGATIVE CONTROL: GitHub's own default invocation, same fixture, must still be hijacked. */
  const exposed = runScript(
    ["bash", "--noprofile", "--norc", "-eo", "pipefail", script],
    { BASH_ENV: hook },
  );
  assert.match(
    exposed.stdout,
    /BASH_ENV_EXECUTED/u,
    "the fixture must reproduce the defect, or the guarded case proves nothing",
  );
});

test("SHELLOPTS with a PS4 command substitution cannot execute either", () => {
  /* THE FILE-FREE VARIANT. `SHELLOPTS=xtrace` is applied at startup and `PS4` is expanded before
     every traced command, substitution included - so this pair is arbitrary execution with no
     BASH_ENV anywhere. It is why the two names travel together on the list. */
  const root = scratch();
  const script = join(root, "step.sh");
  const step = runSteps()[0];
  writeFileSync(script, `${step.body[0]}\nset -euo pipefail\n:\nprintf "STEP_RAN\\n"\n`);
  const hostile = { SHELLOPTS: "xtrace", PS4: '$(printf "PS4_EXECUTED\\n" >&2)' };

  const guarded = runScript(shellArgv(step.shell, script), hostile);
  assert.doesNotMatch(guarded.stderr, /PS4_EXECUTED/u);
  assert.match(guarded.stdout, /STEP_RAN/u);

  const exposed = runScript(["bash", "--noprofile", "--norc", "-eo", "pipefail", script], hostile);
  assert.match(exposed.stderr, /PS4_EXECUTED/u, "the fixture must reproduce the defect");
});

/* ------------------------------------------------------------------ NODE_OPTIONS, reproduced */

test("NODE_OPTIONS cannot preload into the node a step launches", () => {
  const root = scratch();
  const script = join(root, "step.sh");
  const step = runSteps()[0];
  writeFileSync(
    script,
    `${step.body[0]}\nset -euo pipefail\n${JSON.stringify(process.execPath)} -e 'console.log("NODE_RAN")'\n`,
  );
  const hostile = {
    NODE_OPTIONS: "--import=data:text/javascript,console.log(%22NODE_OPTIONS_EXECUTED%22)",
  };

  const guarded = runScript(shellArgv(step.shell, script), hostile);
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /NODE_RAN/u);
  assert.doesNotMatch(guarded.stdout, /NODE_OPTIONS_EXECUTED/u);

  const exposed = runScript(["bash", "--noprofile", "--norc", "-eo", "pipefail", script], hostile);
  assert.match(exposed.stdout, /NODE_OPTIONS_EXECUTED/u, "the fixture must reproduce the defect");
});

/* ------------------------------------------------------------------ imported functions */

test("an imported shell function cannot stand in for the node a step invokes", () => {
  /*
   * THE SECOND CLASS, AND THE REASON THE PURGE EXISTS. `env -u` cannot name these - the names are
   * unbounded - and a function outranks both an external command and a builtin when the name is
   * CALLED. `command -v node` and `node ...` are exactly such calls, in the Action's first step.
   */
  const root = scratch();
  const script = join(root, "step.sh");
  const step = runSteps()[0];
  writeFileSync(script, `${step.body[0]}\nset -euo pipefail\nnode -e 'console.log("REAL_NODE")'\n`);
  const hostile = {
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    "BASH_FUNC_node%%": '() { echo FUNCTION_HIJACK; }',
  };

  const guarded = runScript(shellArgv(step.shell, script), hostile);
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /REAL_NODE/u);
  assert.doesNotMatch(guarded.stdout, /FUNCTION_HIJACK/u);

  /* The control runs the SAME shell with the purge line removed, so the only variable is the purge. */
  const withoutPurge = join(root, "unpurged.sh");
  writeFileSync(withoutPurge, "set -euo pipefail\nnode -e 'console.log(\"REAL_NODE\")'\n");
  const exposed = runScript(shellArgv(step.shell, withoutPurge), hostile);
  assert.match(exposed.stdout, /FUNCTION_HIJACK/u, "the fixture must reproduce the defect");
});

/* ------------------------------------------------------------------ the second pass, in-process */

test("the boundary strips the same hooks from every environment it hands a child", () => {
  const environment = {
    PATH: "/usr/bin",
    BASH_ENV: "/tmp/hook.sh",
    ENV: "/tmp/hook.sh",
    SHELLOPTS: "xtrace",
    BASHOPTS: "extglob",
    PS4: "$(id)",
    NODE_OPTIONS: "--require=/tmp/hook.js",
    NODE_PATH: "/tmp/modules",
    NODE_REPL_EXTERNAL_MODULE: "/tmp/repl.js",
    GITHUB_RUN_ID: "1",
  };
  const removed = neutralizeAmbientInterpreterHooks(environment);
  assert.deepEqual(removed.sort(), declaredHooks().sort());
  assert.deepEqual(Object.keys(environment).sort(), ["GITHUB_RUN_ID", "PATH"]);
  /* AN ENVIRONMENT WITHOUT THEM IS UNTOUCHED, so a clean job pays nothing and reports nothing. */
  assert.deepEqual(neutralizeAmbientInterpreterHooks({ PATH: "/usr/bin" }), []);
});
