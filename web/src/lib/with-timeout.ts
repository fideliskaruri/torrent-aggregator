/** Race `promise` against a wall-clock timeout. Clears the timer when `promise` settles. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = "Operation timed out.",
): Promise<T> {
  if (!Number.isFinite(ms) || ms < 0) {
    return Promise.reject(new Error("Timeout duration must be a non-negative finite number."));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([
    promise.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }),
    timeout,
  ]);
}
