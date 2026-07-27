export const LOADING_SHOW_DELAY_MS = 160;
export const LOADING_MIN_VISIBLE_MS = 320;

export type LoadingEvidenceInput = {
  loading: boolean;
  hasData: boolean;
  error: string | null;
};

export type LoadingEvidenceState = "loading" | "data" | "error" | "empty";

export function loadingEvidenceState({
  loading,
  hasData,
  error,
}: LoadingEvidenceInput): LoadingEvidenceState {
  if (hasData) return "data";
  if (error) return "error";
  if (loading) return "loading";
  return "empty";
}
