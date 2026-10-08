// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * The guard behind CLAUDE.md's "hosted harness runs never write into an
 * append-only table": every CI step that runs a LOCAL-ONLY script must
 * carry SUPABASE_LOCAL=true, in the step's env or the job's. Without it
 * the script refuses (exit 1) or, for the gated session harnesses,
 * skips every case and passes — which is what CI run 37727683375 did
 * when a new step was inserted between verify:ledger's `run` line and
 * its `env` block. ci.yml never runs locally, so nothing else catches
 * a step split from its env.
 *
 * Nothing here is hard-coded. The local-only scripts are DERIVED from
 * their source: a script is local-only when it calls one of the two
 * gates exported by scripts/_env.mjs (requireLocalStack, localOnlyOrSkip),
 * which is the marker every such script uses instead of an inline
 * guard. The npm script names come from package.json. The steps come
 * from parsing the workflow, including commands inside a `&&` chain.
 */

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const SCRIPTS = resolve(ROOT, "scripts");
const WORKFLOW = resolve(ROOT, ".github/workflows/ci.yml");
const FIXTURE = resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures/ci-ledger-step-without-local.yml");

/** The gates a local-only script calls; each must be exported by scripts/_env.mjs. */
const GATES = ["requireLocalStack", "localOnlyOrSkip"];
/** How scripts/_env.mjs reads SUPABASE_LOCAL (LOCAL_MODE). */
const TRUTHY = /^(1|true|yes)$/i;

/** Scripts under scripts/ (by base name, e.g. "verify-ledger") that call a gate. */
function localOnlyScripts(): string[] {
  const envSource = readFileSync(resolve(SCRIPTS, "_env.mjs"), "utf8");
  for (const gate of GATES) {
    if (!new RegExp(`^export function ${gate}\\(`, "m").test(envSource)) {
      throw new Error(`scripts/_env.mjs no longer exports ${gate}; the marker this guard reads moved`);
    }
  }
  const call = new RegExp(`^\\s*(?:await\\s+)?(?:${GATES.join("|")})\\(`, "m");
  return readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
    .filter((f) => call.test(readFileSync(resolve(SCRIPTS, f), "utf8")))
    .map((f) => f.replace(/\.mjs$/, ""))
    .sort();
}

/** npm script name → the scripts/ base names it runs, following `npm run x` inside a script. */
function npmScriptTargets(): Map<string, string[]> {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const direct = new Map<string, Set<string>>();
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    direct.set(name, new Set([...cmd.matchAll(/scripts\/([\w.-]+)\.mjs/g)].map((m) => m[1]!)));
  }
  const resolved = new Map<string, string[]>();
  const visit = (name: string, seen: Set<string>): Set<string> => {
    const out = new Set(direct.get(name) ?? []);
    for (const m of (pkg.scripts[name] ?? "").matchAll(/npm run (?:-s )?([\w:.-]+)/g)) {
      const inner = m[1]!;
      if (!seen.has(inner)) for (const t of visit(inner, new Set([...seen, inner]))) out.add(t);
    }
    return out;
  };
  for (const name of Object.keys(pkg.scripts)) resolved.set(name, [...visit(name, new Set([name]))].sort());
  return resolved;
}

/** Scripts/ base names a shell command runs, through `npm run x` or `node scripts/x.mjs`. */
function targetsOfCommand(run: string, npmTargets: Map<string, string[]>): { script: string; via: string }[] {
  const out: { script: string; via: string }[] = [];
  for (const m of run.matchAll(/npm run (?:-s )?([\w:.-]+)/g)) {
    for (const script of npmTargets.get(m[1]!) ?? []) out.push({ script, via: `npm run ${m[1]}` });
  }
  for (const m of run.matchAll(/node (?:--[\w-]+ )*scripts\/([\w.-]+)\.mjs/g)) out.push({ script: m[1]!, via: m[0] });
  return out;
}

interface Workflow {
  env?: Record<string, unknown>;
  jobs: Record<string, { name?: string; env?: Record<string, unknown>; steps: { name?: string; run?: string; env?: Record<string, unknown> }[] }>;
}

/** Every (job, step, harness) where a local-only script runs without SUPABASE_LOCAL=true. */
function violations(workflowYaml: string, localOnly: string[], npmTargets: Map<string, string[]>): string[] {
  const wf = parse(workflowYaml) as Workflow;
  const out: string[] = [];
  for (const [jobId, job] of Object.entries(wf.jobs)) {
    for (const [i, step] of job.steps.entries()) {
      if (!step.run) continue;
      const env = { ...(wf.env ?? {}), ...(job.env ?? {}), ...(step.env ?? {}) };
      const ok = TRUTHY.test(String(env.SUPABASE_LOCAL ?? ""));
      for (const { script, via } of targetsOfCommand(step.run, npmTargets)) {
        if (localOnly.includes(script) && !ok) {
          out.push(`job "${jobId}"${job.name ? ` (${job.name})` : ""}, step ${i + 1} "${step.name ?? step.run.trim()}": runs the local-only script ${script} (${via}) without SUPABASE_LOCAL=true in the step's or the job's env`);
        }
      }
    }
  }
  return out;
}

describe("CI runs every local-only script with SUPABASE_LOCAL=true", () => {
  const localOnly = localOnlyScripts();
  const npmTargets = npmScriptTargets();
  const workflow = readFileSync(WORKFLOW, "utf8");

  it("derives the local-only scripts from their gate call, and finds the ones we know", () => {
    expect(localOnly).toContain("verify-ledger");
    expect(localOnly).toContain("verify-audit");
    expect(localOnly).toContain("ci-start-app");
    expect(localOnly.length).toBeGreaterThanOrEqual(5);
  });

  it("maps every local-only verify harness to an npm script that runs it", () => {
    for (const script of localOnly.filter((s) => s.startsWith("verify-"))) {
      const names = [...npmTargets].filter(([, targets]) => targets.includes(script)).map(([name]) => name);
      expect(names, `${script} has no npm script`).not.toHaveLength(0);
    }
  });

  it("the workflow's steps running them all carry SUPABASE_LOCAL (non-vacuous: at least one such step per job that runs one)", () => {
    expect(violations(workflow, localOnly, npmTargets)).toEqual([]);
    const wf = parse(workflow) as Workflow;
    const running = Object.values(wf.jobs).flatMap((j) => j.steps).filter((s) => s.run && targetsOfCommand(s.run, npmTargets).some((t) => localOnly.includes(t.script)));
    expect(running.length).toBeGreaterThanOrEqual(3); // app start, verify:ledger, verify:audit at least
  });

  it("fails on the copy of the workflow with the cc9b771 bug reintroduced, naming the job, step and harness", () => {
    const found = violations(readFileSync(FIXTURE, "utf8"), localOnly, npmTargets);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/job "e2e"/);
    expect(found[0]).toMatch(/verify:ledger against the running app/);
    expect(found[0]).toMatch(/verify-ledger \(npm run verify:ledger\)/);
  });

  it("fails on the real workflow with every SUPABASE_LOCAL removed, once per step that runs one (drift-proof)", () => {
    const stripped = workflow.replace(/^\s*SUPABASE_LOCAL:.*\n/gm, "");
    expect(stripped).not.toBe(workflow);
    const found = violations(stripped, localOnly, npmTargets);
    const wf = parse(workflow) as Workflow;
    const expected = Object.values(wf.jobs).flatMap((j) => j.steps).flatMap((s) => (s.run ? targetsOfCommand(s.run, npmTargets).filter((t) => localOnly.includes(t.script)) : [])).length;
    expect(found).toHaveLength(expected);
    expect(expected).toBeGreaterThanOrEqual(3);
  });
});
