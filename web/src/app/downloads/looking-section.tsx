import { useMemo } from "react";
import { Link } from "react-router";
import { Search } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { WAITING_FOR_ENGLISH_LABEL } from "@/components/title/title-actions";
import {
  WantedActions,
  useWantedRows,
  wantedRowMatches,
  type WantedRow,
} from "@/components/wanted/wanted-actions";
import { useCapabilities } from "@/lib/capabilities";
import { titleWithYear } from "./release-display";

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
  /** The catalog title alone, for the release picker. */
  name: string;
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
      name,
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

function groupName(g: LookingGroup): string {
  return g.label ? `${g.title} ${g.label}` : g.title;
}

/**
 * What was asked for but has no release yet: a click shows here at once as
 * "Looking for a release" and moves to the list below when a release is found.
 * Every row has a way out: pick a release yourself, try now, or remove it.
 */
export function LookingSection() {
  const { canManage } = useCapabilities();
  const { rows, setRows, reload } = useWantedRows();

  const groups = useMemo(
    () => groupRows(rows).sort((a, b) => Number(b.looking) - Number(a.looking)),
    [rows],
  );

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
            {canManage ? (
              <WantedActions
                target={g}
                name={groupName(g)}
                pickTitle={g.name}
                looking={g.looking}
                onChanged={reload}
                onRemoved={() => setRows((current) => current.filter((r) => !wantedRowMatches(r, g)))}
                className="pl-7 sm:pl-0 sm:shrink-0"
              />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
