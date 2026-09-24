import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeVersion, checkNativeClient, checkMediaTools, checkBuildTools, root, runPrisma } from "./check-runtime.mjs";

export function ensureLocalEnv(directory = root) {
  const target = path.join(directory, ".env");
  try {
    fs.copyFileSync(path.join(directory, ".env.example"), target, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export async function setup() {
  assertNodeVersion();
  await checkNativeClient();
  await checkMediaTools();
  await checkBuildTools();
  const created = ensureLocalEnv();
  console.log(created ? "Created .env from .env.example." : "Keeping existing .env.");
  runPrisma(["generate"]);
  runPrisma(["migrate", "deploy"]);
  runPrisma(["migrate", "status"]);
  console.log("Setup complete. Run pnpm run dev, then choose your download folder and storage cap in Settings.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().catch((error) => {
    console.error(error.message);
    if (error.cause) console.error(error.cause.message);
    process.exitCode = 1;
  });
}
