import prisma from "@/lib/prisma";
import { recordComponentHealth } from "./health";

type ReadinessProbe = () => Promise<unknown>;

export async function checkDatabaseReadiness(): Promise<{
  ready: boolean;
  latencyMs: number;
}>;
export async function checkDatabaseReadiness(
  probe: ReadinessProbe,
): Promise<{ ready: boolean; latencyMs: number }>;
export async function checkDatabaseReadiness(
  probe: ReadinessProbe = () =>
    prisma.acquisitionTarget.findFirst({ select: { id: true } }),
): Promise<{
  ready: boolean;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  try {
    // Query the newest required app table rather than the SQLite connection
    // itself. SELECT 1 also succeeds before migrations, while the app does not.
    await probe();
    recordComponentHealth("database", "success", "DATABASE_READY");
    return { ready: true, latencyMs: Date.now() - startedAt };
  } catch {
    recordComponentHealth("database", "failure", "DATABASE_UNAVAILABLE");
    return { ready: false, latencyMs: Date.now() - startedAt };
  }
}
