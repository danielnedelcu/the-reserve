import { SETTINGS, readSetting } from "~~/shared/config/settings";

/**
 * At startup, one line per setting: set or NOT SET, with what refuses
 * without it — never a value. A deployment missing a secret shows it in
 * the first lines of its log instead of in a 503 found later by a client
 * (docs/deployment.md, "Secrets at runtime"; scripts/verify-build-secrets.mjs
 * asserts these lines when the built server starts with everything blank).
 */
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig() as unknown as Record<string, unknown>;
  const missing: string[] = [];
  const set: string[] = [];
  for (const s of SETTINGS) {
    const value = readSetting(config, s.config);
    const isSet = typeof value === "string" ? value.length > 0 : Boolean(value);
    if (isSet) set.push(s.env);
    else {
      console.warn(`[config] ${s.env}: NOT SET — ${s.without}`);
      missing.push(s.env);
    }
  }
  // One summary line either way (warn: the only console level the lint
  // rule allows besides error, and a startup line belongs in the log).
  console.warn(
    missing.length
      ? `[config] ${set.length} setting(s) set; ${missing.length} not set: ${missing.join(", ")}`
      : `[config] every setting is set (${set.length})`,
  );
});
