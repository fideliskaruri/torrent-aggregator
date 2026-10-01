import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { RefreshCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { WAITING_FOR_ENGLISH_LABEL } from "@/components/title/title-actions";
import { useVisiblePoll } from "@/hooks/use-visible-poll";
import { toast } from "@/lib/toast";
import { titleWithYear } from "./release-display";

/** One target from GET /api/wanted that has no release yet. */
interface WantedRow {
  workKey: string;
  title?: string | null;
  year?: number | null;
  mediaType?: string | null;
  season?: number | null;
  episode?: number | null;
  error?: string | null;
  why?: string | null;
  looking: boolean;
  nextAttemptAt?: string | null;
  /** "Pick a release yourself" for this film or episode. */
  pickLink?: string | null;
  /** "Pick a release yourself" for the episode's whole season. */
  seasonPickLink?: string | null;
}

interface LookingGroup {
  key: string;
  workKey: string;
  title: string;
  label: string | null;
  season: number | null;
  /** Set when the group is one episode, so its actions touch only that episode. */
  episode: number | null;
  looking: boolean;
  /** Releases were found but none has English audio or subtitles. */
  waitingForEnglish: boolean;
  why: string | null;
  nextAttemptAt: string | null;
  pickLink: string | null;
}

/** One line per film or season, so a 38 episode season is one row, not 38. */
function groupRows(rows: WantedRow[]): LookingGroup[] {
  const groups = new Map<string, WantedRow[]>();
  for (const row of rows) {
    const key = `${row.workKey}|${row.season ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, items]) => {
    const first = items[0];
    const episodes = items.map((i) => i.episode).filter((e): e is number => e != null);
    const single = first.season != null && episodes.length === 1 ? episodes[0] : null;
    const label =
      first.season == null
        ? null
        : single != null
          ? `S${String(first.season).padStart(2, "0")}E${String(single).padStart(2, "0")}`
          : `Season ${first.season} · ${episodes.length} episodes`;
    const next = items
      .map((i) => i.nextAttemptAt)
      .filter((d): d is string => Boolean(d))
      .sort()[0];
    const name = first.title || first.workKey;
    return {
      key,
      workKey: first.workKey,
      // A film says its year, so a remake reads apart from the original.
      title: first.season == null ? titleWithYear(name, first.year) : name,
      label,
      season: first.season ?? null,
      episode: single,
      looking: items.some((i) => i.looking),
      waitingForEnglish: items.some((i) => i.error?.startsWith(WAITING_FOR_ENGLISH_LABEL) ?? false),
      why: items.find((i) => i.why)?.why ?? items.find((i) => i.error)?.error ?? null,
      nextAttemptAt: next ?? null,
      pickLink: (first.season != null && single == null ? first.seasonPickLink : first.pickLink) ?? null,
    };
  });
}

function nextTry(iso: string | null): string {
  if (!iso) return "Trying again soon";
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 1) return "Trying again in a minute";
  if (minutes < 90) return `Trying again in ${minutes} minutes`;
  return `Trying again at ${new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function targetQuery(g: LookingGroup): string {
  const params = new URLSearchParams({ workKey: g.workKey });
  if (g.season != null) params.set("season", String(g.season));
  if (g.episode != null) params.set("episode", String(g.episode));
  return params.toString();
}

function groupName(g: LookingGroup): string {
  return g.label ? `${g.title} ${g.label}` : g.title;
}

/**
 * What was asked for but has no release yet: a click shows here at once as
 * "Looking for a release" and moves to the list below when a release is found.
 * Every row has a way out: pick a release yourself, try now, or remove it.
 */
export function LookingSection() {
  const [rows, setRows] = useState<WantedRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<LookingGroup | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/wanted");
      if (!res.ok) return;
      const data = (await res.json()) as { wanted?: WantedRow[] };
      setRows(data.wanted ?? []);
    } catch {
      // Keep the last rows; the next poll tries again.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useVisiblePoll(load, { intervalMs: 3_000 });

  const groups = useMemo(
    () => groupRows(rows).sort((a, b) => Number(b.looking) - Number(a.looking)),
    [rows],
  );

  const tryNow = useCallback(
    async (g: LookingGroup) => {
      setBusy(g.key);
      try {
        const res = await fetch(`/api/wanted/try?${targetQuery(g)}`, { method: "POST" });
        if (!res.ok) throw new Error(String(res.status));
        toast.success(`Looking for ${groupName(g)} now.`);
        await load();
      } catch {
        toast.error(`Couldn't start a search for ${groupName(g)}. Check that TorrentFlow is running, then try again.`);
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const remove = useCallback(async () => {
    const g = pendingRemove;
    if (!g) return;
    setBusy(g.key);
    try {
      const res = await fetch(`/api/wanted?${targetQuery(g)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      setRows((current) =>
        current.filter(
          (r) =>
            r.workKey !== g.workKey ||
            (r.season ?? null) !== g.season ||
            (g.episode != null && r.episode !== g.episode),
        ),
      );
      toast.success(`Removed ${groupName(g)}. TorrentFlow stopped looking for it.`);
      setPendingRemove(null);
      await load();
    } catch {
      toast.error(`Couldn't remove ${groupName(g)}. Check that TorrentFlow is running, then try again.`);
    } finally {
      setBusy(null);
    }
  }, [load, pendingRemove]);

  if (!groups.length) return null;

  return (
    <section className="surface overflow-hidden mb-3" data-looking-section aria-label="Looking for a release">
      <h2 className="px-3 py-2 border-b border-border text-[13px] font-medium text-muted-foreground">
        Looking for a release
      </h2>
      <div className="divide-y divide-border">
        {groups.map((g) => (
          <div
            key={g.key}
            className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
            data-looking-row={g.workKey}
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="mt-0.5 text-subtle-foreground">
                {g.looking ? <Spinner className="h-4 w-4" /> : <Search className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <Link
                  to={`/title/${encodeURIComponent(g.workKey)}`}
                  className="block truncate text-[14px] font-medium hover:underline"
                  data-looking-title
                >
                  {g.title}
                  {g.label ? <span className="text-subtle-foreground font-normal"> · {g.label}</span> : null}
                </Link>
                <p className="text-[12px] text-subtle-foreground" data-looking-state={g.waitingForEnglish ? "waiting_english" : undefined}>
                  {g.waitingForEnglish
                    ? `${WAITING_FOR_ENGLISH_LABEL}. ${g.looking ? "Looking again now" : nextTry(g.nextAttemptAt)}.`
                    : g.looking
                      ? "Looking for a release"
                      : `Not found yet. ${nextTry(g.nextAttemptAt)}.`}
                </p>
                {!g.looking && !g.waitingForEnglish && g.why ? (
                  <p className="text-[12px] text-subtle-foreground line-clamp-2">{g.why}</p>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-7 sm:pl-0 sm:shrink-0">
              {g.pickLink ? (
                <Button asChild variant="secondary" size="sm" data-looking-pick>
                  <Link to={g.pickLink} aria-label={`Pick a release for ${groupName(g)}`}>
                    <Search className="h-3.5 w-3.5" />
                    Pick a release
                  </Link>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-disabled={g.looking || busy === g.key}
                onClick={() => {
                  if (!g.looking && busy !== g.key) void tryNow(g);
                }}
                aria-label={`Try now for ${groupName(g)}`}
                data-looking-try
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Try now
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy === g.key}
                onClick={() => setPendingRemove(g)}
                aria-label={`Remove ${groupName(g)}`}
                data-looking-remove
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        contentData={{ "data-looking-remove-dialog": true }}
        confirmData={{ "data-looking-remove-confirm": true }}
        title={pendingRemove ? `Remove ${groupName(pendingRemove)}?` : "Remove?"}
        description="TorrentFlow stops looking for a release, also after a restart. Anything already downloading stays. You can download it again from its title page."
        variant="destructive"
        busy={!!pendingRemove && busy === pendingRemove.key}
        icon={<Trash2 className="h-3.5 w-3.5" />}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
      />
    </section>
  );
}
