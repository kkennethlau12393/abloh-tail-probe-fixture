/**
 * WHAT MAY BECOME AN ENVIRONMENT RECORD EVERY LATER STEP OF THE JOB INHERITS.
 *
 * WHAT THIS FIXES (assumption audit, 2026-08-29, rank 11 / FS-03). The Action's first step was
 * eleven lines of `echo "NAME=${ABLOH_DEV_X:-default}"` redirected into `$GITHUB_ENV`. The
 * `ABLOH_DEV_*` overrides are undocumented and ambient, so ANY earlier step of the customer's job
 * can set one - and `echo` writes whatever it was handed. Two consequences, both reachable:
 *
 *   1. A value carrying a newline writes TWO records. The second is a variable nobody declared,
 *      in the map every later step of the job reads.
 *   2. The URL checks this file already had - `credentialFreeHttps` at the mint and the upload -
 *      run LONG AFTER that write, so a hostile origin was already the job's environment by then.
 *
 * The step now calls `resolve-control-plane`, which parses every value before a byte is written.
 * These tests are about that door: what it admits, what it refuses, and that the value it writes is
 * the value it was given rather than a normalised one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveControlPlane } from "./action-boundary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOUNDARY = join(HERE, "action-boundary.mjs");

const roots = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "abloh-control-plane-"));
  roots.push(root);
  return root;
}

/** Run the real step, exactly as `action.yml` does, and hand back what it wrote. */
function resolveStep(overrides) {
  const root = scratch();
  const environmentFile = join(root, "github-env");
  writeFileSync(environmentFile, "", { mode: 0o600 });
  const result = spawnSync(process.execPath, [BOUNDARY, "resolve-control-plane"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GITHUB_ENV: environmentFile, ...overrides },
  });
  return { ...result, written: readFileSync(environmentFile, "utf8") };
}

test("with no overrides the deployment's own eleven constants are written, one line each", () => {
  const result = resolveStep({});
  assert.equal(result.status, 0, result.stderr);
  const lines = result.written.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 11, "eleven records and no twelfth");
  assert.ok(lines.includes("HANDOFF_URL=https://api.abloh.dev/api/v1/runs"));
  assert.ok(lines.includes("HANDOFF_AUDIENCE=abloh-evidence-handoff"));
  assert.ok(lines.includes("SETUP_TRIAL_AUDIENCE=abloh-evidence-handoff"));
  /* NOT NORMALISED. `new URL("https://abloh.dev").toString()` is `https://abloh.dev/`, and the
     control plane compares against the published string - so the value written is the value given. */
  assert.ok(lines.includes("COMMAND_CENTER_ORIGIN=https://abloh.dev"));
});

test("a newline in an ambient override writes nothing at all", () => {
  /* THE DEFECT, AS THE AUDIT NAMED IT. `\n` is a C0 control character, so it is refused where the
     value is read - before the file is opened, let alone appended to. */
  const result = resolveStep({
    ABLOH_DEV_HANDOFF_AUDIENCE: "abloh-evidence-handoff\nMODEL_API_KEY=stolen",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /control/iu);
  assert.equal(result.written, "", "a refused value must not leave a partial environment behind");
});

test("an ambient override cannot redirect a fixed endpoint to a non-HTTPS or credentialed origin", () => {
  for (const [name, value, why] of [
    ["ABLOH_DEV_HANDOFF_URL", "http://evil.example/api/v1/runs", "plain HTTP"],
    ["ABLOH_DEV_MODEL_GATEWAY_URL", "https://user:pass@evil.example/x", "embedded credentials"],
    ["ABLOH_DEV_SETUP_TRIAL_URL", "https://evil.example/x?token=abc", "a query string"],
    ["ABLOH_DEV_COMMAND_CENTER_ORIGIN", "javascript:alert(1)", "a non-HTTPS scheme"],
  ]) {
    const result = resolveStep({ [name]: value });
    assert.equal(result.status, 2, `${why} was admitted`);
    assert.equal(result.written, "");
  }
});

test("a legitimate dev tunnel is still admitted, which is what the overrides are for", () => {
  const result = resolveStep({
    ABLOH_DEV_HANDOFF_URL: "https://tunnel.example/api/v1/runs",
    ABLOH_DEV_HANDOFF_AUDIENCE: "abloh-evidence-handoff-dev",
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.written.split("\n").filter((line) => line !== "");
  assert.ok(lines.includes("HANDOFF_URL=https://tunnel.example/api/v1/runs"));
  assert.ok(lines.includes("HANDOFF_AUDIENCE=abloh-evidence-handoff-dev"));
});

test("an empty override falls back to the constant, as the shell's `:-` did", () => {
  /* THE OLD STEP USED `${VAR:-default}`, where an exported-but-empty variable takes the default.
     A step that failed to fetch a value leaves exactly that, and the behaviour must not change. */
  const resolved = resolveControlPlane({ ABLOH_DEV_HANDOFF_URL: "" });
  assert.equal(resolved.HANDOFF_URL, "https://api.abloh.dev/api/v1/runs");
});

test("an over-long audience is refused before it is written", () => {
  const result = resolveStep({ ABLOH_DEV_MODEL_GATEWAY_AUDIENCE: "a".repeat(513) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /too long/u);
});

test("a symlinked GITHUB_ENV is refused rather than followed", () => {
  const root = scratch();
  const real = join(root, "real-env");
  writeFileSync(real, "", { mode: 0o600 });
  const link = join(root, "linked-env");
  symlinkSync(real, link);
  const result = spawnSync(process.execPath, [BOUNDARY, "resolve-control-plane"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GITHUB_ENV: link },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GITHUB_ENV must be a regular non-symlink file/u);
  assert.equal(readFileSync(real, "utf8"), "");
});
