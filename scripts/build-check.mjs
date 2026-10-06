// Builds the app into its own folders (.nuxt-check, .output-check, a
// separate Vite cache; see buildCheck in apps/reserve/nuxt.config.ts), so a
// build for the e2e suite or CI never disturbs a running dev server.
//
//   npm run build:check
import { spawnSync } from "node:child_process";

const app = new URL("../apps/reserve/", import.meta.url);
console.log("Building @repo/reserve into .output-check…");
const r = spawnSync("npx", ["nuxt", "build"], {
  cwd: app,
  env: { ...process.env, RESERVE_BUILD_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
  encoding: "utf8",
});
if (r.status === 0) {
  console.log("@repo/reserve: builds");
  process.exit(0);
}
console.error("@repo/reserve: build failed");
console.error(r.stderr.split("\n").filter((l) => /error/i.test(l)).slice(0, 30).join("\n"));
process.exit(1);
