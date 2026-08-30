/**
 * `dai-shi/react-tracked`'s ROW: THE FIRST STEP THAT COULD NOT BE READ, LET ALONE RUN.
 *
 * WHAT HAPPENED (corpus rehearsal, first full pass, 2026-08-30, finding 10; confirmed at `7d18072b`).
 * `react-tracked` prepares Node 12.22.12 in its own CI, the borrow road appends Abloh's step to that
 * job, and the whole of Abloh's first step was:
 *
 *     file:///rehearsal/action/action-boundary.mjs:266
 *       const upload = required(environment.UPLOAD ?? "false", "upload");
 *                                                   ^
 *     SyntaxError: Unexpected token '?'
 *
 * A raw V8 stack trace naming an internal module path, with no owner, no cause and no remedy. It is
 * the shape every refusal in this product exists to replace, and it was reached by the one step that
 * MUST run on the caller's runtime - the step that decides which runtime to use.
 *
 * WHY THE PRODUCT COULD NOT ANSWER FOR ITSELF. `provisionNodeRuntime` is exactly the mechanism for
 * an inadequate runtime, and it lives inside `action-boundary.mjs`. A `node` old enough to need it
 * most is a `node` that cannot parse the file that would provide it, so the answer has to come from
 * before the parse - which means bash, which is what `action.yml` guards with now.
 *
 * BOTH HALVES ARE TESTED HERE, because either alone would have passed on the real run:
 *
 *   - the boundary genuinely does not parse below the declared floor, so the floor is a fact rather
 *     than a number somebody chose;
 *   - the guard in `action.yml` refuses below it with a sentence that names the owner and the edit,
 *     and lets an adequate runtime through untouched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTION = join(HERE, "action.yml");
const BOUNDARY = join(HERE, "action-boundary.mjs");

/**
 * THE FLOOR, AND IT IS DECLARED IN ONE PLACE - `action.yml`'s guard - AND READ HERE.
 *
 * A second copy of the number would be the drift this whole file is about: a syntax feature added to
 * the boundary tomorrow would raise what the file needs and leave the guard letting a runtime
 * through to crash on it, with both sides green.
 */
const FLOOR = Number(
  /if \[ "\$abloh_node_major" -lt (\d+) \]/u.exec(readFileSync(ACTION, "utf8"))?.[1] ?? "0",
);

/** The guard, lifted out of the step that carries it, so the test runs the shipped lines. */
function guardScript() {
  const source = readFileSync(ACTION, "utf8");
  const start = source.indexOf('abloh_node_version="$(node --version');
  const end = source.indexOf('node "$GITHUB_ACTION_PATH/action-boundary.mjs" provision-runtime');
  assert.ok(start > 0 && end > start, "the runtime guard is no longer where this test reads it from");
  return source
    .slice(start, end)
    .split("\n")
    .map((line) => line.replace(/^ {8}/u, ""))
    .join("\n");
}

/**
 * THE GUARD, RUN AGAINST A `node` THAT REPORTS `version`. Empty string means "answers nothing".
 *
 * THE STUB IS A SHELL FUNCTION AND NOT A FILE ON PATH, which is a speed decision with a real cause:
 * macOS scans each newly written executable the first time it runs, and a fixture that wrote one
 * turned this file into a minute of waiting for a check nobody asked for. What is under test here is
 * the version comparison, and a function answers `$(node --version)` exactly as a binary would.
 */
function runGuard(version) {
  const stub = 'node() { if [ "$1" = "--version" ]; then echo "$FAKE_NODE_VERSION"; fi; return 0; }';
  return spawnSync("bash", ["-c", `set -euo pipefail\n${stub}\n${guardScript()}\necho REACHED_THE_BOUNDARY`], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", FAKE_NODE_VERSION: version },
  });
}

/* ------------------------------------------------------------------ the floor is a fact */

test("the boundary genuinely does not parse below the floor `action.yml` declares", () => {
  /* PARSED WITH A REAL PARSER AT A REAL LANGUAGE LEVEL, not by grepping for `??`. The row was a
     PARSE failure, so what has to be pinned is that the file parses at the floor and not under it. */
  const require = createRequire(import.meta.url);
  let acorn;
  try {
    acorn = require("acorn");
  } catch {
    /* The rig's own suite must not fail for want of a dev dependency it does not own. The guard's
       behaviour is still fully covered below; only the derivation of the number is skipped. */
    return;
  }
  const source = readFileSync(BOUNDARY, "utf8").replace(/^#![^\n]*\n/u, "");
  const parses = (ecmaVersion) => {
    try {
      acorn.parse(source, { ecmaVersion, sourceType: "module", allowAwaitOutsideFunction: false });
      return true;
    } catch {
      return false;
    }
  };
  /* Node 12's language level is ES2019 and Node 14's is ES2020. Neither can read this file, which
     is precisely why the answer cannot come from inside it. */
  assert.equal(parses(2019), false, "if the boundary parsed at ES2019 the guard would be unnecessary");
  assert.equal(parses(2020), false);
  assert.ok(FLOOR >= 16, `the declared floor is ${FLOOR}, which is below what the boundary needs`);
});

/* ------------------------------------------------------------------ the guard's own behaviour */

test("Node 12 is refused in abloh's own words, with an owner and an edit", () => {
  const result = runGuard("v12.22.12");
  assert.equal(result.status, 2, "the step stops rather than handing the file to a parser that cannot read it");
  assert.doesNotMatch(result.stdout, /REACHED_THE_BOUNDARY/u);

  /* THE FAILED THING IS NAMED, and it is the runtime rather than "an error". */
  assert.match(result.stderr, /this job prepared Node 12\.22\.12/u);
  /* THE OWNER IS NAMED. `Abloh Action boundary:` is the same prefix every other refusal from this
     layer carries, so a maintainer knows whose sentence they are reading. */
  assert.match(result.stderr, /^Abloh Action boundary:/u);
  /* THERE IS A NEXT ACTION. A wall with no door reads to a maintainer as a door they missed. */
  assert.match(result.stderr, /actions\/setup-node/u);
  assert.match(result.stderr, /node-version: 20/u);
  /* AND IT SAYS THEIR OWN TOOLCHAIN IS NOT BEING TAKEN AWAY, which is the ruling the whole
     `provisionNodeRuntime` mechanism exists under: appending one step is not a mandate to edit
     somebody's toolchain. */
  assert.match(result.stderr, /your other steps keep the Node they have/u);
  /* AND THE ROW'S OWN BYTES ARE GONE. */
  assert.doesNotMatch(result.stderr, /SyntaxError/u);
  assert.doesNotMatch(result.stderr, /internal\/modules/u);
});

test("every runtime at or above the floor reaches the boundary, which is what decides from there", () => {
  /* 16 IS BELOW ABLOH'S >=20.6 SUPPORTED FLOOR AND STILL PASSES THIS GUARD, on purpose. This guard
     is about whether the boundary can be READ; `provisionNodeRuntime` is what answers for whether it
     can be RUN on, and `alibaba/formily`'s Node 16 row is the case it exists for. Refusing 16 here
     would take that repository's answer away and hand the maintainer a toolchain edit instead. */
  for (const version of ["v16.20.2", "v18.20.8", "v20.19.5", "v22.23.2", "v24.11.1"]) {
    const result = runGuard(version);
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.match(result.stdout, /REACHED_THE_BOUNDARY/u, version);
  }
});

test("a `node` whose version cannot be read is refused rather than compared as zero", () => {
  /* `[ "" -lt 16 ]` is a bash error, and an unreadable version silently treated as adequate would
     hand the file to the parser the guard exists to keep it away from. */
  const result = runGuard("");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /which Abloh cannot read as a version/u);
  assert.doesNotMatch(result.stdout, /REACHED_THE_BOUNDARY/u);
});

test("the rig carries the Node major this row needs, so the wall stays reproducible", () => {
  /* The first corpus pass filed `react-tracked` as a rig problem for want of a pinned Node 12, which
     was the right failure to have had and the wrong one to keep. If that pin is ever dropped, this
     row stops being observable and the guard above stops being exercised end to end. */
  const versions = JSON.parse(
    readFileSync(join(HERE, "..", "..", "apps", "rehearsal", "src", "rehearse.mjs"), "utf8")
      .match(/export const NODE_VERSIONS = \{[\s\S]*?\n\};/u)[0]
      .replace(/export const NODE_VERSIONS = /u, "")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(\d+):/gu, '"$1":')
      .replace(/,(\s*\})/u, "$1")
      .replace(/;$/u, ""),
  );
  assert.equal(versions["12"], "12.22.12", "the census row's own runtime");
});
