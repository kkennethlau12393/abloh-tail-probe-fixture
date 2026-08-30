/**
 * THE ACTION'S COPY OF THE THREE IDENTITY CONDITIONS, AND THE ONE PLACE THAT DECIDES WHICH APPLIES.
 *
 * WHY A COPY AT ALL. The Action ships as standalone `.mjs` in its own repository and cannot import
 * `@abloh/core`, where the refusal registry and the sentences live. This is the same arrangement,
 * for the same reason, as `refusal-envelope.mjs`: a hand-copy of prose the other side owns, pinned
 * equal by a contract test - `scripts/identity-condition-parity.test.ts` - rather than by two
 * comments that agree today.
 *
 * WHAT KENNETH'S RULING OF 2026-08-30 CHANGES HERE. The Action used to print one sentence covering
 * both a missing permission and a fork, because it did not know which it was looking at. That is
 * the banned shape in its smallest form: a category standing in for a cause, offering an edit to
 * somebody a platform rule has already decided against. It knows now, because `action.yml` hands it
 * `ABLOH_PR_FORK` from `github.event.pull_request.head.repo.fork` - a fact only the caller's context
 * carries.
 *
 * AN ENUM AND NOT A BOOLEAN, on the same ruling. `hasMintableIdentity()` was a boolean, and every
 * reader downstream had to re-derive the cause from it. {@link identityCondition} answers with the
 * cause or with `null`, and `null` means the identity is there.
 */

/**
 * WHICH CONDITION THIS JOB IS IN, or `null` when an identity is mintable.
 *
 * THE ORDER IS THE POINT. A fork run has no identity AND usually no `id-token: write` either, and
 * telling that maintainer to add the permission is the sentence that has somebody edit one line
 * four times. GitHub's rule is checked first because it outranks anything the workflow declares.
 */
export function identityCondition(environment) {
  const fork = String(environment.ABLOH_PR_FORK ?? "").trim().toLowerCase();
  const mintable = String(environment.ACTIONS_ID_TOKEN_REQUEST_URL ?? "").trim() !== "";
  if (mintable) return null;
  if (fork === "true") return "fork-policy";
  return "permission-missing";
}

/**
 * THE SENTENCE FOR ONE CONDITION.
 *
 * BYTE-IDENTICAL TO `packages/core/src/identity-condition.ts`, and the parity test is what makes
 * that true rather than this comment. A word changed on one side and not the other is a customer
 * meeting two different explanations of the same run, which is the drift the pin exists to stop.
 */
export function identityConditionSentence(kind, facts = {}) {
  if (kind === "fork-policy") {
    return (
      "this pull request comes from a fork, and GitHub mints no OIDC identity for a fork run " +
      "whatever any job declares. That is GitHub's rule rather than a setting in your repository, " +
      "so there is no permission to add and nothing here for you to fix. Abloh measured what it " +
      "could and the result stays on the run"
    );
  }
  if (kind === "permission-missing") {
    const job = facts.job === undefined || facts.job === "" ? "this job" : `the ${facts.job} job`;
    return (
      `${job} has no id-token: write, so GitHub minted no identity for it. GitHub grants that ` +
      "permission to no job by default, under either repository setting"
    );
  }
  const half = facts.stage === "publish" ? "post the result" : "mint the identity";
  const retry =
    facts.attempt !== undefined && facts.attempts !== undefined
      ? facts.attempt >= facts.attempts
        ? ` Abloh stopped after ${facts.attempts} attempts.`
        : ` Abloh is retrying, attempt ${facts.attempt} of ${facts.attempts}.`
      : "";
  return (
    `this is a failure in abloh: the job asked correctly and abloh could not ${half}.${retry} Your ` +
    "measurement is not lost, it is on this run in the Abloh artifact, and nothing about your " +
    "repository or your tests is wrong"
  );
}

/** The registry code each condition is raised under, so the Action's log and a refusal agree. */
export const IDENTITY_CONDITION_CODES = {
  "permission-missing": "identity-permission-missing",
  "identity-issuance-or-publish-failed": "identity-publish-failed",
  "fork-policy": "identity-fork-policy",
};

/**
 * ONE LINE FOR A JOB LOG: the code, then the sentence.
 *
 * THE CODE IS IN IT because a job log is where somebody pastes a line into a search, and the code
 * is the one token that finds the right registry entry rather than the right-looking one.
 */
export function identityConditionLine(kind, facts = {}) {
  return `Abloh [${IDENTITY_CONDITION_CODES[kind]}]: ${identityConditionSentence(kind, facts)}\n`;
}
