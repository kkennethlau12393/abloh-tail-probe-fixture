/**
 * THE CENSUS ROW WHERE ABLOH INHERITED A RUNTIME IT COULD NOT RUN ON, recreated in its own shape.
 *
 * WHAT HAPPENED (postflip-generated-c1, 2026-08-29, `product/apps/study-live/report/postflip-c1.md`).
 * `alibaba/formily`'s `ci.yml::build` runs `actions/setup-node@v1` with no version, which leaves the
 * runner on Node 16.20.2. The borrow road appends Abloh's step to THAT job, so the preflight ran
 * under Node 16 and refused:
 *
 *   Abloh Action boundary: Node 16.20.2 is unsupported; set up the repository's Node >=20.6 runtime
 *   before Abloh
 *
 * (Verbatim, from run 33223566579's `build` job.) The sentence was true and the mechanism was wrong:
 * it asked a maintainer to change how their own build runs so that a tool they had not merged yet
 * could run inside it. Appending one step is not a mandate to edit somebody's toolchain.
 *
 * WHAT THESE TESTS HOLD. That Abloh decides its own runtime rather than demanding one - the floor is
 * asked of whatever was handed over, an inadequate one is replaced from npm at a pinned version, an
 * adequate one is left alone with nothing installed, and neither path writes to `$GITHUB_PATH` or
 * otherwise moves the runtime the customer's own steps resolve.
 *
 * THE INSTALL ITSELF IS NOT EXERCISED HERE, and the reason is the one `action-boundary.test.mjs`
 * gives for its own fake `npm`: a test that reached the registry would be a network test wearing a
 * unit test's clothes. What is exercised is every decision around it, with a stub `npm` on PATH that
 * places a real executable, so the placement checks, the version cross-check and the refusals all
 * run against a real spawn.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  ABLOH_NODE_SPEC,
  assertSupportedNodeVersion,
  provisionNodeRuntime,
  supportedNodeVersion,
} from "./action-boundary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTION = join(HERE, "action.yml");

const roots = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(name) {
  const root = mkdtempSync(join(tmpdir(), `abloh-runtime-${name}-`));
  roots.push(root);
  return root;
}

/**
 * A stub `npm` that places a working `node` where the real package manager would.
 *
 * IT PLACES A REAL EXECUTABLE and not a marker file, because the boundary runs `--version` on what
 * it finds and refuses a binary that will not answer. A stub that wrote a text file would make that
 * cross-check pass for the wrong reason - or rather, it would make it fail, which is the same
 * problem from the other side.
 */
function fakeNpm(root, { placeVersion = process.versions.node, exitCode = 0 } = {}) {
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const npm = join(bin, "npm");
  writeFileSync(
    npm,
    [
      "#!/bin/sh",
      'prefix=""',
      "while [ $# -gt 0 ]; do",
      '  if [ "$1" = "--prefix" ]; then prefix="$2"; fi',
      "  shift",
      "done",
      `[ ${exitCode} -eq 0 ] || exit ${exitCode}`,
      'mkdir -p "$prefix/node_modules/.bin"',
      `printf '#!/bin/sh\\nprintf "v${placeVersion}\\\\n"\\n' > "$prefix/node_modules/.bin/node"`,
      'chmod 755 "$prefix/node_modules/.bin/node"',
      "",
    ].join("\n"),
  );
  chmodSync(npm, 0o755);
  return bin;
}

function environment(root, extra = {}) {
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  return {
    PATH: `${fakeNpm(root)}:${process.env.PATH ?? ""}`,
    RUNNER_TEMP: runnerTemp,
    GITHUB_RUN_ID: "33223566579",
    GITHUB_RUN_ATTEMPT: "1",
    ...extra,
  };
}

/* ------------------------------------------------------------------ the floor */

test("the floor is the same rule on the runtime handed over and the one Abloh installs", () => {
  /* THE ROW'S OWN VERSION. `alibaba/formily`, run 33223566579, `setup-node@v1` with no version. */
  assert.equal(supportedNodeVersion("16.20.2"), false);
  assert.equal(supportedNodeVersion("v16.20.2"), false, "`node --version` prints a leading v");
  assert.equal(supportedNodeVersion("20.5.1"), false, "20.6 is the floor, not 20");
  assert.equal(supportedNodeVersion("20.6.0"), true);
  assert.equal(supportedNodeVersion("v22.23.2"), true);
  assert.equal(supportedNodeVersion("not-a-version"), false);
  assert.throws(() => assertSupportedNodeVersion("16.20.2"), /Node 16\.20\.2 is unsupported/u);
});

test("the refusal no longer tells a maintainer to change their own build", () => {
  /* THE CENSUS SENTENCE, GONE. What replaced it says what Abloh failed to do, because provisioning
     a runtime is now Abloh's job and a failure at it is Abloh's failure to report. */
  assert.throws(
    () => assertSupportedNodeVersion("16.20.2"),
    (error) => {
      assert.doesNotMatch(error.message, /set up the repository's Node/u);
      assert.match(error.message, /Abloh could not provision a Node >=20\.6 runtime of its own/u);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ the decision */

test("a runtime that already meets the floor is kept, and nothing is installed", () => {
  const root = temporary("adequate");
  /* This test process is itself on a supported Node, which is the adequate case exactly. */
  const runtime = provisionNodeRuntime(environment(root));
  assert.equal(runtime.installed, false, "a customer who prepared a good Node pays no install");
  assert.equal(runtime.path, process.execPath);
});

test("formily's Node 16 job: Abloh installs its own runtime and runs on that", (t) => {
  if (!supportedNodeVersion("16.20.2") === false) t.skip("floor moved");
  const root = temporary("inherited-16");
  /*
   * THE ROW, REPRODUCED. `provisionNodeRuntime` asks `process.versions.node`, and this test process
   * is on a supported one - so the branch is reached by running the boundary in a CHILD whose node
   * is a stub reporting 16.20.2. That child is the formily runner: an old Node on PATH, a working
   * npm beside it, and Abloh's step appended to a job it did not write.
   */
  const bin = fakeNpm(root, { placeVersion: "22.23.2" });
  const oldNode = join(bin, "node16");
  writeFileSync(
    oldNode,
    `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
  );
  chmodSync(oldNode, 0o755);

  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  const output = join(root, "github-output");
  writeFileSync(output, "", { mode: 0o600 });
  const probe = join(root, "probe.mjs");
  writeFileSync(
    probe,
    [
      /* The one lie this fixture tells: the version this process reports. Everything else -
         the npm spawn, the placement checks, the `--version` cross-check - is real. */
      `Object.defineProperty(process.versions, "node", { value: "16.20.2" });`,
      `const { provisionNodeRuntime } = await import(${JSON.stringify(join(HERE, "action-boundary.mjs"))});`,
      `const runtime = provisionNodeRuntime(process.env);`,
      `process.stdout.write(JSON.stringify(runtime));`,
      "",
    ].join("\n"),
  );
  const result = spawnSync(process.execPath, [probe], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_RUN_ID: "33223566579",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: output,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const runtime = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.equal(runtime.installed, true, "Node 16.20.2 must be replaced, not refused");
  assert.match(runtime.path, /runner-temp\/abloh-node\/33223566579-1\//u);
  /* IT SAYS SO, on the customer's own log, naming their version and promising not to touch it. */
  assert.match(result.stderr + result.stdout, /this job prepared Node 16\.20\.2/u);
  assert.match(result.stderr + result.stdout, /leaving your runtime exactly as it is/u);
});

test("an installed runtime that answers with an unsupported version is refused, not used", () => {
  const root = temporary("bad-install");
  const bin = fakeNpm(root, { placeVersion: "18.20.4" });
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  const probe = join(root, "probe.mjs");
  writeFileSync(
    probe,
    [
      `Object.defineProperty(process.versions, "node", { value: "16.20.2" });`,
      `const { provisionNodeRuntime } = await import(${JSON.stringify(join(HERE, "action-boundary.mjs"))});`,
      `provisionNodeRuntime(process.env);`,
      "",
    ].join("\n"),
  );
  const result = spawnSync(process.execPath, [probe], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
  });
  assert.notEqual(result.status, 0);
  /* THE PIN IS ASKED, NOT ASSUMED. A prefix that resolved to something else must not become the
     runtime every later step runs on just because the install command exited 0. */
  assert.match(result.stderr, /Node v18\.20\.4 is unsupported/u);
});

test("a failing install refuses and names the spec, rather than falling back to the old runtime", () => {
  const root = temporary("failed-install");
  const bin = fakeNpm(root, { exitCode: 7 });
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  const probe = join(root, "probe.mjs");
  writeFileSync(
    probe,
    [
      `Object.defineProperty(process.versions, "node", { value: "16.20.2" });`,
      `const { provisionNodeRuntime } = await import(${JSON.stringify(join(HERE, "action-boundary.mjs"))});`,
      `provisionNodeRuntime(process.env);`,
      "",
    ].join("\n"),
  );
  const result = spawnSync(process.execPath, [probe], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
  });
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes(`npm could not install ${ABLOH_NODE_SPEC}`),
    `expected the spec in the refusal, got: ${result.stderr}`,
  );
});

/* ------------------------------------------------------------------ the composite action */

test("every Abloh step runs on the provisioned runtime, and no step moves the customer's", () => {
  const source = readFileSync(ACTION, "utf8");
  /* THE PROVISIONING STEP EXISTS AND RUNS FIRST OF THE BOUNDARY STEPS. It is the only one that may
     invoke a bare `node`, because it is the step whose whole job is deciding which node. */
  const provision = source.indexOf('action-boundary.mjs" provision-runtime');
  assert.ok(provision > 0, "the composite action must provision a runtime");
  for (const command of ["preflight", "install-cli", "prepare", "run", "upload"]) {
    const at = source.indexOf(`action-boundary.mjs" ${command}`);
    assert.ok(at > provision, `${command} must run after the runtime is provisioned`);
  }
  /* AND EVERY ONE OF THEM NAMES IT. A step that invoked a bare `node` would silently put that half
     of the run back on the runtime the customer prepared, which is the whole defect. */
  const invocations = [...source.matchAll(
    /^\s*(\S+) "\$GITHUB_ACTION_PATH\/action-boundary\.mjs" (\w[\w-]*)/gmu,
  )].map(([, runner, command]) => ({ runner, command }));
  assert.ok(invocations.length >= 7, `expected every boundary step, found ${invocations.length}`);
  for (const { runner, command } of invocations) {
    if (command === "provision-runtime") {
      assert.equal(runner, "node");
      continue;
    }
    assert.equal(runner, '"$ABLOH_NODE"', `${command} must run on Abloh's own runtime`);
  }
  /* NOTHING TOUCHES THE JOB'S PATH. `$GITHUB_PATH` would put Abloh's Node in front of the
     customer's for every later step of theirs and for everything the CLI spawns - including the
     cold-lane setup script, which is their build recipe and must run on the Node they declared.
     Asserted over the FILE WITH ITS COMMENTS STRIPPED, because the comment beside the provisioning
     step says the words `$GITHUB_PATH` in order to say that it does not use it. */
  const executable = source
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
  assert.doesNotMatch(executable, /GITHUB_PATH/u);
  /*
   * AND NO STEP OF THIS ACTION *USES* A SETUP ACTION, first-party or third-party. Abloh decides its
   * own runtime and installs it from npm - the one-recipe ruling's own source - and delegating that
   * to somebody else's action would be the same defect the whole `provisionNodeRuntime` mechanism
   * replaced, with a supply chain attached.
   *
   * ASSERTED OVER THE `uses:` LINES AND NOT OVER THE WHOLE FILE (2026-08-30). It was a substring
   * check, and it was wrong in both directions. It fired on the runtime guard's own REFUSAL, which
   * names `actions/setup-node` in order to tell a maintainer on Node 12 what to add - the same
   * reason the `GITHUB_PATH` check above reads the file with its comments stripped, one level
   * further out. And it missed `pnpm/action-setup`, `oven-sh/setup-bun` and every other setup action
   * that does not happen to contain those characters. What the rule has always meant is which
   * ACTIONS this file runs, so that is what is read.
   */
  const used = [...executable.matchAll(/^\s*uses:\s*(\S+)/gmu)].map(([, action]) => action);
  assert.ok(used.length > 0, "the read found no `uses:` at all, so it is asserting nothing");
  for (const action of used) {
    assert.doesNotMatch(
      action,
      /setup[-/]|[-/]setup/u,
      `${action} is a setup action, and Abloh provisions its own runtime`,
    );
  }
});

test("the pin the action installs satisfies the floor the boundary enforces", () => {
  /* TWO SITES, ONE FACT. The floor lives in `supportedNodeVersion` and the pin in
     `ABLOH_NODE_SPEC`; a pin below the floor would install a runtime the next line refuses. */
  const version = ABLOH_NODE_SPEC.split("@")[1];
  assert.ok(version !== undefined, `${ABLOH_NODE_SPEC} must name an exact version`);
  assert.match(version, /^\d+\.\d+\.\d+$/u, "an exact version, never a range or a tag");
  assert.equal(supportedNodeVersion(version), true);
});
