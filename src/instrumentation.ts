/**
 * Next.js calls this once per server process, before handling requests.
 *
 * Gated on the Node runtime: the edge bundle has no Prisma and no long-lived
 * process to schedule against, so importing the scheduler there would fail the
 * build rather than do anything useful.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAutomationScheduler } = await import(
    "@/lib/automation/scheduler"
  );
  startAutomationScheduler();
  // Speculative swarm pre-probing was reachable only from a route action that
  // nothing ever sends; arm it on its own timer so it genuinely runs.
  const { startPreProbeScheduler } = await import(
    "@/lib/prewarm/preprobe-scheduler"
  );
  startPreProbeScheduler();
  // Stream-only retention is otherwise just a manual Settings button. Arm the
  // proven fail-closed sweep on its own timer, alongside pre-probing.
  const { startRetentionSweepScheduler } = await import(
    "@/lib/library/retention-sweep-scheduler"
  );
  startRetentionSweepScheduler();
  const { startBuiltinEngineRuntime } = await import(
    "@/lib/clients/builtin-engine"
  );
  startBuiltinEngineRuntime();
}
