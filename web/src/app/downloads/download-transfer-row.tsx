/**
 * The one download row (a film on the page, an episode in the series dialog)
 * and the one series summary (the page's group row and the dialog's header).
 */
import { useEffect,useRef,useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes,formatEta,formatSpeed } from "@/lib/format";
import { useDisplayPath,useFeatures } from "@/lib/features";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible,CollapsibleTrigger } from "@/components/ui/collapsible";
import { progressPercent } from "@/components/tf/active-row-state";
import { rowStateBadge, showsProgressBar } from "./release-display";
import {
rowAttr,
torrentRowMenuItems,
type TorrentRowMenuHandlers,
type TransferRowKind,
} from "./row-menu";
import { TransferProgress,transferBarTone } from "./transfer-progress";
import type { ClientTorrent } from "./types";
import { transferTitleParts } from "./download-transfer-title";
import { DownloadRowActions } from "./download-row-actions";
import { SearchingBadge } from "./searching-badge";
import { WantedMenuActions } from "./wanted-menu-actions";
import type { WantedGroup } from "./wanted-groups";
import type { useDownloads } from "./use-downloads";
type WantedState = ReturnType<typeof useDownloads>["wanted"];

export interface DownloadTransferRowProps extends TorrentRowMenuHandlers {
  torrent: ClientTorrent;
  /** `torrent` is a film row on the page; `episode` a card in the series dialog. */
  kind: TransferRowKind;
  /** The film's name, or the episode label ("E05"). */
  title: string;
  /** Films link to their title page and show a poster; episodes do neither. */
  titleHref?: string | null;
  posterUrl?: string | null;
  showThumb?: boolean;
  isSelected: boolean;
  highlighted: boolean;
  openingHash: string | null;
  onToggleSelect: (transferId: string, additive: boolean) => void;
  wantedGroups?: readonly WantedGroup[];
  wantedState: WantedState;
}

export function DownloadTransferRow({
  torrent: t,
  kind,
  title,
  titleHref = null,
  posterUrl,
  showThumb = false,
  isSelected,
  highlighted,
  openingHash,
  onToggleSelect,
  wantedGroups = [],
  wantedState,
  ...handlers
}: DownloadTransferRowProps) {
  const { onAction, onOpenFile } = handlers;
  const { openFolder } = useFeatures();
  const displayPath = useDisplayPath();
  const card = kind === "episode";
  const pct = progressPercent(t.progress);
  const badge = rowStateBadge(t);
  const busy = openingHash === t.transferId;
  // A pack's largest file is one episode of many, so a pack only gets Show in folder.
  const canOpen = openFolder && t.actions.open;
  const errorMessage = t.status === "error" ? t.statusLabel : null;
  const [errorExpanded, setErrorExpanded] = useState(false);
  const showEta = !t.packed && ["downloading", "finishing", "waiting"].includes(t.status) &&
    t.eta != null && t.eta > 0;
  const speed = showEta ? formatSpeed(t.dlspeed) : null;
  const done = t.status === "ready";
  const quality = t.quality.label;
  const heading = transferTitleParts({ title, href: titleHref, posterUrl });
  const rowRef = useRef<HTMLDivElement>(null);
  // Bring the linked row into view and give it focus, so the keyboard and a
  // screen reader start from the download the user asked to see.
  useEffect(() => {
    if (!highlighted) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    rowRef.current?.focus({ preventScroll: true });
  }, [highlighted]);

  const menuItems = torrentRowMenuItems({ torrent: t, kind, busy, displayPath, handlers });
  const menu = (
    <WantedMenuActions groups={wantedGroups} onChanged={wantedState.reload} setRows={wantedState.setRows}
      label={`More actions for ${title}`} triggerProps={rowAttr(kind, "more")}>
      {menuItems}
    </WantedMenuActions>
  );

  return (
    <div
      ref={rowRef}
      className={cn(
        "group transition-colors",
        card
          ? "flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
          : "grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)_auto] gap-2 sm:gap-3 items-center px-3 py-2.5 max-md:pl-4",
        isSelected ? "bg-brand-dim" : card ? "bg-muted/40" : "hover:bg-muted/60",
        highlighted && (card ? "ring-2 ring-brand" : "ring-2 ring-inset ring-brand"),
      )}
      {...(card ? { "data-episode-card": "" } : { "data-client-torrent": "" })}
      data-highlighted={highlighted || undefined}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`${isSelected ? "Deselect" : "Select"} ${title}`}
      data-hash={t.hash}
      data-torrent-error={t.status === "error" ? "true" : undefined}
      title={t.name}
      onClick={(e) => {
        if (
          e.target instanceof HTMLElement &&
          (e.target.closest("button") ||
            e.target.closest("select") ||
            e.target.closest('[role="checkbox"]') ||
            e.target.closest("a"))
        ) {
          return;
        }
        onToggleSelect(t.transferId, e.ctrlKey || e.metaKey || e.shiftKey);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleSelect(t.transferId, e.ctrlKey || e.metaKey || e.shiftKey);
        }
      }}
    >
      <div className={cn("flex gap-2", card ? "items-start" : "items-center sm:contents")}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(t.transferId, true)}
          aria-label={`Select ${title}`}
          className={cn("shrink-0 max-md:z-[1]", card && "mt-0.5")}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-2.5">
            {showThumb ? heading.thumb : null}
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {card ? (
                    <span className="text-[13px] font-semibold tabular-nums text-foreground">{title}</span>
                  ) : (
                    heading.text
                  )}
                </div>
                {!card ? <div className="shrink-0 sm:hidden">{menu}</div> : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant={badge.variant}
                  title={t.filesMissing ? "The downloaded files are no longer on disk" : undefined}
                  {...rowAttr(kind, "state")}
                  data-files-missing={t.filesMissing || undefined}
                >
                  {done && !t.filesMissing ? <Check className="h-3 w-3" aria-hidden /> : null}
                  {badge.label}
                </Badge>
                {!card ? <SearchingBadge groups={wantedGroups} /> : null}
                {/*
                  One quality tag at most (resolution).
 Source tags, peers and
                  the folder path are torrent mechanics: they live in the
                  menu's Details.
                */}
                {quality ? <Badge variant="outline" data-quality>{quality}</Badge> : null}
                {t.sizeBytes > 0 || showEta ? (
                  <span className="text-[12px] text-subtle-foreground tabular-nums">
                    {[t.sizeBytes > 0 ? formatBytes(t.sizeBytes) : null, showEta ? formatEta(t.eta) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </div>
              {errorMessage ? (
                // One line keeps a list of failed rows scannable; the full
                // text is on hover and one tap away.
                <Collapsible open={errorExpanded} onOpenChange={setErrorExpanded}>
                  <CollapsibleTrigger
                    title={errorMessage}
                    className="block w-full truncate rounded-sm text-left text-[12px] leading-snug text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:whitespace-normal max-md:min-h-11 pointer-coarse:min-h-11"
                    {...rowAttr(kind, "error-message")}
                  >
                    {errorMessage}
                  </CollapsibleTrigger>
                </Collapsible>
              ) : null}
              {showsProgressBar(t) ? (
                <TransferProgress
                  percent={pct}
                  tone={transferBarTone(t.status)}
                  label={`${title} download progress`}
                  speed={speed}
                  className="pt-0.5"
                  barClassName={card ? undefined : "max-w-[18rem]"}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {card ? (
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DownloadRowActions torrent={t} title={title} kind={kind} busy={busy} canOpen={canOpen}
              onAction={onAction} onOpenFile={onOpenFile} />
          </div>
          {menu}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 lg:gap-1.5">
          <DownloadRowActions torrent={t} title={title} kind={kind} busy={busy} canOpen={canOpen}
            onAction={onAction} onOpenFile={onOpenFile} />
          <div className="hidden sm:block">{menu}</div>
        </div>
      )}
    </div>
  );
}
