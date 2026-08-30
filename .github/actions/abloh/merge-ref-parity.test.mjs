/**
 * THE MERGE-REF RULE EXISTS TWICE, AND IT HAS TO. This pins the two copies to each other.
 *
 * The Action's boundary script cannot import @abloh/core - it is a standalone file with no
 * workspace resolution, and it runs before the CLI is installed - so the decision that says what a
 * non-head checkout IS is written once in TypeScript for the CLI and once in JavaScript for the
 * runner. `base-reachability-parity.test.mjs` opens with the same argument about the deepen ladder,
 * and this file is its sibling.
 *
 * WHY DRIFT HERE WOULD BE WORSE THAN SILENT. The two copies guard the same measurement from
 * opposite ends: the boundary decides whether the run starts, and the CLI decides whether the run
 * it was handed is measuring what it says it is. A runner copy that admitted a shape the CLI
 * refuses turns into a job that installs, builds and then refuses at the last step - the shape the
 * boundary exists to prevent. A runner copy that REFUSED a shape the CLI admits is the postflip
 * census's own row: six repositories walled at the first sentence of the product.
 *
 * IT READS THE SOURCES RATHER THAN IMPORTING THEM, because the point is that both files SPELL the
 * rule. Importing would prove the CLI's copy behaves; it would say nothing about the runner's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const CORE = readFileSync(join(ROOT, "packages/core/src/merge-ref-checkout.ts"), "utf8");
const RUNNER = readFileSync(join(HERE, "action-boundary.mjs"), "utf8");

/**
 * The body of `classifyPullRequestCheckout`, from `{` to the closing brace at column 0.
 *
 * BOTH FILES DECLARE IT AT TOP LEVEL, so the terminator is unambiguous. The extraction is
 * deliberately dumb: a clever parser here would be a third thing that can be wrong.
 */
function decisionBody(source, where) {
  const at = source.indexOf("function classifyPullRequestCheckout");
  assert.ok(at > 0, `${where} must declare classifyPullRequestCheckout`);
  const open = source.indexOf("{", at);
  const close = source.indexOf("\n}", open);
  assert.ok(close > open, `${where}: could not find the end of the decision`);
  return source.slice(open, close);
}

const CORE_BODY = decisionBody(CORE, "packages/core/src/merge-ref-checkout.ts");
const RUNNER_BODY = decisionBody(RUNNER, "apps/action/action-boundary.mjs");

test("both copies decide in the same order, on the same four facts", () => {
  /*
   * ORDER MATTERS AS MUCH AS PRESENCE. Each check produces a DIFFERENT customer-facing sentence, so
   * two copies that ask the same questions in a different order refuse the same repository with two
   * different remedies - and the maintainer who read one and acted on it meets the other.
   */
  const gates = [
    /* the exact-head short circuit */
    "checkoutSha === headSha",
    /* (2) this run's commit */
    "triggerSha !== checkoutSha",
    /* (1) two parents, base first, head second */
    "parents.length !== 2",
    /* (3) no changed file was rewritten by the merge */
    "conflicts.length > 0",
  ];
  for (const [body, where] of [[CORE_BODY, "core"], [RUNNER_BODY, "runner"]]) {
    let cursor = -1;
    for (const gate of gates) {
      const at = body.indexOf(gate, cursor + 1);
      assert.ok(at > cursor, `${where}: expected \`${gate}\` after the gate before it`);
      cursor = at;
    }
  }
});

test("both copies compute the conflict set the same way", () => {
  /* THE ONE LINE THE WHOLE ADMISSION RESTS ON: a merge-ref checkout is measurable exactly when no
     file the pull request changes was rewritten by the merge. Two spellings of this intersection
     would be two different answers about which repositories are admitted. */
  const intersection = "filter((path) => changed.has(path))";
  assert.ok(CORE_BODY.includes(intersection), "core must intersect changed paths with diverged ones");
  assert.ok(RUNNER_BODY.includes(intersection), "the runner must intersect the same two sets");
  for (const [body, where] of [[CORE_BODY, "core"], [RUNNER_BODY, "runner"]]) {
    assert.ok(body.includes("new Set(input.changedPaths)"), `${where}: changed paths build the set`);
    assert.ok(body.includes("input.divergedPaths"), `${where}: diverged paths are what is filtered`);
  }
});

test("both copies read the two path lists with rename detection off and NUL delimiters", () => {
  /*
   * THE FACTS ARE HALF THE RULE, AND THIS HALF IS NOT IN THE DECISION BODY.
   *
   * `classifyPullRequestCheckout` intersects two lists of names. It is correct on the facts it is
   * given and cannot tell that `old.txt` and `new.txt` are one file - so a copy that reads its
   * lists with git's DEFAULT rename detection hands the same rule two vocabularies, the
   * intersection comes out empty, and a merge whose tree lacks a pull-request path is admitted
   * (assumption audit, 2026-08-29, rank 25). `-z` is the same soundness against a path git would
   * otherwise QUOTE and the reader would split in two.
   *
   * Pinned as the flags rather than as behaviour, for the reason this whole file exists: the
   * runner's copy cannot be imported, so what can be compared is what each file SPELLS.
   */
  const CLI = readFileSync(join(ROOT, "apps/cli/src/checkout-identity.ts"), "utf8");
  for (const [source, where] of [[RUNNER, "apps/action/action-boundary.mjs"], [CLI, "apps/cli/src/checkout-identity.ts"]]) {
    assert.ok(
      source.includes('"diff", "--no-renames", "-z", "--name-only"'),
      `${where}: both path reads must disable rename detection and use NUL delimiters`,
    );
    assert.ok(
      !/"diff",\s*"--name-only"/u.test(source),
      `${where}: no rename-detecting path read may remain`,
    );
    assert.ok(source.includes('split("\\0")'), `${where}: the reader must split on NUL`);
  }
});

test("both copies return the same three verdicts and no fourth", () => {
  for (const [body, where] of [[CORE_BODY, "core"], [RUNNER_BODY, "runner"]]) {
    const kinds = [...body.matchAll(/kind: "([a-z-]+)"/gu)].map(([, kind]) => kind);
    assert.deepEqual(
      [...new Set(kinds)].sort(),
      ["exact", "merge-ref", "unproven"],
      `${where}: a verdict one copy can return and the other cannot is the drift this pins`,
    );
  }
});

test("both copies word the four refusals identically", () => {
  /*
   * THE SENTENCES ARE THE PRODUCT. A customer meets whichever copy refuses first, and two wordings
   * of one wall is the drift `refusal-copy.ts` was deleted for. Compared as fragments rather than
   * whole strings because the two files interpolate the shas differently - core has a `short()`
   * helper and the runner spells `.slice(0, 12)` inline, which is a difference in JavaScript rather
   * than a difference in what a maintainer reads.
   */
  const sentences = [
    "is not a full Git object id",
    "which is neither this pull request's head",
    "nor the commit GitHub started this run on",
    "is not a merge of this pull request's base",
    "this job checks out the merge of your pull request rather than its head commit",
    "so the",
    "changed lines Abloh would measure are not the ones on disk",
  ];
  for (const sentence of sentences) {
    assert.ok(CORE_BODY.includes(sentence), `core is missing: ${sentence}`);
    assert.ok(RUNNER_BODY.includes(sentence), `the runner is missing: ${sentence}`);
  }
});

test("both copies offer the same one-line remedy", () => {
  /* The remedy is what makes every refusal above actionable, and it is the same edit in both: pin
     the job's checkout to the head sha. A runner that suggested a different fix from the CLI would
     be two answers to "what do I do about this". */
  const remedy = /MERGE_REF_REMEDY\s*(?::\s*string\s*)?=\s*\n?\s*"([^"]+)"\s*\+\s*\n?\s*"([^"]+)"/u;
  const core = remedy.exec(CORE);
  const runner = remedy.exec(RUNNER);
  assert.ok(core !== null, "core must spell MERGE_REF_REMEDY as a literal");
  assert.ok(runner !== null, "the runner must spell MERGE_REF_REMEDY as a literal");
  assert.equal(runner[1] + runner[2], core[1] + core[2]);
  assert.match(core[1] + core[2], /github\.event\.pull_request\.head\.sha/u);
});
