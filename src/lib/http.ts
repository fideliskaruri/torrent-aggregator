/**
 * Safely parse a fetch Response as JSON.
 * Avoids "Unexpected end of JSON input" on empty/HTML error bodies.
 */
export async function readJsonResponse<T = unknown>(
  res: Response,
): Promise<{ data: T | null; text: string; ok: boolean; status: number }> {
  const text = await res.text();
  if (!text.trim()) {
    return {
      data: null,
      text: "",
      ok: res.ok,
      status: res.status,
    };
  }
  try {
    return {
      data: JSON.parse(text) as T,
      text,
      ok: res.ok,
      status: res.status,
    };
  } catch {
    return {
      data: null,
      text: text.slice(0, 400),
      ok: res.ok,
      status: res.status,
    };
  }
}
