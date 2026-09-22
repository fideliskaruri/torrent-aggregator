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

  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string; hasInstallScript?: boolean }>;
  };
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (entry.resolved) {
      assert.equal(new URL(entry.resolved).origin, "https://registry.npmjs.org", name);
    }
  }
  assert.match(lock.packages["node_modules/@playwright/test"].integrity ?? "", /^sha512-/);
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    allowScripts: Record<string, boolean>;
  };
  for (const name of ["node-datachannel@0.32.3", "ffmpeg-static@5.3.0", "@prisma/engines@7.9.0"]) {
    assert.equal(manifest.allowScripts[name], true, `${name} must be installable under npm 12`);
  }
  assert.equal(manifest.allowScripts["ip-set"], false);
  assert.equal(manifest.allowScripts["*"], undefined, "never approve arbitrary dependency scripts");
  const installedScriptVersions = new Set<string>();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || !entry.hasInstallScript) continue;
    const name = location.split("node_modules/").at(-1)!;
    const pin = `${name}@${entry.version}`;
    installedScriptVersions.add(pin);
    assert.ok(
      manifest.allowScripts[pin] === true || manifest.allowScripts[name] === false,
      `Review the install script policy for ${pin}`,
    );
  }
  for (const [pin, allowed] of Object.entries(manifest.allowScripts)) {
    if (allowed) assert.ok(installedScriptVersions.has(pin), `Stale script approval: ${pin}`);
  }
  console.log("PASS setup preserves env, enforces tested runtime, and uses public registry tarballs");
});
