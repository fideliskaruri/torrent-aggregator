import type { ComponentType } from "react";
import {
  createBrowserRouter,
  isRouteErrorResponse,
  Navigate,
  useRouteError,
  type RouteObject,
} from "react-router";
import { NavigationSignal } from "next/navigation";
import RootLayout from "@/app/layout";
import { NotFoundPage } from "@/app/not-found";

/** Each `src/app/.../page.tsx` becomes a lazily loaded route, like Next.js page chunks. */
// Redirect-only pages (activity, client) return `never` from redirect(), like in Next.js.
function page(load: () => Promise<{ default: ComponentType | (() => void) }>): Pick<RouteObject, "lazy"> {
  return {
    lazy: async () => ({ Component: (await load()).default as ComponentType }),
  };
}

/** Turns `redirect()` / `notFound()` thrown during render into navigation or the 404 view. */
function RouteBoundary() {
  const error = useRouteError();
  if (error instanceof NavigationSignal) {
    if (error.kind === "redirect" && error.href) return <Navigate replace to={error.href} />;
    return <NotFoundPage />;
  }
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  throw error;
}

export const routes: RouteObject[] = [
  {
    path: "/",
    Component: RootLayout,
    HydrateFallback: () => null,
    children: [
      {
        errorElement: <RouteBoundary />,
        children: [
          { index: true, ...page(() => import("@/app/page")) },
          { path: "search", ...page(() => import("@/app/search/page")) },
          { path: "everything", ...page(() => import("@/app/everything/page")) },
          { path: "watchlist", ...page(() => import("@/app/watchlist/page")) },
          { path: "title/:workKey", ...page(() => import("@/app/title/[workKey]/page")) },
          { path: "downloads", ...page(() => import("@/app/downloads/page")) },
          { path: "activity", ...page(() => import("@/app/activity/page")) },
          { path: "history", ...page(() => import("@/app/history/page")) },
          { path: "notifications", ...page(() => import("@/app/notifications/page")) },
          { path: "client", ...page(() => import("@/app/client/page")) },
          { path: "rules", ...page(() => import("@/app/rules/page")) },
          { path: "settings", ...page(() => import("@/app/settings/page")) },
          { path: "about", ...page(() => import("@/app/about/page")) },
          { path: "*", Component: NotFoundPage },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
