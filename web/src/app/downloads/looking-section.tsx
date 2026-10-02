import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Search } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { openReleasePicker, PICK_RELEASE_LABEL } from "@/components/releases/release-picker-store";
import { WAITING_FOR_ENGLISH_LABEL } from "@/components/title/title-actions";
import { useCapabilities } from "@/lib/capabilities";
import { useVisiblePoll } from "@/hooks/use-visible-poll";

/** One target from GET /api/wanted that has no release yet. */
interface WantedRow {
  workKey: string;
  title?: string | null;
  season?: number | null;
  episode?: number | null;
  error?: string | null;
  why?: string | null;
  looking: boolean;
  nextAttemptAt?: string | null;
}

interface LookingGroup {
  key: string;
  workKey: string;
  title: string;
  label: string | null;
  looking: boolean;
  /** Releases were found but none has English audio or subtitles. */
  waitingForEnglish: boolean;
  season: number | null;
  /** Set when the group is one episode. */
  episode: number | null;
  why: string | null;
  nextAttemptAt: string | null;
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
    const label =
      first.season == null
        ? null
        : episodes.length === 1
          ? `S${String(first.season).padStart(2, "0")}E${String(episodes[0]).padStart(2, "0")}`
          : `Season ${first.season} · ${episodes.length} episodes`;
    const next = items
      .map((i) => i.nextAttemptAt)
      .filter((d): d is string => Boolean(d))
      .sort()[0];
    return {
      key,
      workKey: first.workKey,
      title: first.title || first.workKey,
      label,
      looking: items.some((i) => i.looking),
      waitingForEnglish: items.some((i) => i.error?.startsWith(WAITING_FOR_ENGLISH_LABEL) ?? false),
      season: first.season ?? null,
      episode: episodes.length === 1 ? episodes[0] : null,
      why: items.find((i) => i.why)?.why ?? items.find((i) => i.error)?.error ?? null,
      nextAttemptAt: next ?? null,
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

/**
 * What was asked for but has no release yet: a click shows here at once as
 * "Looking for a release" and moves to the list below when a release is found.
 */
export function LookingSection() {
  const { canDownload } = useCapabilities();
  const [rows, setRows] = useState<WantedRow[]>([]);

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
  if (!groups.length) return null;

  return (
    <section className="surface overflow-hidden mb-3" data-looking-section aria-label="Looking for a release">
      <div className="px-3 py-2 border-b border-border text-[12px] font-medium uppercase tracking-wide text-subtle-foreground">
        Looking for a release
      </div>
      <div className="divide-y divide-border">
        {groups.map((g) => (
          <div key={g.key} className="flex items-start gap-3 px-3 py-2.5" data-looking-row={g.workKey}>
            <span className="mt-0.5 text-subtle-foreground">
              {g.looking ? <Spinner className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <Link to={`/title/${encodeURIComponent(g.workKey)}`} className="block truncate text-[14px] font-medium hover:underline">
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
            {g.waitingForEnglish && canDownload ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-looking-pick-release
                aria-label={`${PICK_RELEASE_LABEL} for ${g.title}${g.label ? `, ${g.label}` : ""}`}
                onClick={() =>
                  openReleasePicker({
                    workKey: g.workKey,
                    title: g.title,
                    season: g.season,
                    episode: g.episode,
                    onPicked: () => void load(),
                  })
                }
                className="shrink-0 max-sm:min-h-11"
              >
                <Search aria-hidden />
                Pick a release
              </Button>
            ) : null}

          </div>
        ))}
      </div>
    </section>
  );
}
