import { createServerClient } from "@supabase/ssr";
import type { BrowserContext } from "@playwright/test";
import { testEnv } from "./env";

/**
 * Sign a test staff member in without the login page: the password
 * sign-in runs HERE, through @supabase/ssr — the library the app itself
 * reads its auth cookies with — into an in-memory cookie jar, and the
 * cookies the library wrote are handed to the browser. Nothing in the app
 * knows about tests, and no cookie is hand-built: if the library changes
 * its cookie format or name, both sides change together, and a mismatch
 * shows as a signed-out page, never as a quiet pass.
 *
 * The cookie name is derived by the library from the Supabase URL; the app
 * under test was started with NUXT_PUBLIC_SUPABASE_COOKIE_PREFIX set from
 * the same URL (scripts/ci-start-app.mjs), which is what makes a laptop
 * build work against the local stack. The one journey that signs in
 * through the real login page (01-auth) proves the two agree.
 */
export async function signIn(context: BrowserContext, email: string, password: string): Promise<void> {
  const env = testEnv();
  const jar = new Map<string, string>();
  const client = createServerClient(env.apiUrl, env.anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach((c) => (c.value ? jar.set(c.name, c.value) : jar.delete(c.name))),
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Test sign-in failed: ${error.message}`);
  // The library writes its cookies just after the sign-in resolves.
  for (let i = 0; i < 20 && !jar.size; i++) await new Promise((r) => setTimeout(r, 25));
  if (!jar.size) throw new Error("Test sign-in wrote no cookies.");
  await context.addCookies(
    [...jar].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })),
  );
}
