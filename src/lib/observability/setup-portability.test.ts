import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withScratchDirSync } from "../test-support/scratch-dir";
import { ensureLocalEnv } from "../../../scripts/setup.mjs";
import { assertNodeVersion } from "../../../scripts/check-runtime.mjs";

withScratchDirSync("setup-portability", (directory) => {
  fs.writeFileSync(path.join(directory, ".env.example"), 'DATABASE_URL="file:./dev.db"\n');
  assert.equal(ensureLocalEnv(directory), true);
  assert.equal(fs.readFileSync(path.join(directory, ".env"), "utf8"), 'DATABASE_URL="file:./dev.db"\n');
  fs.writeFileSync(path.join(directory, ".env"), 'DATABASE_URL="file:./existing.db"\n');
  assert.equal(ensureLocalEnv(directory), false);
  assert.match(fs.readFileSync(path.join(directory, ".env"), "utf8"), /existing\.db/);
  fs.unlinkSync(path.join(directory, ".env.example"));
  assert.throws(() => ensureLocalEnv(directory), /ENOENT/);

  for (const version of ["22.12.0", "22.17.0", "22.23.2"]) assert.doesNotThrow(() => assertNodeVersion(version));
  for (const version of ["20.19.0", "22.11.0", "24.19.0", "invalid"]) {
    assert.throws(() => assertNodeVersion(version), /supported runtime/);
  }

  const lock = fs.readFileSync("pnpm-lock.yaml", "utf8");
  assert.match(lock, /lockfileVersion: ['"]9\.0['"]/);
  assert.match(lock, /range-parser@1\.3\.0/);
  const workspace = fs.readFileSync("pnpm-workspace.yaml", "utf8");
  for (const name of [
    "@prisma/engines",
    "bufferutil",
    "esbuild",
    "ffmpeg-static",
    "node-datachannel",
    "prisma",
    "unrs-resolver",
    "utf-8-validate",
    "utp-native",
  ]) {
    const key = name.includes("/") ? `"${name}"` : name;
    assert.match(workspace, new RegExp(`^  ${key}: true$`, "m"));
  }
  assert.match(workspace, /^  ip-set: true$/m);
  console.log("PASS setup preserves env, enforces tested runtime, and uses pnpm build approvals");
});
