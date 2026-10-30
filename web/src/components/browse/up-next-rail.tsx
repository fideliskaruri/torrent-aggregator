import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Download, Send, X } from "lucide-react";
import { get, send } from "@/lib/api";
import { toast } from "@/lib/toast";
import { MediaPoster, MediaPosterCaption, RAIL_CARD_WIDTH } from "@/components/browse/media-poster-card";
import { RailStrip } from "@/components/browse/rail";
import { Button } from "@/components/ui/button";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { titlePath } from "@/components/title/work-key";
import { cn } from "@/lib/utils";

interface SuggestionAction {
  kind: "download" | "request";
  method: string;
  url: string;
  body: unknown;
}

interface Suggestion {
  workKey: string;
  title: string;
  posterUrl: string | null;
  season: number;
  episode: number;
  reason: string;
  action: SuggestionAction | null;
}

interface SuggestionsPayload {
  items: Suggestion[];
  unavailable?: unknown;
}

const keyOf = (s: Suggestion) => `${s.workKey}:${s.season}:${s.episode}`;
const code = (s: Suggestion) =>
  `S${String(s.season).padStart(2, "0")}E${String(s.episode).padStart(2, "0")}`;

/**
 * Next episodes worth getting, from what has been watched in Jellyfin.
 *
 * Like the recommendation shelf, it renders nothing until it has something to
 * show: no Jellyfin, nothing watched or nothing missing means no row.
 */
export function UpNextRail() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const { ensureDownloadSetup } = useDownloadSetup();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await get<SuggestionsPayload>("/api/jellyfin/suggestions");
        if (!cancelled && res.ok && res.data && !res.data.unavailable) setItems(res.data.items ?? []);
      } catch {
        // A suggestion row is never worth an error message.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const drop = useCallback((key: string) => {
    setItems((prev) => prev.filter((s) => keyOf(s) !== key));
  }, []);

  const run = useCallback(
    async (item: Suggestion) => {
      const action = item.action;
      if (!action) return;
      const key = keyOf(item);
      if (action.kind === "download" && !(await ensureDownloadSetup())) return;
      setBusy(key);
      try {
        const res = await send<{ ok?: boolean; queued?: number; owned?: number; message?: string }>(
          action.url,
          { method: action.method, body: action.body },
        );
        if (!res.ok || res.data?.ok === false) {
          throw new Error(res.data?.message ?? res.error?.message ?? "Try again in a moment.");
        }
        drop(key);
        const label = `${item.title} ${code(item)}`;
        if (action.kind !== "download") toast.success(`Asked for ${label}`);
        else if (res.data?.queued === 0 && (res.data.owned ?? 0) > 0) toast.success(`${label} is already in your library`);
        else toast.success(`Looking for ${label}`);
      } catch (err) {
        toast.error(`Could not get ${item.title} ${code(item)}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setBusy(null);
      }
    },
    [drop, ensureDownloadSetup],
  );

  const dismiss = useCallback(
    async (item: Suggestion) => {
      const key = keyOf(item);
      drop(key);
      try {
        const res = await send("/api/jellyfin/suggestions/dismiss", {
          method: "POST",
          body: { workKey: item.workKey, season: item.season, episode: item.episode },
        });
        if (!res.ok) throw new Error();
      } catch {
        setItems((prev) => (prev.some((s) => keyOf(s) === key) ? prev : [...prev, item]));
        toast.error(`Could not hide ${item.title} ${code(item)}. Try again.`);
      }
    },
    [drop],
  );

  if (items.length === 0) return null;

  return (
    <RailStrip id="up-next" title="Up next for you" itemCount={items.length}>
      {items.map((item) => {
        const key = keyOf(item);
        const label = `${item.title} ${code(item)}`;
        return (
          <li
            key={key}
            data-up-next-card
            className={cn("group relative flex shrink-0 snap-start flex-col", RAIL_CARD_WIDTH)}
          >
            <Link
              to={titlePath(item.workKey, { title: item.title, series: true })}
              data-rail-card
              title={item.reason}
              className="block min-h-[44px] rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <MediaPoster
                variant="rail"
                src={item.posterUrl}
                title={item.title}
                sizes="(min-width: 1024px) 168px, (min-width: 640px) 148px, 124px"
                className="transition-[border-color] duration-150 group-hover:border-input"
              />
              <MediaPosterCaption title={item.title} subtitle={code(item)} />
            </Link>
            <button
              type="button"
              onClick={() => void dismiss(item)}
              aria-label={`Hide ${label}`}
              className="absolute top-1 right-1 inline-flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand lg:size-8"
            >
              <span className="inline-flex size-7 items-center justify-center rounded-full bg-background/80 text-muted-foreground backdrop-blur transition-colors hover:text-foreground">
                <X className="size-3.5" aria-hidden />
              </span>
            </button>
            {item.action ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void run(item)}
                disabled={busy === key}
                aria-label={`${item.action.kind === "download" ? "Download" : "Ask for"} ${label}`}
                className="mt-auto min-h-11 w-full text-[12px] text-muted-foreground lg:min-h-0"
              >
                {item.action.kind === "download" ? (
                  <Download className="h-3 w-3 shrink-0" aria-hidden />
                ) : (
                  <Send className="h-3 w-3 shrink-0" aria-hidden />
                )}
                <span className="truncate">
                  {busy === key ? "Sending…" : item.action.kind === "download" ? "Download" : "Ask for it"}
                </span>
              </Button>
            ) : null}
          </li>
        );
      })}
    </RailStrip>
  );
}
