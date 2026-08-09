export const PRIVATE_DB_RUNS = [
  {
    name: "settings-upsert",
    cmd: "npx",
    args: ["tsx", "scripts/test-settings-upsert.ts"],
    timeout: 120_000,
  },
  {
    name: "ondemand-estimate",
    cmd: "npx",
    args: ["tsx", "scripts/test-ondemand-and-estimate.ts"],
    timeout: 180_000,
  },
  {
    name: "ondemand-advance",
    cmd: "npx",
    args: ["tsx", "scripts/test-ondemand-advance.ts"],
    timeout: 60_000,
  },
  {
    name: "builtin-send",
    cmd: "npx",
    args: ["tsx", "scripts/test-builtin-send.ts"],
    timeout: 180_000,
  },
  {
    name: "availability-seam",
    cmd: "npx",
    args: ["tsx", "scripts/test-availability-seam.mts"],
    timeout: 120_000,
  },
  {
    name: "browse-rails",
    cmd: "npx",
    args: ["tsx", "scripts/test-browse-rails.mts"],
    timeout: 120_000,
  },
];
