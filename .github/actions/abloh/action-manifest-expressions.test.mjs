/**
 * AN `action.yml` GITHUB CANNOT PARSE IS AN ACTION THAT DOES NOT RUN, AND NOTHING HERE NOTICED.
 *
 * ================================================================================================
 * WHAT THIS COST, MEASURED ON REAL GITHUB (tail probe, first full pass, 2026-08-30).
 * ================================================================================================
 *
 * Five of seven probe scenarios died at their FIRST step, before a line of abloh ran:
 *
 *   ##[error]…/action.yml (Line: 127, Col: 18): Unrecognized named-value: 'job'.
 *             Located at position 1 within expression: job.status
 *   ##[error]GitHub.DistributedTask.ObjectTemplating.TemplateValidationException:
 *             The template is not valid.
 *   ##[error]Failed to load …/action.yml
 *
 * Line 127 is the `job-status` INPUT'S DESCRIPTION. It documents the value a caller passes by
 * quoting it - "passed as `${{ job.status }}` by the step Abloh's setup pull request appends" - and
 * GitHub's action-manifest loader template-parses that string like any other. `job` is not a context
 * an action manifest may name, so the whole file is refused and every step of the Action is
 * unreachable. The prose was correct; being prose did not protect it.
 *
 * IT IS NOT A LOCAL-ACTION ARTIFACT, and that was checked rather than assumed. A diagnostic in the
 * probe fixture ran four jobs: the same minimal composite action, with and without an expression in
 * one input description, referenced both as `./path` and as `owner/repo/path@ref`. Both
 * with-expression jobs failed with a byte-identical message and both controls passed. So this is
 * how the PUBLISHED Action behaves for every customer, not how a vendored copy behaves for a rig.
 *
 * WHY NOTHING BELOW THIS TIER COULD SEE IT. `apps/rehearsal/src/composite.mjs` reads `action.yml`
 * and runs its steps with its OWN expression subset, so it never hands the file to GitHub's parser
 * and cannot be refused by it. Every other test here reads the file with a YAML parser, which is
 * happy: this is valid YAML and invalid to GitHub's template layer, and only the second one runs
 * the Action.
 *
 * ================================================================================================
 * THE RULE, AND WHERE AN EXPRESSION IS ACTUALLY ALLOWED.
 * ================================================================================================
 *
 * GitHub evaluates `${{ }}` in an action manifest only under `runs:` (a step's `if:`, `env:`,
 * `with:`, `run:`, `uses:`, `shell:`, `working-directory:`) and in `outputs.<id>.value`. Everywhere
 * else - `name:`, `description:`, `author:`, `branding:`, and every `inputs.<id>.description` and
 * `inputs.<id>.default` - the string is still template-parsed and must therefore contain no
 * expression at all.
 *
 * THE CHECK IS TEXT-BASED AND SECTION-AWARE rather than a YAML walk, on `workflow-shape.test.mjs`'s
 * own reasoning: what GitHub loads is bytes, and a parser that normalized the file would pass a
 * manifest whose indentation put an expression somewhere else.
 *
 * AND IT IS PROVED ABLE TO FAIL, which `docs/lessons/verifying-rules.md` requires of every rule in
 * this repository: a rule that only ever runs over files that already pass it is indistinguishable
 * from a rule that returns nothing. Each case below runs the real check over a deliberately broken
 * copy as well as over the shipped file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every manifest this Action ships. Both are loaded by GitHub and both are subject to the rule. */
const MANIFESTS = [
  { name: "action.yml", path: join(HERE, "action.yml") },
  { name: "attest/action.yml", path: join(HERE, "attest", "action.yml") },
];

/**
 * A line's top-level section, or null while inside one.
 *
 * WHERE AN EXPRESSION IS LEGAL, in one sentence, because the answer is a section rather than a key:
 * `runs:` and nothing else, plus `outputs.<id>.value`. `outputs` is admitted at the section level
 * and narrowed to `value` below, because its sibling `description` takes no expression either.
 */
function topLevelKey(line) {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*):/u.exec(line);
  return match === null ? null : match[1];
}

/**
 * Every expression in a manifest that GitHub would refuse, as `{ line, section, text }`.
 *
 * THE LINE NUMBER IS THE ONE GITHUB PRINTS' NEIGHBOUR, not necessarily its exact value: GitHub
 * reports the position of the whole scalar node, so a folded block reports the `description:` line
 * and this reports the line the expression is written on. Both point a reader at the same key, which
 * is what a failure message has to do.
 */
export function offendingExpressions(text) {
  const found = [];
  let section = null;
  let outputsValue = false;
  for (const [index, line] of text.split("\n").entries()) {
    /*
     * A FULL-LINE YAML COMMENT IS NOT IN THE DOCUMENT AT ALL, so GitHub's template layer never sees
     * it: the loader parses YAML first - the failure this file exists for is a
     * `TemplateValidationException` over the PARSED token tree - and a comment is not part of that
     * tree by definition. Without this the rule would refuse the very comment that explains it, and
     * a maintainer could not write down the shape they are being warned about.
     *
     * FULL-LINE ONLY, deliberately. A `#` after a value may be a comment or may be inside a quoted
     * string, and a rule that guessed would have to be right about YAML quoting to be safe. A line
     * whose first non-space character is `#` is unambiguous, and being conservative here costs a
     * maintainer a line break and costs the rule nothing.
     *
     * AND IT IS CHECKED ON REAL GITHUB RATHER THAN ONLY REASONED ABOUT: `action.yml` carries such a
     * comment now, the tail probe vendors these exact bytes into its fixture, and every pass loads
     * them on a runner. A wrong belief here fails that pass at its first step, loudly.
     */
    if (/^\s*#/u.test(line)) continue;
    const key = topLevelKey(line);
    if (key !== null) { section = key; outputsValue = false; }
    if (section === "outputs") {
      /* `value:` IS THE ONE OUTPUTS CHILD THAT TAKES AN EXPRESSION. A `description:` beside it does
         not, and admitting the whole `outputs` block would let one through. */
      if (/^\s{4}value:/u.test(line)) outputsValue = true;
      else if (/^\s{2}\S/u.test(line) || /^\s{4}[a-z-]+:/u.test(line)) outputsValue = false;
    }
    if (!/\$\{\{/u.test(line)) continue;
    if (section === "runs") continue;
    if (section === "outputs" && outputsValue) continue;
    found.push({ line: index + 1, section: section ?? "(document root)", text: line.trim() });
  }
  return found;
}

for (const manifest of MANIFESTS) {
  test(`${manifest.name} carries no expression GitHub's manifest loader would refuse`, () => {
    const offenders = offendingExpressions(readFileSync(manifest.path, "utf8"));
    assert.deepEqual(
      offenders,
      [],
      `${manifest.name} would fail to load on a GitHub runner. GitHub template-parses every string ` +
      "in an action manifest, so a `${{ ... }}` outside `runs:` and `outputs.<id>.value` is an " +
      "expression it must evaluate — and a context like `job` that an action cannot name refuses the " +
      "WHOLE FILE, so no step of this Action runs at all. Write the value as plain prose " +
      `(\`job.status\`, not the interpolation) in a description.\n` +
      offenders.map((entry) => `  line ${entry.line}, under \`${entry.section}:\` — ${entry.text}`).join("\n"),
    );
  });
}

/* ------------------------------------------------------------------ proved able to fail */

test("the rule rejects the exact shape that broke five probe scenarios", () => {
  /* THE REAL BYTES THAT FAILED, kept verbatim so this test is a record of the defect and not a
     paraphrase of it. */
  const broken = [
    "name: 'Abloh'",
    "inputs:",
    "  job-status:",
    "    description: >-",
    "      The status of the job this step is running inside, passed as `${{ job.status }}` by the",
    "      step Abloh's setup pull request appends.",
    "    required: false",
    "runs:",
    "  using: 'composite'",
    "  steps:",
    "    - shell: bash",
    "      run: echo ${{ inputs.job-status }}",
  ].join("\n");
  const offenders = offendingExpressions(broken);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].section, "inputs");
  assert.match(offenders[0].text, /job\.status/u);
});

test("the rule rejects an expression in a top-level description too", () => {
  const broken = "name: 'x'\ndescription: 'runs ${{ github.sha }}'\nruns:\n  using: 'composite'\n  steps: []\n";
  assert.equal(offendingExpressions(broken).length, 1);
});

test("the rule rejects an expression in an input DEFAULT, which GitHub parses the same way", () => {
  const broken = "inputs:\n  x:\n    default: ${{ github.sha }}\nruns:\n  using: 'composite'\n  steps: []\n";
  assert.equal(offendingExpressions(broken).length, 1);
});

test("the rule rejects an expression in an output's description while allowing its value", () => {
  /* THE NARROW CASE THE SECTION RULE EXISTS FOR. Admitting the whole `outputs` block would let a
     description through, and refusing the whole block would reject every real Action here. */
  const manifest = [
    "outputs:",
    "  results-path:",
    "    description: 'the path, see ${{ github.sha }}'",
    "    value: ${{ steps.environment_preflight.outputs.output-dir }}/attest-results.json",
    "runs:",
    "  using: 'composite'",
    "  steps: []",
  ].join("\n");
  const offenders = offendingExpressions(manifest);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].text, /description/u);
});

test("the rule admits every expression under `runs:`, which is where they belong", () => {
  const manifest = [
    "runs:",
    "  using: 'composite'",
    "  steps:",
    "    - name: Upload",
    "      if: ${{ always() && inputs.publish != 'attestation-job' }}",
    "      env:",
    "        ABLOH_NODE: ${{ steps.abloh_runtime.outputs.node-path }}",
    "      run: echo ${{ github.sha }}",
  ].join("\n");
  assert.deepEqual(offendingExpressions(manifest), []);
});

test("the rule admits a real outputs value, so it does not reject the shipped file for the wrong reason", () => {
  const manifest = [
    "outputs:",
    "  results-path:",
    "    description: 'Runner-local attest-results.json path.'",
    "    value: ${{ steps.environment_preflight.outputs.output-dir }}/attest-results.json",
    "runs:",
    "  using: 'composite'",
    "  steps: []",
  ].join("\n");
  assert.deepEqual(offendingExpressions(manifest), []);
});

test("a full-line YAML comment may carry an expression, and the same text uncommented may not", () => {
  /*
   * BOTH DIRECTIONS, because this exemption is the one place the rule deliberately looks away and a
   * one-directional test would not notice if it looked away from everything. The comment form is the
   * shape `action.yml` itself now uses to explain the defect.
   */
  const commented = [
    "inputs:",
    "  job-status:",
    "    # a `${{ job.status }}` here would refuse the whole file, which is why this line is a comment",
    "    description: 'the caller job.status context'",
    "runs:",
    "  using: 'composite'",
    "  steps: []",
  ].join("\n");
  assert.deepEqual(offendingExpressions(commented), []);

  const uncommented = commented.replace("    # a `", "    x: a `");
  assert.equal(offendingExpressions(uncommented).length, 1);
});

test("an indented comment is still a comment", () => {
  assert.deepEqual(offendingExpressions("inputs:\n      # ${{ job.status }}\nruns:\n  steps: []\n"), []);
});
