import { useCallback, useState } from "react";
import { ApiError, send } from "@/lib/api";

export function useApiMutation<TBody, TResult>(
  path: string,
  method = "POST",
): { run: (body: TBody) => Promise<TResult | null>; pending: boolean; error: string | null } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (body: TBody) => {
    setPending(true);
    setError(null);
    try {
      const result = await send<TResult>(path, { method, body });
      if (!result.ok) throw result.error ?? new ApiError(`Request failed (${result.status})`, result.status);
      return result.data;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Something went wrong. Try again.";
      setError(message);
      throw cause;
    } finally {
      setPending(false);
    }
  }, [method, path]);
  return { run, pending, error };
}
