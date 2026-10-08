// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../../shared/config/settings";

/**
 * The structural guard behind docs/deployment.md, "Secrets at runtime":
 * no private runtimeConfig value in nuxt.config.ts — including what is
 * handed to the Supabase module — may take its default from process.env.
 * A build-time default is BAKED into the server bundle by whatever the
 * build environment holds (a laptop's .env baked nine secrets into
 * .output-check on 2026-10-08); an empty default is overridden at run
 * time under the NUXT_ name and bakes nothing.
 */

const NUXT_CONFIG = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../nuxt.config.ts");

/** The text of the `{…}` block that follows `<key>: {` in `source`, braces balanced. */
function blockAfter(source: string, key: string): string {
  const m = new RegExp(`(^|\\n)\\s*${key}:\\s*\\{`).exec(source);
  if (!m) throw new Error(`no "${key}: {" block in the source`);
  let i = source.indexOf("{", m.index + m[0].length - 1);
  const start = i;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced "${key}: {" block`);
}

/** The lines of a runtimeConfig block that read process.env outside its `public:` part, with the key each sets. */
export function processEnvDefaults(runtimeConfigBlock: string): string[] {
  const publicPart = /(^|\n)\s*public:\s*\{/.test(runtimeConfigBlock) ? blockAfter(runtimeConfigBlock, "public") : "";
  const privatePart = runtimeConfigBlock.replace(publicPart, "");
  return privatePart
    .split("\n")
    .filter((line) => /process\.env\./.test(line) && !/^\s*\/\//.test(line))
    .map((line) => line.trim());
}

describe("no private runtimeConfig value takes its default from the build environment", () => {
  const source = readFileSync(NUXT_CONFIG, "utf8");
  const runtimeConfig = blockAfter(source, "runtimeConfig");

  it("nuxt.config.ts: every private default is a literal, the Supabase keys included", () => {
    expect(processEnvDefaults(runtimeConfig)).toEqual([]);
    // The Supabase module's own options block must not hand it a secret from the environment either.
    const supabaseOptions = blockAfter(source, "supabase");
    expect(supabaseOptions).not.toMatch(/(secretKey|serviceKey)\s*:\s*process\.env/);
  });

  it("every registered private setting has an entry in runtimeConfig", () => {
    for (const s of SETTINGS.filter((s) => !s.config.startsWith("public.") && !s.config.startsWith("supabase."))) {
      expect(runtimeConfig, `${s.config} (${s.env}) is missing from runtimeConfig`).toMatch(new RegExp(`(^|\\n)\\s*${s.config}:\\s*""`));
    }
    expect(runtimeConfig).toMatch(/supabase:\s*\{[^}]*secretKey:\s*""/);
  });

  it("fails on a config that reads a secret from process.env (non-vacuous)", () => {
    const broken = `  runtimeConfig: {
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    anthropicApiKey: "",
    supabase: { secretKey: process.env.NUXT_SUPABASE_SECRET_KEY },
    public: {
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL ?? "",
    },
  }`;
    const found = processEnvDefaults(blockAfter(broken, "runtimeConfig"));
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("stripeSecretKey");
    expect(found[1]).toContain("secretKey");
  });
});
