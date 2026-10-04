import { Link } from "react-router";
import { FolderTree, MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MaxActiveDownloadsControl } from "@/components/settings/max-active-downloads";
import { TfPageHeader } from "@/components/tf/page-header";
import { formatSpeed } from "@/lib/format";
import { cn } from "@/lib/utils";
import { needsAttentionLabel } from "./status-rollup";
import type { StatusFilter } from "./use-downloads-page-state";
import type { useDownloadsPage } from "./use-downloads-page";

type Model = ReturnType<typeof useDownloadsPage>;

function clientLabel(type: string) {
  if (type === "transmission") return "Transmission";
  if (type === "qbittorrent") return "qBittorrent";
  return "your torrent client";
}

export function DownloadPageHeader({ page }: { page: Model }) {
  const isBuiltin = page.clientType === "builtin";
  const clientUnavailable = page.offline && !isBuiltin;
  const stats = page.stats;
  const summaryParts: { id: StatusFilter; label: string; hook: string }[] = [
    ...(stats.total > 0 || page.lookingCount === 0
      ? [{ id: "all" as const, label: `${stats.total} ${stats.total === 1 ? "download" : "downloads"}`, hook: "total" }]
      : [{ id: "all" as const, label: `${page.lookingCount} looking for a release`, hook: "looking" }]),
    ...(stats.downloading > 0 ? [{ id: "downloading" as const, label: `${stats.downloading} downloading`, hook: "downloading" }] : []),
    ...(stats.queued > 0 ? [{ id: "queued" as const, label: `${stats.queued} queued`, hook: "queued" }] : []),
    ...(stats.done > 0 ? [{ id: "ready" as const, label: `${stats.done} ready`, hook: "ready" }] : []),
    ...(stats.paused > 0 ? [{ id: "paused" as const, label: `${stats.paused} paused`, hook: "paused" }] : []),
    ...(stats.error > 0
      ? [{ id: "attention" as const, label: needsAttentionLabel(stats.error), hook: "attention" }]
      : []),
  ];
  const liveSpeed = stats.downloading > 0 ? formatSpeed(stats.dlspeed) : null;

  return (
    <TfPageHeader
      title="Downloads"
      meta={clientUnavailable ? (
        <p className="flex items-center gap-2 text-[13px] text-destructive" data-client-status="offline">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
          Can&apos;t reach {clientLabel(page.clientType)}. Retrying automatically.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 text-[13px] tabular-nums text-muted-foreground lg:gap-x-1"
          data-client-status="connected" data-downloads-summary>
          <span className="inline-flex items-center gap-2 text-foreground"
            title={!isBuiltin && page.clientHost ? `${clientLabel(page.clientType)} at ${page.clientHost}` : undefined}
            data-client-connection>
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
            {isBuiltin ? "Connected" : `Connected to ${clientLabel(page.clientType)}`}
          </span>
          {summaryParts.map((part) => (
            <span key={part.id} className="inline-flex items-center">
              <span aria-hidden className="hidden px-1 text-subtle-foreground lg:inline">·</span>
              <Button type="button" variant="link" size="sm"
                className={cn("h-auto px-0 text-[13px] font-normal tabular-nums max-md:min-h-11 pointer-coarse:min-h-11",
                  part.id === "attention" ? "text-destructive" : "text-muted-foreground",
                  page.statusFilter === part.id && part.id !== "all" && "font-medium text-foreground underline")}
                aria-pressed={page.statusFilter === part.id}
                onClick={() => page.setStatusFilter(part.id)}
                data-summary-part={part.hook}
                data-stat-value={part.hook === "downloading" ? stats.downloading : part.hook === "queued" ? stats.queued : undefined}>
                {part.label}
              </Button>
            </span>
          ))}
          {liveSpeed ? (
            <span className="inline-flex items-center font-mono text-brand-foreground" data-summary-speed>
              <span aria-hidden className="hidden px-1 font-sans text-subtle-foreground lg:inline">·</span>↓ {liveSpeed}
            </span>
          ) : null}
          {isBuiltin && ((page.maxActive.limits && page.maxActive.value != null) || !page.maxActive.settled) ? (
            <span className={cn("inline-flex items-center whitespace-nowrap", !page.maxActive.settled && "invisible")}
              aria-hidden={!page.maxActive.settled || undefined} inert={!page.maxActive.settled}
              data-max-active-inline={page.maxActive.limits?.source ?? "pending"}>
              <span aria-hidden className="hidden px-1 text-subtle-foreground lg:inline">·</span>
              {page.maxActive.limits?.source === "schedule" ? (
                <>up to {page.maxActive.limits.effective} at once (
                  <Button asChild variant="link" size="sm"
                    className="h-auto px-0 text-[13px] font-normal text-muted-foreground underline max-md:min-h-11 pointer-coarse:min-h-11">
                    <Link to="/settings?tab=folders" data-max-active-schedule>download hours</Link>
                  </Button>)
                </>
              ) : (
                <>up to <MaxActiveDownloadsControl variant="inline" value={page.maxActive.value ?? 1}
                  onChange={page.maxActive.change} className="mx-1.5" /> at once</>
              )}
            </span>
          ) : null}
        </div>
      )}
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button type="button" variant="secondary" size="sm" onClick={() => void page.load()}
            aria-label="Refresh downloads" data-downloads-refresh>
            <RefreshCw className={cn("h-3.5 w-3.5", page.loading && "animate-spin")} />Refresh
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" aria-label="More download actions" data-downloads-more>
                <MoreHorizontal className="h-4 w-4" /><span className="sm:inline">More</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              {isBuiltin ? (
                <DropdownMenuItem disabled={page.tidying} onClick={() => void page.tidyFolders()} data-tidy-folders>
                  <FolderTree className={cn("h-3.5 w-3.5", page.tidying && "animate-pulse")} />
                  {page.tidying ? "Tidying…" : "Tidy folders"}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem asChild><Link to="/settings?tab=connection">Settings</Link></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    />
  );
}
