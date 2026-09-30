import { readJsonBody, sendErrorFromBody } from "@/lib/api-json";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useFeatures } from "@/lib/features";
import { Link } from "react-router";
import { useSession } from "@/components/providers/session-provider";
import { toast } from "@/lib/toast";
import {
  ArrowDownToLine,
  ArrowRight,
  ChevronDown,
  Radar,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SEARCH_HREF } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TfPageHeader } from "@/components/tf/page-header";
import { StorageCapDialog } from "@/components/storage/storage-cap-dialog";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { useStorageCapOverride } from "@/components/storage/use-storage-cap-override";
import {
  parseStorageOverrideFacts,
  StorageLimitError,
} from "@/lib/library/storage-override";
import { TfEmptyState } from "@/components/tf/empty-state";
import { TfErrorState } from "@/components/tf/error-state";
import { openSearchOverlay } from "@/components/search/search-overlay";
import { useApiQuery } from "@/hooks/use-api-query";
import { RecommendationRailSection } from "@/components/tf/recommendation-rail";
import {
  infoHashFromMagnet,
  InlineStreamPlayer,
} from "@/components/watch/inline-player";
import { useDownloadPrefs } from "@/hooks/use-download-prefs";
import { useCapabilities } from "@/lib/capabilities";
import { parseLibrary } from "@/lib/requests";
import {
  isSeriesMediaType,
  normalizeMediaType,
  searchCategoryForMediaType,
} from "@/lib/metadata/media-type";
import {
  titleHrefForName,
} from "@/components/title/work-key";
import {
  automationStateCopy,
  libraryItemState,
  libraryPageSummary,
} from "@/components/library/library-state";
import {
  LoadingGlyph,
  PageSkeletonFrame,
  SkeletonBlock,
} from "@/components/ui/loading";
import { useStableLoading } from "@/components/ui/use-stable-loading";
import {
  DEFAULT_LIBRARY_TAB,
  LIBRARY_TAB_LABELS,
  filterByTab,
  tabCounts,
  visibleTabs,
  type LibraryTab,
} from "./library-tabs";
import { activityLine, needsAttention, positionLine } from "./card-state";
import { CheckSchedule } from "@/components/library/check-schedule";
import { removeFromLibraryCopy } from "./remove-copy";
import { canonicalWatchlistPlayerTitle } from "./player-identity";
import { PICK_TOAST_CLASSNAMES, pickReleaseToastButton } from "@/components/releases/release-picker-store";

interface WatchItem {
  nextCheckAt?: string | null;
  nextCheckReason?: string | null;
  id: string;
  mediaType: string;
  externalId: string;
  title: string;
  posterUrl: string | null;
  synopsis: string | null;
  rating: number | null;
  status: string;
  monitored?: boolean;
  lastEpisode: string | null;
  fromSeason?: number | null;
  fromEpisode?: number | null;
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
  monitorMode?: string | null;
  latestReleaseTitle: string | null;
  latestReleaseAt: string | null;
  latestReleaseMagnet: string | null;
  nextEpisodeHint: string | null;
  updatedAt: string;
}

/**
 * Where a library row opens.
 *
 * The same funnel every other card surface uses, so a library row and the same
 * work's poster on the home board land on one page rather than two.
 */
function libraryTitleHref(item: WatchItem): string | null {
  return titleHrefForName(item.title, {
    mediaType: item.mediaType,
    season: item.cursorSeason ?? item.fromSeason ?? null,
  });
}

/**
 * The empty Library's Search button. Going to `/search` directly would leave a
 * blank page behind the palette, so a plain click opens the palette in place,
 * like the header's Search. Modified clicks keep the link.
 */
function openSearchFromEmptyState(event: ReactMouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
    return;
  event.preventDefault();
  openSearchOverlay();
}

/**
 * The Library's rows. The owner reads `/api/watchlist`; a requester reads
 * `/api/requester/library` (identity and art only), mapped onto the same row
 * shape so one page renders both. The owner's preview maps its own rows the
 * same way, since `/api/requester/*` only answers requesters.
 */
function useLibraryItems(ownerSession: boolean, readOnly: boolean) {
  const owner = useApiQuery<{ items?: WatchItem[] }>(ownerSession ? "/api/watchlist" : null, { refreshMs: 30_000 });
  const mine = useApiQuery<{ items?: WatchItem[] }>(ownerSession ? null : "/api/requester/library", {
    refreshMs: 60_000,
    emptyOnUnauthorized: false,
    select: (json: unknown) => ({ items: parseLibrary(json).map(readOnlyItem) }),
  });
  const ownerData = owner.data;
  const previewData = useMemo(
    () => (ownerSession && readOnly && ownerData ? { items: (ownerData.items ?? []).map(readOnlyItem) } : null),
    [ownerSession, readOnly, ownerData],
  );
  if (!ownerSession) return mine;
  return readOnly ? { ...owner, data: previewData } : owner;
}

/** A library row with nothing but identity and art, as a requester may see it. */
function readOnlyItem(row: { key?: string; id?: string; title: string; mediaType: string; posterUrl: string | null; year?: number | null }): WatchItem {
  return {
    id: row.key ?? row.id ?? row.title,
    mediaType: row.mediaType,
    externalId: "",
    title: row.title,
    posterUrl: row.posterUrl,
    synopsis: null,
    rating: null,
    status: "available",
    lastEpisode: null,
    latestReleaseTitle: null,
    latestReleaseAt: null,
    latestReleaseMagnet: null,
    nextEpisodeHint: null,
    updatedAt: "",
  };
}

/** Last automation run summary (client-only, not source of truth — Activity is). */
type LastAutoSummary = {
  at: string;
  sent: number;
  skipped: number;
  failed: number;
  message: string;
  offline?: boolean;
};

// ---------------------------------------------------------------------------
// Deleting files
// ---------------------------------------------------------------------------

/** What the user asked to delete. Mirrors `DeletionScope` in `deletion-plan.ts`. */
type DeleteScope =
  | { kind: "show" }
  | { kind: "season"; season: number }
  | { kind: "episode"; season: number; episode: number };

/** `GET /api/library/delete`'s answer, exactly as the route serialises it. */
interface DeletePlan {
  outcome: "deletes" | "blocked" | "nothing-held";
  fileCount: number;
  totalBytes: number;
  missingFileCount: number;
  releases: Array<{ name: string; fileCount: number; bytes: number }>;
  blocked: Array<{ name: string; covers: string; fileCount: number }>;
  /** The one line stating what will go, computed server-side. */
  summary: string;
}

/** `S02E06` → `{ season: 2, episode: 6 }`. Null when the row holds nothing yet. */
function heldEpisode(item: WatchItem): { season: number; episode: number } | null {
  const match = /^S(\d{1,3})E(\d{1,4})$/i.exec(item.lastEpisode?.trim() ?? "");
  if (!match) return null;
  return { season: Number(match[1]), episode: Number(match[2]) };
}

/**
 * The scopes this card can offer, widest first.
 *
 * Only scopes anchored on something the row actually knows about. Offering
 * "this episode" for a show we hold nothing for would produce a dialog whose
 * only possible answer is "nothing to delete", and offering the *hunt cursor's*
 * episode would name one we have never downloaded — the same confusion
 * `card-state.ts` exists to avoid on the line above.
 */
function deleteScopeOptions(
  item: WatchItem,
  isSeries: boolean,
): Array<{ scope: DeleteScope; label: string }> {
  const options: Array<{ scope: DeleteScope; label: string }> = [
    { scope: { kind: "show" }, label: "Everything" },
  ];
  if (!isSeries) return options;

  const held = heldEpisode(item);
  const season = held?.season ?? item.cursorSeason ?? item.fromSeason ?? null;
  if (season != null) {
    options.push({ scope: { kind: "season", season }, label: `Season ${season}` });
  }
  if (held) {
    options.push({
      scope: { kind: "episode", season: held.season, episode: held.episode },
      label: item.lastEpisode?.trim() || `S${held.season}E${held.episode}`,
    });
  }
  return options;
}

function deleteScopeQuery(itemId: string, scope: DeleteScope): string {
  const params = new URLSearchParams({ watchListItemId: itemId, scope: scope.kind });
  if (scope.kind !== "show") params.set("season", String(scope.season));
  if (scope.kind === "episode") params.set("episode", String(scope.episode));
  return params.toString();
}

function sameScope(a: DeleteScope, b: DeleteScope): boolean {
  return deleteScopeQuery("x", a) === deleteScopeQuery("x", b);
}

/** `Delete 10 files` / `Delete 1 release`, agreeing with the noun it counts. */
function deleteButtonLabel(plan: DeletePlan): string {
  const files = plan.fileCount;
  if (files > 0) return `Delete ${files} file${files === 1 ? "" : "s"}`;
  const releases = plan.releases.length;
  return `Delete ${releases} release${releases === 1 ? "" : "s"}`;
}


const LAST_AUTO_KEY = "tf:last-automation";

const STATUSES = ["watching", "planned", "completed", "dropped"] as const;

function readLastAuto(): LastAutoSummary | null {
  try {
    const raw = sessionStorage.getItem(LAST_AUTO_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LastAutoSummary;
  } catch {
    return null;
  }
}

function writeLastAuto(summary: LastAutoSummary) {
  try {
    sessionStorage.setItem(LAST_AUTO_KEY, JSON.stringify(summary));
  } catch {
    /* ignore quota */
  }
}

export default function WatchlistPage() {
  const caps = useCapabilities();
  // Read-only for anyone who can't manage the library: no delete, paths, streams or automation.
  const readOnly = !caps.canManage;
  const streaming = useFeatures().streaming && caps.canStream;
  const { data: session } = useSession();
  const { prefs, loaded: prefsLoaded } = useDownloadPrefs();
  const [items, setItems] = useState<WatchItem[]>([]);
  const [runningAuto, setRunningAuto] = useState(false);
  const [automationReviewOpen, setAutomationReviewOpen] = useState(false);
  const [tab, setTab] = useState<LibraryTab>(DEFAULT_LIBRARY_TAB);
  const [sendingId, setSendingId] = useState<string | null>(null);
  // Over-cap sends ask instead of refusing; free space stays a hard stop.
  const capOverride = useStorageCapOverride();
  const { ensureDownloadSetup } = useDownloadSetup();
  const [pendingRemove, setPendingRemove] = useState<WatchItem | null>(null);
  const [removing, setRemoving] = useState(false);
  // Deleting files is a second, separate decision with its own dialog. It never
  // shares state with `pendingRemove`: the two controls do different things and
  // a shared "pending" would let one dialog's confirmation act on the other.
  const [pendingDelete, setPendingDelete] = useState<WatchItem | null>(null);
  const [deleteScope, setDeleteScope] = useState<DeleteScope>({ kind: "show" });
  const [deletePlan, setDeletePlan] = useState<DeletePlan | null>(null);
  const [deletePlanError, setDeletePlanError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [lastAuto, setLastAuto] = useState<LastAutoSummary | null>(null);
  const automationStateId = useId();
  // The library mixes TMDb and AniList CDNs; a dead URL must fall back to the
  // same letter tile a missing URL gets, not paint nothing.
  const [brokenPosters, setBrokenPosters] = useState<Set<string>>(new Set());
  /** null = not loaded yet; 0 = no schedule. */
  const autoIntervalMinutes = prefsLoaded
    ? (prefs.automationIntervalMinutes ?? 0)
    : null;
  const isBuiltinClient = !prefs.clientType || prefs.clientType === "builtin";

  /**
   * One request, one set of states. This page previously ran the *same* fetch
   * twice — a `load` callback and a near-identical mount effect — and both
   * copies narrowed a failure into an empty list: the error banner rendered,
   * and the "No items yet" empty state rendered directly beneath it, telling
   * the user to go add something when in fact their library merely could not
   * be read. See `useApiQuery`'s own header for why that is the worst failure
   * a data panel can have.
   */
  const {
    data: watchlist,
    loading,
    error,
    refetch: load,
  } = useLibraryItems(caps.ownerSession, readOnly);
  const showLoading = useStableLoading(loading && watchlist == null && !error);

  // Adjusting state from a prop/query during render is React's documented
  // alternative to a sync effect: the rows are server-owned, but this page
  // also edits them locally (status, monitoring, removal) and must not lose
  // those edits or wait an extra commit for a reload to appear.
  const [syncedFrom, setSyncedFrom] = useState<typeof watchlist>(null);
  if (watchlist !== syncedFrom) {
    setSyncedFrom(watchlist);
    setItems(watchlist?.items ?? []);
  }

  useEffect(() => {
    // sessionStorage is an external store; syncing it on mount belongs in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastAuto(readLastAuto());
  }, []);

  async function updateStatus(id: string, newStatus: string) {
    const res = await fetch("/api/watchlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: newStatus }),
    });
    if (res.ok) {
      const data = await res.json();
      setItems((prev) =>
        prev.map((i) => (i.id === id ? { ...i, ...data.item } : i)),
      );
    }
  }

  async function updateFromSeason(
    id: string,
    fromSeason: number,
    fromEpisode = 1,
  ) {
    const res = await fetch("/api/watchlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, fromSeason, fromEpisode }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.item) {
        setItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, ...data.item } : i)),
        );
        toast.success(
          `Starting at S${String(fromSeason).padStart(2, "0")}E${String(fromEpisode).padStart(2, "0")}`,
        );
      }
    } else {
      toast.error("Could not update start season");
    }
  }

  /**
   * Download one episode. When season/episode is the hunt cursor (Download next),
   * the server advances last/next; off-cursor rewatch does not.
   */
  async function grabOnDemand(
    item: WatchItem,
    season: number,
    episode: number,
  ) {
    if (!(await ensureDownloadSetup())) return;
    setSendingId(item.id);
    try {
      const res = await fetch("/api/library/ondemand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watchListItemId: item.id,
          season,
          episode,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(
          data.message ||
            `Queued S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
        );
        if (
          data.advanced &&
          data.cursorSeason != null &&
          data.cursorEpisode != null
        ) {
          setItems((prev) =>
            prev.map((i) =>
              i.id === item.id
                ? {
                    ...i,
                    lastEpisode:
                      typeof data.lastEpisode === "string"
                        ? data.lastEpisode
                        : i.lastEpisode,
                    cursorSeason: data.cursorSeason as number,
                    cursorEpisode: data.cursorEpisode as number,
                    nextEpisodeHint:
                      typeof data.nextEpisodeHint === "string"
                        ? data.nextEpisodeHint
                        : i.nextEpisodeHint,
                  }
                : i,
            ),
          );
        }
      } else {
        const query = (data.noReleaseFound as { manualSearchQuery?: string | null } | null | undefined)?.manualSearchQuery;
        toast.error(
          data.message || "On-demand grab failed",
          typeof data.workKey === "string" && data.workKey
            ? {
                duration: Infinity,
                classNames: PICK_TOAST_CLASSNAMES,
                action: pickReleaseToastButton({
                  workKey: data.workKey,
                  title: item.title,
                  season,
                  episode,
                  query: query ?? null,
                  onPicked: load,
                }),
              }
            : undefined,
        );
      }
    } catch {
      toast.error("Network error");
    } finally {
      setSendingId(null);
    }
  }

  async function toggleMonitored(item: WatchItem) {
    const next = item.monitored === false;
    const res = await fetch("/api/watchlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, monitored: next }),
    });
    if (res.ok) {
      const data = await res.json();
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, ...data.item } : i)),
      );
      toast.success(next ? "Now watching" : "Paused");
    } else {
      toast.error("Couldn't update this show");
    }
  }

  async function runAutomation() {
    setRunningAuto(true);
    try {
      const res = await fetch("/api/automation/run", { method: "POST" });
      const data = await res.json().catch(() => ({
        ok: false,
        message: "Empty response from server",
      }));
      if (res.ok && data.ok !== false) {
        const lib = data.summary?.library;
        const summary: LastAutoSummary = {
          at: new Date().toISOString(),
          sent: lib?.sent ?? 0,
          skipped: lib?.skipped ?? 0,
          failed: lib?.failed ?? 0,
          message: data.message || "Automation finished",
          offline: Boolean(data.offline),
        };
        writeLastAuto(summary);
        setLastAuto(summary);
        const detail = `${summary.sent} sent · ${summary.skipped} skipped · ${summary.failed} failed`;
        if (data.offline) {
          toast.warning(data.message || "Client offline", {
            description: detail,
          });
        } else {
          toast.success(data.message || "Automation finished", {
            description: detail,
          });
        }
        load();
      } else if (data.offline || res.status === 503) {
        toast.warning(data.message || "Torrent client offline");
      } else {
        toast.error(data.message || data.error || "Automation failed");
      }
    } catch {
      toast.error("Network error running automation");
    } finally {
      setRunningAuto(false);
    }
  }

  async function confirmRemove() {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      const res = await fetch(
        `/api/watchlist?id=${encodeURIComponent(pendingRemove.id)}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.id !== pendingRemove.id));
        // Says the second half out loud. The toast is the last thing the user
        // sees and is the only confirmation that the promise was kept.
        toast.success("Removed from library", {
          description: "Downloaded files were kept.",
        });
      } else {
        toast.error("Could not remove item");
      }
      setPendingRemove(null);
    } catch {
      toast.error("Network error");
    } finally {
      setRemoving(false);
    }
  }

  /**
   * Ask the server what a scope would delete.
   *
   * The plan is never computed here. The count and the size shown on the dialog
   * have to be the ones the delete will actually act on, and a second
   * implementation in the browser is how those two drift apart — so this is a
   * read of the same function the POST uses.
   */
  async function loadDeletePlan(item: WatchItem, scope: DeleteScope) {
    setDeletePlan(null);
    setDeletePlanError(null);
    try {
      const res = await fetch(
        `/api/library/delete?${deleteScopeQuery(item.id, scope)}`,
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setDeletePlanError(data?.message || data?.error || "Could not check files");
        return;
      }
      setDeletePlan(data.plan as DeletePlan);
    } catch {
      setDeletePlanError("Could not reach the server");
    }
  }

  function openDeleteFiles(item: WatchItem) {
    const scope: DeleteScope = { kind: "show" };
    setPendingDelete(item);
    setDeleteScope(scope);
    void loadDeletePlan(item, scope);
  }

  function chooseDeleteScope(item: WatchItem, scope: DeleteScope) {
    setDeleteScope(scope);
    void loadDeletePlan(item, scope);
  }

  async function confirmDeleteFiles() {
    if (!pendingDelete || !deletePlan || deletePlan.outcome !== "deletes") return;
    setDeleting(true);
    try {
      const res = await fetch("/api/library/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watchListItemId: pendingDelete.id,
          scope: deleteScope.kind,
          ...(deleteScope.kind !== "show" ? { season: deleteScope.season } : {}),
          ...(deleteScope.kind === "episode" ? { episode: deleteScope.episode } : {}),
          confirm: true,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        toast.success(
          `Deleted ${data.freedFiles} file${data.freedFiles === 1 ? "" : "s"}`,
          { description: data.plan?.summary },
        );
        setPendingDelete(null);
      } else {
        // A partial failure is not a success with an asterisk: some files are
        // still there, and the user has to know which.
        toast.error(data?.message || data?.error || "Could not delete files");
        if (Array.isArray(data?.failed) && data.failed.length) {
          void loadDeletePlan(pendingDelete, deleteScope);
        }
      }
    } catch {
      toast.error("Network error");
    } finally {
      setDeleting(false);
    }
  }

  async function sendLatest(item: WatchItem) {
    if (!item.latestReleaseMagnet) return;
    if (!session) {
      toast.error("Sign in to send to your client");
      return;
    }
    setSendingId(item.id);
    try {
      const outcome = await capOverride.run(async ({ overrideStorageCap }) => {
        const res = await fetch("/api/torrent/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            magnet: item.latestReleaseMagnet,
            name: item.latestReleaseTitle || item.title,
            source: "watchlist",
            watchListItemId: item.id,
            ...(overrideStorageCap ? { overrideStorageCap: true } : {}),
          }),
        });
        const body = (await readJsonBody<{ ok?: boolean; message?: string; error?: string; storage?: unknown }>(res)) ?? null;
        // Throw an over-cap refusal so the shared rule can offer the choice;
        // a wont-fit refusal is not overridable and falls through unchanged.
        if (!res.ok || body?.ok === false) {
          const storage = parseStorageOverrideFacts(body?.storage);
          if (storage?.overridable) {
            throw new StorageLimitError(body?.message || "Storage limit", storage);
          }
        }
        return { res, data: body };
      });

      // Declined: nothing was sent and nothing failed.
      if (outcome.status === "cancelled") return;

      const { res, data } = outcome.value;
      if (res.ok && data && data.ok !== false) {
        toast.success(data.message || "Sent to client");
      } else {
        toast.error(sendErrorFromBody(data, res.status).message);
      }
    } catch (err) {
      toast.error(
        err instanceof Error && err.message ? err.message : "Network error",
      );
    } finally {
      setSendingId(null);
    }
  }

  if (loading && watchlist == null && !error) {
    return <LibrarySkeleton visible={showLoading} />;
  }


  const tabs = visibleTabs(items);
  // A tab can disappear under the user: remove the last film and Movies goes
  // with it. Falling back to All keeps the page from rendering an empty list
  // for a tab that no longer exists, which reads as "your library is empty".
  const activeTab = tabs.includes(tab) ? tab : DEFAULT_LIBRARY_TAB;
  const filtered = filterByTab(items, activeTab);
  const counts = tabCounts(items);
  // An empty library has nothing to check, so the automation button and its
  // explanation would only compete with the one useful next step: Search.
  const showAutomation = !readOnly && items.length > 0;

  return (
    <div className="container-app space-y-6 py-6 pb-[calc(var(--mobile-nav-h)+var(--safe-bottom)+1.5rem)] min-w-0 sm:py-8 sm:pb-8" data-library-page={readOnly ? "read-only" : "manage"}>
      <TfPageHeader
        title="Library"
        description={libraryPageSummary(items)}
        actions={!showAutomation ? undefined :
          <Button
            type="button"
            size="sm"
            onClick={() => setAutomationReviewOpen(true)}
            disabled={runningAuto}
            aria-describedby={automationStateId}
          >
            {runningAuto ? (
              <LoadingGlyph className="h-3.5 w-3.5" />
            ) : (
              <Radar className="h-3.5 w-3.5" />
            )}
            Run automation
          </Button>
        }
      />

      {!showAutomation ? null : (
      <p
        id={automationStateId}
        data-dense-ui
        className="max-w-xl text-sm leading-relaxed text-subtle-foreground"
      >
        Checks monitored titles and may download matching releases.{" "}
        {automationStateCopy(autoIntervalMinutes)}
        {autoIntervalMinutes === 0 ? (
          <>
            {". "}
            {/*
              A real tap target, not inline text. WCAG exempts links
              inside a sentence from the target-size rule, but this is the
              only control that turns automation on, and at 16px on a
              phone it was the hardest thing on the page to hit. The
              inline-block plus vertical padding gives it a 44px box on
              touch without breaking the sentence flow, and collapses on
              pointer devices where a mouse makes the box unnecessary.
            */}
            <Link
              to="/settings"
              className="inline-flex min-h-[44px] items-center whitespace-nowrap py-2 align-middle text-brand-foreground underline underline-offset-2 lg:min-h-0 lg:py-0"
            >
              Turn on automatic checks
            </Link>
          </>
        ) : null}
      </p>
      )}

      {lastAuto && !readOnly ? (
        <div className="surface px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span className="text-muted-foreground">
            Last automation
            {lastAuto.offline ? (
              <Badge variant="danger" className="ml-1.5 align-middle">
                offline
              </Badge>
            ) : null}
            <span className="text-subtle-foreground">
              {" "}
              · {lastAuto.sent} sent · {lastAuto.skipped} skipped ·{" "}
              {lastAuto.failed} failed
            </span>
          </span>
          <Link
            to="/notifications"
            className="inline-flex items-center gap-1 min-h-[44px] font-medium text-brand-foreground hover:underline lg:min-h-0"
          >
            View in Activity
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      ) : null}

      {/* What kind of thing, not how far through it.
          These replaced a row of status chips (All / Watching / Completed).
          Status is a property of one title and now lives on that title's card;
          it was never the question people arrive with. You open the Library to
          find a film or to find a show. */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => setTab(value as LibraryTab)}
        className="min-w-0 gap-6"
      >
      <ScrollArea className="min-w-0">
        <TabsList aria-label="Library" className="group-data-horizontal/tabs:h-auto" data-library-tabs>
          {tabs.map((id) => (
            <TabsTrigger
              key={id}
              value={id}
              data-library-tab={id}
              className="h-8 flex-none gap-1.5 px-3 text-[13px] max-md:h-11 pointer-coarse:h-11"
            >
              {LIBRARY_TAB_LABELS[id]}
              <span className="tabular-nums text-subtle-foreground">{counts[id]}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <TabsContent value={activeTab} className="min-w-0">
      {error ? (
        <TfErrorState
          title="Could not load your library"
          message={error}
          onRetry={load}
        />
      ) : !filtered.length ? (
        <TfEmptyState
          icon={Search}
          title={
            items.length
              ? `Nothing in ${LIBRARY_TAB_LABELS[activeTab]}`
              : readOnly
                ? "Nothing in the library yet"
                : "Nothing in your library yet"
          }
          description={
            items.length
              ? // Empty tabs are hidden, so reaching this means the tab emptied
                // while the page was open. Name the way back rather than
                // leaving the user on a dead end.
                "Everything in your library is under another tab. Choose All to see it."
              : readOnly
                ? "Browse or search for something, then press Request."
                : "Search for a show or film, then choose Add to library on its page."
          }
          actionLabel={items.length ? undefined : readOnly ? "Go to Browse" : "Search"}
          actionHref={items.length ? undefined : readOnly ? "/" : SEARCH_HREF}
          onAction={items.length || readOnly ? undefined : openSearchFromEmptyState}
        />
      ) : (
        // No `items-start`: grid's default stretch gives equal-height cards per
        // row, so a Movie card (no "Next up" block) no longer leaves a ragged
        // void beside a taller series card.
        <div className="grid sm:grid-cols-2 gap-3">
          {filtered.map((item) => {
            const isSeries = isSeriesMediaType(item.mediaType);
            // "tv" must read as "TV", not the CSS-capitalized "Tv". Derive the
            // noun; the `capitalize` class still title-cases the status word.
            const typeLabel =
              normalizeMediaType(item.mediaType) === "tv"
                ? "TV"
                : item.mediaType;
            // A watchlist row is a monitored series unless we know otherwise,
            // so "tv" is the right fallback here — the same one the hunt uses.
            const searchCat = searchCategoryForMediaType(item.mediaType) ?? "tv";
            const latestInfoHash = infoHashFromMagnet(item.latestReleaseMagnet);
            const itemState = libraryItemState(item, {
              sending: sendingId === item.id,
              canStream: streaming && isBuiltinClient && Boolean(latestInfoHash),
            });
            const nextLabel = itemState.nextLabel;
            const cardPosition = positionLine(item);
            const cardActivity = activityLine(item);
            const cardAttention = needsAttention(item);
            // A library row is a title you asked for, so it opens the page
            // about that title — the same destination its poster on the home
            // board has. Without this the card was inert: every control on it
            // was a side action (remove, monitor, search) and nothing opened
            // the thing itself.
            const titleHref = libraryTitleHref(item);

            return (
              <article
                key={item.id}
                className="surface flex min-w-0 flex-row items-start gap-3 overflow-hidden p-3.5"
                data-library-card
              >
                {/* A fixed 2:3 poster pinned top-left; the content beside it
                    sets the card's height. Stretching the poster column to the
                    card left either a grey strip, a cropped cover or a blurred
                    fill band, all of which read as broken. */}
                <div className="relative aspect-[2/3] w-[4.5rem] shrink-0 overflow-hidden rounded-md bg-muted sm:w-[5.5rem]">
                  {item.posterUrl && !brokenPosters.has(item.id) ? (
                    <img
                      src={item.posterUrl}
                      alt=""
                      onError={() =>
                        setBrokenPosters((prev) => new Set(prev).add(item.id))
                      }
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <div
                      className="absolute inset-0 flex items-center justify-center px-1"
                      aria-label="No poster"
                      title="No poster"
                    >
                      {/* A crossed-out-image glyph reads as a *failed load*.
                          An initial reads as a deliberate placeholder — the
                          same fallback Plex/Jellyfin use. */}
                      <span
                        aria-hidden
                        className="select-none text-2xl font-semibold text-subtle-foreground"
                      >
                        {item.title.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                    </div>
                  )}
                  {titleHref ? (
                    <Link
                      to={titleHref}
                      data-library-card-link
                      aria-label={`Open ${item.title}`}
                      className="absolute inset-0 z-[1] rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    />
                  ) : null}
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                  {/* Title + remove */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {titleHref ? (
                        <Link
                          to={titleHref}
                          data-library-card-link
                          className="block min-w-0 min-h-[44px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-0"
                        >
                          <h2 className="font-medium text-[15px] text-foreground leading-snug line-clamp-2 hover:text-brand-foreground">
                            {item.title}
                          </h2>
                          <p className="mt-0.5 text-[12px] text-subtle-foreground capitalize">
                            {typeLabel}
                            {readOnly
                              ? null
                              : item.monitored !== false
                                ? " · watching"
                                : " · paused"}
                          </p>
                        </Link>
                      ) : (
                        <>
                          <h2 className="font-medium text-[15px] text-foreground leading-snug line-clamp-2">
                            {item.title}
                          </h2>
                                                    <p className="mt-0.5 text-[12px] text-subtle-foreground capitalize">
                            {typeLabel}
                            {readOnly
                              ? null
                              : item.monitored !== false
                                ? " · watching"
                                : " · paused"}
                          </p>
                        </>
                      )}
                    </div>
                    {readOnly ? null : <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPendingRemove(item)}
                      aria-label="Remove from library"
                      className="shrink-0 text-subtle-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>}
                  </div>

                  {readOnly ? null : (<>
                  {/* One clear “what happens next” block */}
                  {isSeries ? (
                    <div className="rounded-md border border-border bg-muted/50 px-3 py-2.5 space-y-1">
                      <p className="text-[13px] font-medium text-foreground">
                        {itemState.label}
                      </p>
                      <p className="text-xs leading-relaxed text-subtle-foreground">
                        {itemState.detail}
                      </p>
                      {item.lastEpisode ? (
                        <p className="text-xs text-subtle-foreground">
                          Previous:{" "}
                          <span className="text-muted-foreground tabular-nums">
                            {item.lastEpisode}
                          </span>
                          {item.fromSeason != null ? (
                            <span>
                              {" "}
                              · started from S
                              {String(item.fromSeason).padStart(2, "0")}
                            </span>
                          ) : null}
                        </p>
                      ) : item.fromSeason != null ? (
                        <p className="text-xs text-subtle-foreground">
                          Started from season{" "}
                          {String(item.fromSeason).padStart(2, "0")}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="rounded-md border border-border bg-muted/50 px-3 py-2.5 space-y-1">
                      <p className="text-[13px] font-medium text-foreground">
                        {itemState.label}
                      </p>
                      <p className="text-xs leading-relaxed text-subtle-foreground">
                        {itemState.detail}
                      </p>
                    </div>
                  )}

                  <CheckSchedule {...item} automationEnabled={(autoIntervalMinutes ?? 0) > 0} />

                  {/* Primary actions only — extra bottom pad keeps them above mobile nav */}
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2 pb-1">
                    {isSeries && nextLabel ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={sendingId === item.id}
                        onClick={() => {
                          const s = item.cursorSeason ?? item.fromSeason ?? 1;
                          const e = item.cursorEpisode ?? 1;
                          void grabOnDemand(item, s, e);
                        }}
                        title={`Download ${nextLabel} now`}
                      >
                        {sendingId === item.id ? (
                          <LoadingGlyph className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowDownToLine className="h-3.5 w-3.5" />
                        )}
                        Download {nextLabel}
                      </Button>
                    ) : null}

                    <Button
                      type="button"
                      variant={item.monitored !== false ? "secondary" : "ghost"}
                      size="sm"
                      aria-pressed={item.monitored !== false}
                      aria-label={
                        item.monitored !== false
                          ? `Stop watching ${item.title}`
                          : `Start watching ${item.title}`
                      }
                      onClick={() => void toggleMonitored(item)}
                    >
                      <Radar className="h-3.5 w-3.5" />
                      {item.monitored !== false ? "Watching" : "Paused"}
                    </Button>

                    <Button asChild variant="ghost" size="sm">
                      <Link
                        to={`${SEARCH_HREF}?q=${encodeURIComponent(
                          item.nextEpisodeHint || item.title,
                        )}&category=${searchCat}`}
                      >
                        <Search className="h-3.5 w-3.5" />
                        Search
                      </Link>
                    </Button>

                    {/* Secondary: season reset + space — not competing with primary */}
                    {isSeries ? (
                      <Collapsible className="group/more w-full sm:w-auto" data-library-more>
                        <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-1 rounded-sm px-1 py-1.5 text-xs text-subtle-foreground outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 pointer-coarse:min-h-11">
                          More options
                          <ChevronDown
                            aria-hidden
                            className="h-3.5 w-3.5 transition-transform group-data-[state=open]/more:rotate-180"
                          />
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2">
                          <Label className="gap-1.5 text-xs font-normal text-subtle-foreground">
                            Jump to season
                            <Input
                              type="number"
                              min={1}
                              max={99}
                              className="h-8 w-14 text-xs"
                              defaultValue={
                                item.fromSeason ?? item.cursorSeason ?? ""
                              }
                              onBlur={(e) => {
                                const n = parseInt(e.target.value, 10);
                                if (
                                  Number.isFinite(n) &&
                                  n >= 1 &&
                                  n !== item.fromSeason
                                ) {
                                  void updateFromSeason(item.id, n, 1);
                                }
                              }}
                            />
                          </Label>
                          {item.latestReleaseMagnet ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 text-xs"
                              disabled={sendingId === item.id}
                              onClick={() => void sendLatest(item)}
                              title={item.latestReleaseTitle || "Re-send last match"}
                            >
                              <Send className="h-3.5 w-3.5" />
                              Re-send last
                            </Button>
                          ) : null}
                          <Select
                            value={item.status}
                            onValueChange={(value) => updateStatus(item.id, value)}
                          >
                            <SelectTrigger
                              size="sm"
                              aria-label="Status"
                              className="text-xs capitalize"
                              data-library-status
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {STATUSES.map((s) => (
                                <SelectItem key={s} value={s} className="capitalize">
                                  {s}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {/* Deleting files lives here, one level away from the
                              primary actions and separate from the bin icon at
                              the top of the card. Those are different decisions:
                              the bin stops tracking and keeps everything, this
                              destroys media. Putting them side by side is how
                              the wrong one gets pressed. */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs text-subtle-foreground hover:text-destructive"
                            onClick={() => openDeleteFiles(item)}
                            data-delete-files
                            title={`Delete downloaded files for ${item.title}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete files
                          </Button>
                    </div>
                        </CollapsibleContent>
                      </Collapsible>
                    ) : null}
                  </div>

                    {/* Two questions, two lines: where am I, and is anything
                        happening. The old card answered neither without being
                        opened - "watching" told you the status you had already
                        filtered by, and a monitored show with an episode
                        waiting looked identical to one with nothing to do. */}
                    {isSeries && (cardPosition || cardActivity) ? (
                      <p
                        data-card-state
                        data-card-attention={cardAttention ? "true" : undefined}
                        className="-mt-1 flex flex-wrap items-center gap-x-1.5 text-xs"
                      >
                        {cardPosition ? (
                          <span className="tabular-nums text-muted-foreground">
                            {cardPosition}
                          </span>
                        ) : null}
                        {cardPosition && cardActivity ? (
                          <span aria-hidden className="text-subtle-foreground">
                            ·
                          </span>
                        ) : null}
                        {cardActivity ? (
                          <span
                            className={
                              cardActivity.kind === "update"
                                ? "font-medium text-brand-foreground"
                                : "text-subtle-foreground"
                            }
                          >
                            {cardActivity.text}
                          </span>
                        ) : null}
                      </p>
                    ) : null}

                  {streaming && isBuiltinClient && latestInfoHash ? (
                    <InlineStreamPlayer
                      infoHash={latestInfoHash}
                      title={canonicalWatchlistPlayerTitle(item)}
                    />
                  ) : null}
                  </>)}
                </div>
              </article>
            );
          })}
        </div>
      )}
      </TabsContent>
      </Tabs>

      {readOnly ? null : (
        <RecommendationRailSection
          onAdded={() => void load()}
          refreshKey={items.length}
        />
      )}

      <AlertDialog
        open={automationReviewOpen}
        onOpenChange={(open) => {
          if (!runningAuto) setAutomationReviewOpen(open);
        }}
      >
        <AlertDialogContent data-automation-review>
          <AlertDialogHeader>
            <AlertDialogTitle>Run Library automation?</AlertDialogTitle>
            <AlertDialogDescription>
              TorrentFlow will search every monitored title and may immediately
              send matching releases to your download client. Review enabled
              titles and rules before continuing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={runningAuto}>Review library</AlertDialogCancel>
            <AlertDialogAction
              disabled={runningAuto}
              onClick={(event) => {
                event.preventDefault();
                void runAutomation().finally(() => setAutomationReviewOpen(false));
              }}
            >
              {runningAuto ? (
                <LoadingGlyph className="h-3.5 w-3.5" />
              ) : (
                <Radar className="h-3.5 w-3.5" />
              )}
              Search and download matches
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(pendingRemove)}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent data-remove-from-library>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removeFromLibraryCopy(pendingRemove?.title).title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove
                ? removeFromLibraryCopy(pendingRemove.title).body
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRemove();
              }}
              disabled={removing}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {removing ? (
                <LoadingGlyph className="h-3.5 w-3.5" />
              ) : null}
              {removeFromLibraryCopy(pendingRemove?.title).confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Deleting files.
          The confirm stays disabled until a plan has come back and says
          something can actually be removed, so nobody can press it without
          having been shown the file count and the size. */}
      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setPendingDelete(null);
            setDeletePlan(null);
            setDeletePlanError(null);
          }
        }}
      >
        <AlertDialogContent data-delete-files-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete downloaded files?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `This permanently removes media for “${pendingDelete.title}” from your disk. It cannot be undone, and it does not remove the title from your library.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pendingDelete ? (
            <div className="space-y-3">
              {(() => {
                const options = deleteScopeOptions(
                  pendingDelete,
                  isSeriesMediaType(pendingDelete.mediaType),
                );
                return options.length > 1 ? (
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    spacing={1}
                    value={options.findIndex((option) => sameScope(option.scope, deleteScope)).toString()}
                    onValueChange={(value) => {
                      const option = options[Number(value)];
                      if (value && option) chooseDeleteScope(pendingDelete, option.scope);
                    }}
                    disabled={deleting}
                    aria-label="How much to delete"
                    className="flex-wrap"
                    data-delete-scope
                  >
                    {options.map((option, index) => (
                      <ToggleGroupItem
                        key={option.label}
                        value={index.toString()}
                        size="sm"
                        className="px-2.5 text-xs data-[state=on]:border-brand/35 data-[state=on]:bg-brand-dim data-[state=on]:text-brand-foreground max-md:h-11 pointer-coarse:h-11"
                      >
                        {option.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                ) : null;
              })()}

              <div
                className="rounded-md border border-border bg-muted/50 px-3 py-2.5 text-[12px]"
                data-delete-plan
              >
                {deletePlanError ? (
                  <p className="text-destructive">{deletePlanError}</p>
                ) : !deletePlan ? (
                  <p className="flex items-center gap-1.5 text-subtle-foreground">
                    <LoadingGlyph className="h-3.5 w-3.5" />
                    Checking what is on disk…
                  </p>
                ) : (
                  <>
                    {/* The server's sentence, not a locally re-derived one. */}
                    <p className="text-foreground">{deletePlan.summary}</p>
                    {deletePlan.releases.length ? (
                      <ul className="mt-2 space-y-0.5 text-xs text-subtle-foreground">
                        {deletePlan.releases.map((release) => (
                          <li key={release.name} className="truncate">
                            {release.name}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {deletePlan.blocked.length ? (
                      <ul className="mt-2 space-y-0.5 text-xs text-subtle-foreground">
                        {deletePlan.blocked.map((entry) => (
                          <li key={entry.name} className="truncate">
                            Kept: {entry.name} · covers {entry.covers}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteFiles();
              }}
              disabled={deleting || deletePlan?.outcome !== "deletes"}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? <LoadingGlyph className="h-3.5 w-3.5" /> : null}
              {/* The button restates the quantity, so the number is in front of
                  the user at the moment they press it and not only in the
                  paragraph above. A release count stands in when the engine
                  recorded no file list — "0 files" would read as "nothing". */}
              {deletePlan?.outcome === "deletes"
                ? deleteButtonLabel(deletePlan)
                : "Delete files"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <StorageCapDialog {...capOverride.dialogProps} />
    </div>
  );
}

function LibrarySkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading library"
      className={cn(
        "container-app space-y-6 py-6 pb-[calc(var(--mobile-nav-h)+var(--safe-bottom)+1.5rem)] min-w-0 transition-opacity duration-150 sm:py-8 sm:pb-8",
        !visible && "opacity-0",
      )}
    >
      {/* Always-present h1 so a11y tools are never left without a page landmark. */}
      <h1 className="sr-only">Library</h1>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <SkeletonBlock className="h-8 w-28" />
          <SkeletonBlock className="h-4 w-52 max-w-full" />
        </div>
        <SkeletonBlock className="h-8 w-32" />
      </div>
      <SkeletonBlock className="h-10 w-full max-w-2xl" />
      <div className="flex gap-1">
        {Array.from({ length: 5 }, (_, i) => (
          <SkeletonBlock key={i} className="h-7 w-20" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <article key={i} className="surface flex min-w-0 overflow-hidden">
            <SkeletonBlock className="min-h-[7.25rem] w-[4.75rem] shrink-0 sm:w-[5.5rem]" />
            <div className="min-w-0 flex-1 space-y-3 p-3.5">
              <SkeletonBlock className="h-5 w-4/5" />
              <SkeletonBlock className="h-3 w-1/2" />
              <SkeletonBlock className="h-20 w-full" />
              <div className="flex gap-2">
                <SkeletonBlock className="h-8 w-28" />
                <SkeletonBlock className="h-8 w-16" />
                <SkeletonBlock className="h-8 w-20" />
              </div>
            </div>
          </article>
        ))}
      </div>
    </PageSkeletonFrame>
  );
}
