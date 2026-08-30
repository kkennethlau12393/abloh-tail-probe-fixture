/**
 * INVARIANT 3, HALF ONE: our Action step carries no CI secrets, by default.
 *
 * Written as a lint on the file we publish, because that is the only file in this arrangement we
 * control. The honest boundary is stated plainly rather than papered over: a GitHub Actions step
 * inherits job-level `env`, so if a customer writes a secret at job level it IS in the abloh step's
 * process environment, because it is in every step's process environment. Abloh cannot un-write
 * somebody else's workflow.
 *
 * What abloh CAN do is three things, and this file holds the first two:
 *
 *   1. Publish a template whose every secret is scoped to the step that needs it, so a customer who
 *      copies our file is never in that state to begin with.
 *   2. Declare no `env` on the abloh step at all, so the step asks for nothing.
 *   3. Never let anything the job environment carries cross into the seal - which is invariant 2,
 *      enforced in `packages/engine-v2` and tested there, and the only part that is actually a
 *      guarantee rather than a recommendation.
 *
 * THE LINT IS TEXT-BASED ON PURPOSE. What a customer copies is bytes, and a parser that normalized
 * the file would pass a template whose indentation put a secret somewhere else.
 *
 * AND IT IS PROVED ABLE TO FAIL. `docs/lessons/verifying-rules.md` governs this class of check: a
 * rule that only ever runs over one file that already passes it is indistinguishable from a rule
 * that returns nothing. Every rule below is therefore run twice - once over the published template,
 * and once over a deliberately broken copy of it that the rule must reject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = join(HERE, "workflow-template.yml");
const TEMPLATE = readFileSync(TEMPLATE_PATH, "utf8");

/** The job's own keys - `runs-on`, `permissions`, `steps` - sit four spaces under the job name. */
const JOB_KEY_INDENT = 4;
/** A step begins with a list dash at six spaces. */
const STEP_DASH_INDENT = 6;

/** Indentation of a line, or null for a blank or comment-only line. */
function indentOf(line) {
  if (line.trim() === "" || line.trim().startsWith("#")) return null;
  return line.length - line.trimStart().length;
}

/** Every line inside the one job, with its indent, so a scan can ask where a key sits. */
function jobBody(text) {
  const lines = text.split("\n");
  const jobsAt = lines.findIndex((line) => line === "jobs:");
  if (jobsAt < 0) return null;
  const body = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const indent = indentOf(line);
    if (indent === null) continue;
    if (indent === 0) break;
    body.push({ indent, trimmed: line.trim() });
  }
  return body;
}

/**
 * Every rule the published template must satisfy, each returning the violations it found.
 *
 * One list rather than one test each, so the negative half below can drive the SAME rule over a
 * broken file and require that it complains. A rule that cannot be pointed at arbitrary text is a
 * rule nobody can check.
 */
const RULES = [
  {
    name: "measures pull requests and never pull_request_target",
    /* `pull_request_target` hands base-repository secrets to code a contributor proposed. The
       Action refuses the event at its boundary; the template must not offer it in the first place,
       because a refusal a customer meets after copying a file is a worse teacher than a file that
       never suggested it. */
    check(text) {
      const violations = [];
      if (!text.includes("on: [pull_request]")) violations.push("the template must trigger on pull_request");
      if (text.includes("pull_request_target")) violations.push("the template must never name pull_request_target");
      return violations;
    },
    breaks: (text) => text.replace("on: [pull_request]", "on: [pull_request_target]"),
  },
  {
    name: "grants exactly the two permissions abloh needs",
    /* `contents: read` to check out, `id-token: write` to mint the short-lived, audience-bound
       gateway identity. No write scope of any kind: the Action never receives a GitHub write
       token, and a template that asked for one would be teaching a permission nothing uses. */
    check(text) {
      const body = jobBody(text);
      if (body === null) return ["the template must declare jobs at the top level"];
      const at = body.findIndex((entry) => entry.indent === JOB_KEY_INDENT && entry.trimmed === "permissions:");
      if (at < 0) return ["the job must declare permissions rather than inherit the default set"];
      const granted = [];
      for (const entry of body.slice(at + 1)) {
        if (entry.indent <= JOB_KEY_INDENT) break;
        granted.push(entry.trimmed);
      }
      const expected = ["contents: read", "id-token: write"];
      return granted.join("|") === expected.join("|") ? [] : [`permissions are ${granted.join(", ")}`];
    },
    breaks: (text) => text.replace("      contents: read\n", "      contents: write\n"),
  },
  {
    name: "declares no secret at job level, where every step would inherit it",
    check(text) {
      const body = jobBody(text);
      if (body === null) return ["the template must declare jobs at the top level"];
      return body.some((entry) => entry.indent === JOB_KEY_INDENT && entry.trimmed === "env:")
        ? ["the template declares a job-level env block; secrets belong to the step that needs them"]
        : [];
    },
    breaks: (text) =>
      text.replace(
        "    runs-on: ubuntu-latest\n",
        "    runs-on: ubuntu-latest\n    env:\n      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n",
      ),
  },
  {
    name: "keeps every secret reference inside a step's own env block",
    /* Walk the steps and record, for each `${{ secrets.* }}` reference, the step-level `env:` it
       sits under. A reference anywhere else - a `with:` input, a `run:` line, the job - is a
       secret the abloh step would inherit. */
    check(text) {
      const body = jobBody(text);
      if (body === null) return ["the template must declare jobs at the top level"];
      const violations = [];
      let stepEnvIndent = null;
      let sawReference = false;
      for (const entry of body) {
        if (entry.indent === STEP_DASH_INDENT && entry.trimmed.startsWith("- ")) stepEnvIndent = null;
        if (entry.trimmed === "env:" && entry.indent > STEP_DASH_INDENT) {
          stepEnvIndent = entry.indent;
          continue;
        }
        if (stepEnvIndent !== null && entry.indent <= stepEnvIndent) stepEnvIndent = null;
        if (!entry.trimmed.includes("${{ secrets.")) continue;
        sawReference = true;
        if (stepEnvIndent === null) violations.push(`a secret is referenced outside a step env block: ${entry.trimmed}`);
      }
      /* A template with no secret in it at all would pass the loop above while teaching nothing,
         and the step-scoped shape is the entire point of publishing this file. */
      if (!sawReference) violations.push("the template must demonstrate at least one step-scoped secret");
      return violations;
    },
    breaks: (text) => text.replace("        env:\n          # Step-scoped, never job-scoped. See rule 1 above.\n", "        env2:\n"),
  },
  {
    name: "gives the abloh step no environment of its own",
    check(text) {
      const body = jobBody(text);
      if (body === null) return ["the template must declare jobs at the top level"];
      const at = body.findIndex((entry) => entry.trimmed.includes("abloh-action@"));
      if (at < 0) return ["the template must invoke the abloh action"];
      const violations = [];
      for (const entry of body.slice(at + 1)) {
        if (entry.indent <= STEP_DASH_INDENT) break;
        if (entry.trimmed === "env:") violations.push("the abloh step must not declare env: it needs no secret of yours");
        if (entry.trimmed.includes("${{ secrets.")) violations.push(`the abloh step must reference no secret: ${entry.trimmed}`);
      }
      return violations;
    },
    breaks: (text) =>
      `${text.trimEnd()}\n        env:\n          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}\n`,
  },
  {
    name: "runs abloh after the caller's own install and build",
    /* THE SHAPE THE WHOLE DESIGN RESTS ON. Abloh measures inside the environment the customer's
       own CI built. A template that invoked abloh before the install would hand it an empty tree,
       which looks exactly like a repository that has no build step and would be measured as one. */
    check(text) {
      const body = jobBody(text);
      if (body === null) return ["the template must declare jobs at the top level"];
      const positionOf = (needle) => body.findIndex((entry) => entry.trimmed.includes(needle));
      const install = positionOf("install --frozen-lockfile");
      const build = positionOf("run: pnpm build");
      const abloh = positionOf("abloh-action@");
      const violations = [];
      if (install < 0 || build < 0) violations.push("the template must show an install step and a build step");
      if (install >= 0 && abloh >= 0 && install > abloh) violations.push("the caller's install must run before abloh");
      if (build >= 0 && abloh >= 0 && build > abloh) violations.push("the caller's build must run before abloh");
      return violations;
    },
    breaks: (text) => text.replace("      - run: pnpm build\n", "").replace(/\n$/u, "\n      - run: pnpm build\n"),
  },
  {
    name: "pins every action to a 40-character SHA",
    /* A tag can be moved under a customer by whoever owns it, and this file is the one we hand out. */
    check(text) {
      const body = jobBody(text);
      if (body === null) return ["the template must declare jobs at the top level"];
      const violations = [];
      for (const entry of body) {
        const match = /uses:\s+(\S+)/u.exec(entry.trimmed);
        if (match !== null && !/@[0-9a-f]{40}$/u.test(match[1])) violations.push(`unpinned action reference: ${entry.trimmed}`);
      }
      return violations;
    },
    breaks: (text) => text.replace(/actions\/checkout@[0-9a-f]{40}/u, "actions/checkout@v4"),
  },
];

test("the preflight says which runner image the run is about to inherit", async () => {
  /* EVERY RUN RECORDS WHICH ENVIRONMENT IT INHERITED, and the Action's own step is the first place
     a reader can see it - before the CLI has started, and above whatever the run goes on to say.
     The image id is a disclosure and never a carry key: GitHub reissues its hosted images roughly
     weekly, and treating that as an environment change would cost every customer every stored
     verdict every week for a change nothing they run can see. */
  const { describeInheritedRunner } = await import("./action-boundary.mjs");
  assert.equal(
    describeInheritedRunner({ ImageOS: "ubuntu24", ImageVersion: "20260801.1", RUNNER_OS: "Linux", RUNNER_ARCH: "X64" }),
    "Abloh: measuring inside the environment this job prepares - runner image ubuntu24 20260801.1 on Linux/X64\n",
  );
  /* A self-hosted runner sets none of them, and an unknown image is stated as unknown rather than
     silently dropped - an omitted field reads as "there was nothing to inherit". */
  assert.equal(
    describeInheritedRunner({}),
    "Abloh: measuring inside the environment this job prepares - runner image unknown unknown on unknown/unknown\n",
  );
});

for (const rule of RULES) {
  test(`the published workflow ${rule.name}`, () => {
    assert.deepEqual(rule.check(TEMPLATE), [], `${TEMPLATE_PATH} violates: ${rule.name}`);
  });

  test(`the lint catches a workflow that does not ${rule.name}`, () => {
    const broken = rule.breaks(TEMPLATE);
    assert.notEqual(broken, TEMPLATE, "the mutation must actually change the template");
    assert.notDeepEqual(rule.check(broken), [], `the rule passed a template that breaks it: ${rule.name}`);
  });
}
