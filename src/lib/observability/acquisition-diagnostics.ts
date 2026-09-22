import type { ClientConnectionConfig } from "@/lib/clients/types";
import { sanitizeLogFields, type SafeLogFields } from "./logging";

export function logAcquisitionDecision(
  config: Pick<ClientConnectionConfig, "verboseDiagnostics">,
  action: string,
  fields: SafeLogFields = {},
): void {
  if (config.verboseDiagnostics !== true) return;
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    component: "acquisition",
    ...sanitizeLogFields({ ...fields, action }),
  }));
}
