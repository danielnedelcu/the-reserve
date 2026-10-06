import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { LOCAL_MODE, get, guard } from "../../scripts/_env.mjs";

// What the journeys run against: the LOCAL stack only, through the same
// credential module and localhost guard the verify:* harnesses use.
// Export `supabase status -o env` and set SUPABASE_LOCAL=true, as
// scripts/ci-start-app.mjs requires; the app under test was started the
// same way, so the two agree on the URL and the keys.

export interface TestEnv {
  apiUrl: string;
  anonKey: string;
  baseUrl: string;
  /** Service-role client for fixtures and reads behind RLS. */
  db: SupabaseClient;
}

let cached: TestEnv | null = null;

export function testEnv(): TestEnv {
  if (cached) return cached;
  if (!LOCAL_MODE) {
    throw new Error("Refusing to run: the e2e suite needs the local stack (SUPABASE_LOCAL=true with `supabase status -o env` exported).");
  }
  guard(["NUXT_PUBLIC_SUPABASE_URL"]);
  const apiUrl = get("NUXT_PUBLIC_SUPABASE_URL") as string;
  const anonKey = get("NUXT_PUBLIC_SUPABASE_KEY") as string;
  const serviceKey = get("NUXT_SUPABASE_SECRET_KEY") as string;
  if (!anonKey || !serviceKey) throw new Error("Refusing to run: the local stack's keys are not in the environment.");
  cached = {
    apiUrl,
    anonKey,
    baseUrl: process.env.E2E_BASE_URL ?? "http://localhost:3300",
    db: createClient(apiUrl, serviceKey, { auth: { persistSession: false } }),
  };
  return cached;
}
