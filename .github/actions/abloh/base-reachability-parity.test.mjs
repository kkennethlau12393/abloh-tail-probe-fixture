import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The bounded deepen exists TWICE, and it has to. The Action's boundary script cannot import
 * @abloh/core - it is a standalone file with no workspace resolution, and it runs before the CLI
 * is installed - so the rule that decides how far a shallow checkout may be fetched is written
 * once in TypeScript for the CLI and once in JavaScript for the runner.
 *
 * Two copies of one bound is the condition this repository has already paid for elsewhere: a
 * producer and a validator disagreeing, silently, with no signal at either end. Here the drift
 * would be worse than silent - it would be INVISIBLE and expensive. A runner ladder that grew
 * while the CLI's stayed put would fetch history nobody bounded, and a runner ladder that shrank
 * would refuse runs the CLI proves are repairable, with neither showing up as a failing assertion
 * anywhere.
 *
 * This file pins the numbers to each other. It reads the sources rather than importing them,
 * because the point is that the two files each SPELL the bound, not that they compute it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const CORE = readFileSync(join(ROOT, "packages/core/src/base-reachability.ts"), "utf8");
const RUNNER = readFileSync(join(HERE, "action-boundary.mjs"), "utf8");

/** Every copy spells the ladder as a literal array, in the same order. */
const LADDER = /DEEPEN_LADDER\s*=\s*\[([^\]]+)\]/u;
const NUMBER = (name) => new RegExp(`${name}\\s*=\\s*([0-9_]+)`, "u");

function ladder(source, where) {
  const match = LADDER.exec(source);
  assert.ok(match !== null, `${where} must spell DEEPEN_LADDER as a literal array`);
  return match[1].split(",").map((entry) => Number(entry.trim())).filter((n) => !Number.isNaN(n));
}

function number(source, name, where) {
  const match = NUMBER(name).exec(source);
  assert.ok(match !== null, `${where} must spell ${name}`);
  return Number(match[1].replaceAll("_", ""));
}

test("the runner and the CLI deepen by exactly the same ladder", () => {
  const core = ladder(CORE, "packages/core/src/base-reachability.ts");
  const runner = ladder(RUNNER, "apps/action/action-boundary.mjs");
  assert.ok(core.length > 0, "the ladder must have at least one rung");
  assert.deepEqual(runner, core, "a runner that deepens differently from the CLI is the drift this pins");
});

test("the ladder ends at the stated ceiling, and the ceiling is what the refusal quotes", () => {
  for (const [source, where] of [[CORE, "core"], [RUNNER, "runner"]]) {
    const rungs = ladder(source, where);
    const ceiling = number(source, "MAX_DEEPEN_DEPTH", where);
    assert.equal(
      rungs.at(-1),
      ceiling,
      `${where}: MAX_DEEPEN_DEPTH is the sentence a refused customer reads, so it must be the ` +
      "last rung actually attempted",
    );
    assert.deepEqual(
      [...rungs].sort((a, b) => a - b),
      rungs,
      `${where}: rungs must ascend, or a later rung would fetch less than an earlier one`,
    );
  }
});

test("both copies kill a single fetch at the same deadline", () => {
  assert.equal(
    number(RUNNER, "DEEPEN_FETCH_TIMEOUT_MS", "runner"),
    number(CORE, "DEEPEN_FETCH_TIMEOUT_MS", "core"),
  );
});

test("neither copy may reach for --unshallow, which is the bound's whole point", () => {
  for (const [source, where] of [[CORE, "core"], [RUNNER, "runner"]]) {
    /* The QUOTED form only: both headers name the flag in prose to say they do not use it, and
       the thing that would actually spend it is a string in an argv array. */
    assert.doesNotMatch(
      source,
      /["']--unshallow["']/u,
      `${where}: --unshallow downloads the whole history, which is what the ladder exists to bound`,
    );
  }
});
