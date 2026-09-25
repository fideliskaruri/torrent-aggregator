import { createContext, useContext, useMemo } from "react";
import { useLocation, useNavigate, useParams as useRouterParams, useSearchParams as useRouterSearchParams } from "react-router";

/**
 * `next/navigation` for the SPA. `refresh()` re-mounts the current route (the
 * Next.js equivalent re-runs the server render, which is how pages re-read data).
 */
export const RouterRefreshContext = createContext<() => void>(() => {});

export interface AppRouterInstance {
  push(href: string, options?: { scroll?: boolean }): void;
  replace(href: string, options?: { scroll?: boolean }): void;
  back(): void;
  forward(): void;
  refresh(): void;
  prefetch(href: string): void;
}

export function useRouter(): AppRouterInstance {
  const navigate = useNavigate();
  const refresh = useContext(RouterRefreshContext);
  return useMemo(
    () => ({
      push: (href, options) => void navigate(href, { preventScrollReset: options?.scroll === false }),
      replace: (href, options) =>
        void navigate(href, { replace: true, preventScrollReset: options?.scroll === false }),
      back: () => void navigate(-1),
      forward: () => void navigate(1),
      refresh,
      prefetch: () => {},
    }),
    [navigate, refresh],
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}

export type ReadonlyURLSearchParams = URLSearchParams;

export function useSearchParams(): ReadonlyURLSearchParams {
  return useRouterSearchParams()[0];
}

export function useParams<T extends Record<string, string | string[]> = Record<string, string>>(): T {
  return useRouterParams() as unknown as T;
}

/** Thrown by `redirect()` / `notFound()`; the route error boundary turns it into navigation or a 404 view. */
export class NavigationSignal extends Error {
  constructor(
    readonly kind: "redirect" | "not-found",
    readonly href: string | null = null,
  ) {
    super(kind === "redirect" ? `NEXT_REDIRECT ${href}` : "NEXT_NOT_FOUND");
  }
}

export function redirect(href: string): never {
  throw new NavigationSignal("redirect", href);
}

export function permanentRedirect(href: string): never {
  throw new NavigationSignal("redirect", href);
}

export function notFound(): never {
  throw new NavigationSignal("not-found");
}
