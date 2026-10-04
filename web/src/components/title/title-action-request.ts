import { send } from "@/lib/api";
import type { TitleGrabResponse } from "./types";

export async function postAcquisition(
  workKey: string,
  body: Record<string, unknown>,
): Promise<TitleGrabResponse> {
  const response = await send<TitleGrabResponse>(
    `/api/title/${encodeURIComponent(workKey)}`,
    { method: "POST", body },
  );
  if (!response.ok || !response.data?.ok) {
    throw new Error(
      response.data?.message ??
        response.error?.message ??
        "Could not start this download. Try again.",
    );
  }
  return response.data;
}
