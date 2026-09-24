import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4310",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  workers: 1,
  reporter: "list",
});
