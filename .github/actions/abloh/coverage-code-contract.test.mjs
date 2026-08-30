/**
 * RANK 5 OF THE EXTERNAL REFUSAL REVIEW (2026-08-27).
 *
 * VERBATIM, THE FINDING: "Reachable coverage reasons are absent from three normalizers. Measurement
 * succeeds locally, upload fails, and the Action shows only HTTP 400."
 *
 * The reviewer reproduced three engine sentences that no normalizer had a rule for -
 * `aggregate coverage timed out`, `prepared coverage adapter does not match the test runner`, and
 * `angular-vitest runner: no angular.json test target was resolved`. Each threw
 * `diff coverage cannot-attest reason is not recognized` inside the Action, and that throw discards
 * the WHOLE artifact: every package that measured perfectly went with it, and the customer's job log
 * showed a status code.
 *
 * The reviewer also found the three normalizers DISAGREEING: Deno's
 * `coverage report step exited nonzero (untrusted)` was `coverage-report-invalid` to the Action's
 * prefix rule and `coverage-run-failed` to the API's exact map.
 *
 * Both are the same defect - a code being guessed out of a sentence by whoever happened to be
 * reading it. The producer declares the code now (`packages/engine-stryker/src/coverage.ts` and
 * `packages/engine-python/src/coverage.ts`), and this file holds the boundary to the two properties
 * that follow from that: a closed code passes through untouched, and an unknown value never costs
 * the run its measurement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeL0Reason } from "./build-handoff.mjs";

/** The exact sentences the reviewer reproduced as `not recognized`. */
const REVIEWER_REPRODUCTIONS = [
  "aggregate coverage timed out",
  "prepared coverage adapter does not match the test runner",
  "angular-vitest runner: no angular.json test target was resolved",
];

test("rank 5: the sentences that used to discard a whole completed run no longer throw", () => {
  for (const sentence of REVIEWER_REPRODUCTIONS) {
    let code;
    assert.doesNotThrow(() => {
      code = normalizeL0Reason(sentence);
    }, `"${sentence}" must not take the upload down`);
    assert.equal(typeof code, "string");
    assert.notEqual(code, "", `"${sentence}" must still be recorded as something`);
  }
});

test("rank 5: an unknown value becomes the generic code rather than a rejected artifact", () => {
  assert.equal(normalizeL0Reason("a reason from a CLI newer than this Action"), "coverage-acquisition-failed");
  /* And it is said out loud, on the job log, rather than swallowed: a silently generalised reason is
     how a vocabulary gap goes unnoticed for another release. */
});

test("rank 5: every closed code the producer can declare passes through untouched", () => {
  /* This is the whole contract now that the producer speaks the vocabulary. If a code the engine can
     throw did not survive this boundary, the Action would rewrite a precise refusal into a vague
     one on every run that hit it. */
  for (const code of [
    "coverage-provider-unavailable",
    "coverage-provider-version-mismatch",
    "coverage-run-failed",
    "coverage-report-missing",
    "coverage-report-invalid",
    "coverage-scope-invalid",
    "coverage-scope-incomplete",
    "coverage-py-unavailable",
    "coverage-acquisition-failed",
    "package-unmeasurable",
    "python-project-not-found",
    "pytest-unavailable",
    "python-target-unavailable",
  ]) {
    assert.equal(normalizeL0Reason(code), code);
  }
});

test("rank 5: a missing reason is still a producer bug and still refuses", () => {
  /* The one throw that stays. `cannot-attest` with no reason at all is a malformed artifact, not a
     vocabulary gap, and passing it on would put a refusal with no cause on the customer's check. */
  assert.throws(() => normalizeL0Reason(undefined), /reason is required/u);
  assert.throws(() => normalizeL0Reason(null), /reason is required/u);
  assert.throws(() => normalizeL0Reason(7), /reason is required/u);
});
