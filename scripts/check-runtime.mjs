import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (major !== 22 || !Number.isInteger(minor) || minor < 12) {
    throw new Error(
      `Node ${version} is not the supported runtime. Use Node 22.12+ (see .nvmrc), open a new terminal, then run pnpm install and pnpm run setup.`,
    );
  }
}

export function runPrisma(args, cwd = root) {
  const cli = path.join(root, "node_modules", "prisma", "build", "index.js");
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: process.env,
    stdio: "inherit",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`prisma ${args.join(" ")} failed. Run pnpm run setup; do not reset an existing database.`);
  }
}

export async function checkNativeClient() {
  try {
    await import("node-datachannel");
  } catch (cause) {
    throw new Error(
      "The built-in torrent client's native module could not load. Use the Node version in .nvmrc, reopen the terminal, then run pnpm rebuild node-datachannel and pnpm run doctor. Native downloads may be blocked by your network.",
      { cause },
    );
  }
}

export async function checkMediaTools() {
  const [{ default: ffmpeg }, { default: ffprobe }] = await Promise.all([
    import("ffmpeg-static"),
    import("ffprobe-static"),
  ]);
  for (const [name, executable] of [["ffmpeg", ffmpeg], ["ffprobe", ffprobe.path]]) {
    const result = typeof executable === "string"
      ? spawnSync(executable, ["-version"], { stdio: "ignore", timeout: 10_000, windowsHide: true })
      : null;
    if (!result || result.error || result.status !== 0) {
      throw new Error(
        `${name} could not run. Reinstall the locked dependencies with pnpm install, check native-download errors and pnpm build approvals, then run pnpm run doctor.`,
      );
    }
  }
}

export async function checkBuildTools() {
  try {
    const { transform } = await import("esbuild");
    await transform("const ready: boolean = true;", { loader: "ts" });
  } catch (cause) {
    throw new Error(
      "The TypeScript script runner's esbuild binary could not run. Reinstall locked dependencies and check pnpm build approvals, then run pnpm run doctor.",
      { cause },
    );
  }
}

export async function checkRuntime() {
  assertNodeVersion();
  await checkNativeClient();
  await checkMediaTools();
  await checkBuildTools();
  runPrisma(["migrate", "status"]);
  console.log("Runtime, built-in torrent client, media tools and database migrations are ready.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkRuntime().catch((error) => {
    console.error(error.message);
    if (error.cause) console.error(error.cause.message);
    process.exitCode = 1;
  });
}
