import { defineConfig, devices } from "@playwright/test";

// End-to-end journeys (docs/testing-design.md, PR B). They run against the
// BUILT app on the e2e port, started by scripts/ci-start-app.mjs against
// the local Supabase stack — never the dev server on 3000, which points at
// the hosted project. Run with:
//
//   npm run build:check && npm run app:start && npm run test:e2e; npm run app:stop
//
// - One worker, in order: the journeys share one stack and one app.
// - Chromium only until a staging site exists over HTTPS (production
//   cookies are Secure; WebKit refuses them on plain-http localhost).
// - The browser runs in Los Angeles ON PURPOSE: The Reserve's location is
//   not there, and every time a journey asserts must be the LOCATION's, so
//   a page that formats by the browser clock fails here.
export default defineConfig({
  testDir: "./journeys",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3300",
    timezoneId: "America/Los_Angeles",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
