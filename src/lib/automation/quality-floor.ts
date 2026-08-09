import type { OnNoCandidateReason } from "@/lib/grab/types";

export function shouldRecordHuntMiss(reason: OnNoCandidateReason): boolean {
  return reason === "no_results" || reason === "no_match";
}
