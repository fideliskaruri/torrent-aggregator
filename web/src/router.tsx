import type { ComponentType } from "react";
import {
  createBrowserRouter,
  Navigate,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
  type RouteObject,
} from "react-router";
import RootLayout from "@/app/layout";
import { NotFoundPage } from "@/app/not-found";
import { CapabilityGuard } from "@/components/layout/capability-guard";
import { TfEmptyState } from "@/components/tf/empty-state";
import { isChunkLoadError, reloadForNewBuild } from "@/lib/chunk-reload";
import { RefreshCw, TriangleAlert } from "lucide-react";

/** Each `src/app/.../page.tsx` becomes a lazily loaded route, like Next.js page chunks. */
function page(load: () => Promise<{ default: ComponentType }>): Pick<RouteObject, "lazy"> {
  return {
    lazy: async () => {
      try {
        return { Component: (await load()).default };
      } catch (error) {
        // An update replaced this tab's page chunks: reload into the new build instead of erroring.
        if (isChunkLoadError(error)) {
          const next = router.state.navigation.location;
          const href = next ? next.pathname + next.search + next.hash : undefined;
          if (reloadForNewBuild(href)) return new Promise<never>(() => {});
        }
        throw error;
      }
    },
  };
}

/** 404s show the not-found view; anything else gets a friendly error inside the app shell. */
function RouteBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  const update = isChunkLoadError(error);
  return (
    <div className="container-app min-w-0 py-8 sm:py-12" data-route-error>
      <TfEmptyState
        icon={update ? RefreshCw : TriangleAlert}
        title={update ? "TorrentFlow was updated" : "This page hit a problem"}
        headingLevel={1}
        description={
          update
            ? "Reload to get the latest version."
            : "Reload to try again. If it keeps happening, go back to Browse."
        }
        actionLabel="Reload"
        actionHref={window.location.pathname + window.location.search}
        onAction={(event) => {
          event.preventDefault();
          window.location.reload();
        }}
      />
    </div>
  );
}

/** The Library used to live at /watchlist; keep old links and bookmarks working. */
function LibraryRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={`/library${search}${hash}`} replace />;
}

const routes: RouteObject[] = [
  {
    path: "/",
    Component: RootLayout,
    errorElement: <RouteBoundary />,
    HydrateFallback: () => null,
    children: [
      {
        errorElement: <RouteBoundary />,
        // One guard for every page: routes someone can't use show "Not available" instead of mounting.
        Component: CapabilityGuard,
        children: [
          { index: true, ...page(() => import("@/app/page")) },
          { path: "search", ...page(() => import("@/app/search/page")) },
          { path: "everything", ...page(() => import("@/app/everything/page")) },
          { path: "library", ...page(() => import("@/app/watchlist/page")) },
          { path: "watchlist", Component: LibraryRedirect },
          { path: "watch/*", element: <Navigate to="/" replace /> },
          { path: "title/:workKey", ...page(() => import("@/app/title/[workKey]/page")) },
          { path: "downloads", ...page(() => import("@/app/downloads/page")) },
          { path: "activity", ...page(() => import("@/app/activity/page")) },
          { path: "history", ...page(() => import("@/app/history/page")) },
          { path: "notifications", ...page(() => import("@/app/notifications/page")) },
          { path: "client", ...page(() => import("@/app/client/page")) },
          { path: "rules", ...page(() => import("@/app/rules/page")) },
          { path: "requests", ...page(() => import("@/app/requests/page")) },
          { path: "settings", ...page(() => import("@/app/settings/page")) },
          { path: "settings/library", ...page(() => import("@/app/settings/library/page")) },
          { path: "about", ...page(() => import("@/app/about/page")) },
          { path: "*", Component: NotFoundPage },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
