import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: {
      args: ["--disable-features=WebRtcHideLocalIpsWithMdns"]
    },
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: "node tests/e2e/dev-server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 10_000
  }
});
