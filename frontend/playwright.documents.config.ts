import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "documents.spec.ts",
  use: { baseURL: "http://localhost:3100" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium", channel: "chrome" } },
  ],
  webServer: [
    { command: "node tests/auth-fixture.mjs", url: "http://127.0.0.1:3101", reuseExistingServer: false },
    {
      command: "npm run dev -- --port 3100", url: "http://localhost:3100/login", reuseExistingServer: false,
      env: { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3101", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-only-key", NEXT_PUBLIC_API_URL: "http://localhost:3102" },
    },
  ],
});
