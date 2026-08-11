import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  snapshotDir: "./snapshots",
  snapshotPathTemplate:
    "{snapshotDir}/{projectName}/{testFileDir}/{testFileName}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3000",
    channel: "msedge",
    colorScheme: "dark",
  },
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.01,
      threshold: 0.05,
    },
  },
  projects: [
    {
      name: "Mobile-360",
      use: { viewport: { width: 360, height: 800 } },
    },
    {
      name: "Mobile-390",
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: "Tablet-768",
      use: { viewport: { width: 768, height: 1024 } },
    },
    {
      name: "Desktop-1280",
      use: { viewport: { width: 1280, height: 900 } },
    },
  ],
});
