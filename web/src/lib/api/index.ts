import { readJsonBody } from "@/lib/api-json";
import { sessionAwareFetch } from "@/lib/session-expiry";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiResponse<T> extends Response {
  data: T | null;
  error: ApiError | null;
}

type RequestOptions = Omit<RequestInit, "body">;

export function get<T = unknown>(
  path: string,
  options?: RequestOptions,
): Promise<ApiResponse<T>> {
  return request<T>(path, { ...options, method: "GET" });
}

export function send<T = unknown>(
  path: string,
  {
    method,
    body,
    ...options
  }: RequestOptions & { method: string; body?: unknown },
): Promise<ApiResponse<T>> {
  const headers = new Headers(options.headers);
  let requestBody: BodyInit | null | undefined;

  if (body != null) {
    if (
      typeof body === "string" ||
      body instanceof Blob ||
      body instanceof FormData ||
      body instanceof URLSearchParams
    ) {
      requestBody = body;
    } else {
      requestBody = JSON.stringify(body);
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
    }
  }

  return request<T>(path, { ...options, headers, method, body: requestBody });
}

async function request<T>(
  path: string,
  init: RequestInit,
): Promise<ApiResponse<T>> {
  let response: Response;
  try {
    response = await sessionAwareFetch(path, init);
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    const message =
      cause instanceof Error &&
      /fetch/i.test(cause.message) &&
      /fail/i.test(cause.message)
        ? "Could not reach the server. Check that it is still running."
        : cause instanceof Error
          ? cause.message
          : "Something went wrong. Try again.";
    throw new ApiError(message);
  }

  const data = await readJsonBody<T>(response.clone());
  const serverMessage =
    data && typeof data === "object" && "error" in data &&
    typeof data.error === "string"
      ? data.error
      : null;
  const error = response.ok
    ? null
    : new ApiError(
        serverMessage || `Request failed (${response.status})`,
        response.status,
        data,
      );

  return Object.assign(response, { data, error }) as ApiResponse<T>;
}
