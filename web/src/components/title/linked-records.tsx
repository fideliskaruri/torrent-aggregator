/**
 * "Linked records": the other sites' records this title is matched to (the
 * crosswalk, `GET /api/title/{workKey}/links`), where each match came from, and
 * an Unlink for the owner when one is wrong. Unlinking is for good: the match
 * is never made again and its names and id leave the title.
 *
 * Collapsed by default and loaded only when opened, so the page never waits on
 * it and nothing under the hero moves.
 */
import { useCallback, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { LoadingGlyph } from "@/components/ui/loading";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type WorkLink = {
  provider: string;
  externalId: string;
  mediaType: string | null;
  season: number | null;
  source: string;
  confidence: number;
  verified: boolean;
  rejected: boolean;
  givesNames: boolean;
  names: string[];
  url: string | null;
};

const PROVIDERS: Record<string, string> = {
  anilist: "AniList",
  tmdb: "TMDB",
  mal: "MyAnimeList",
  imdb: "IMDb",
  tvdb: "TVDB",
  anidb: "AniDB",
};

const SOURCES: Record<string, string> = {
  provider: "Reported by the title's own record",
  fribb: "From the anime-lists map",
  "title-search": "Suggested by a title search",
  owner: "Added by you",
};

export function providerLabel(provider: string) {
  return PROVIDERS[provider] ?? provider;
}

function linkLabel(link: WorkLink) {
  return `${providerLabel(link.provider)} ${link.externalId}`;
}

export function LinkedRecords({ workKey }: { workKey: string }) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<WorkLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<WorkLink | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/title/${encodeURIComponent(workKey)}/links`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(base, { headers: { accept: "application/json" } });
      if (res.status === 404) {
        setLinks([]);
        return;
      }
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { links: WorkLink[] };
      setLinks(body.links);
    } catch {
      setError("Couldn't load the linked records. Close and open this again to retry.");
    }
  }, [base]);

  const unlink = async (link: WorkLink) => {
    setBusy(true);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(link.provider)}/${encodeURIComponent(link.externalId)}`, {
        method: "DELETE",
      });
      const body = (await res.json().catch(() => ({}))) as { links?: WorkLink[]; message?: string };
      if (!res.ok) throw new Error(body.message ?? "Couldn't unlink it. Try again.");
      if (body.links) setLinks(body.links);
      toast.success(`Unlinked ${linkLabel(link)}.`);
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Couldn't unlink it. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const active = links?.filter((l) => !l.rejected) ?? [];
  const rejected = links?.filter((l) => l.rejected) ?? [];

  return (
    <section aria-labelledby="title-links-heading" data-title-links>
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next && links == null) void load();
        }}
      >
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="-ml-3 min-h-11 gap-2 px-3" data-title-links-toggle>
            <h2 id="title-links-heading" className="text-title">
              Linked records
            </h2>
            <ChevronDown className={cn("transition-transform", open && "rotate-180")} aria-hidden />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-3">
          <p className="text-[13px] text-subtle-foreground">
            Records on other sites matched to this title. Their names help find releases. Unlink one that is wrong.
          </p>
          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : links == null ? (
            <p className="flex items-center gap-2 text-[13px] text-subtle-foreground" aria-busy="true">
              <LoadingGlyph className="h-3.5 w-3.5" /> Loading linked records
            </p>
          ) : active.length === 0 && rejected.length === 0 ? (
            <p className="text-[13px] text-subtle-foreground" data-title-links-empty>
              No linked records yet.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border" data-title-links-list>
              {active.map((link) => (
                <LinkRow key={`${link.provider}:${link.externalId}`} link={link} onUnlink={() => setPending(link)} />
              ))}
              {rejected.map((link) => (
                <LinkRow key={`${link.provider}:${link.externalId}`} link={link} />
              ))}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>

      <ConfirmDialog
        open={pending != null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={pending ? `Unlink ${linkLabel(pending)}?` : "Unlink this record?"}
        description="Its id and names leave this title, and it won't be linked again."
        confirmLabel="Unlink"
        variant="destructive"
        busy={busy}
        onConfirm={() => {
          if (pending) void unlink(pending);
        }}
        contentData={{ "data-unlink-dialog": true }}
        confirmData={{ "data-unlink-confirm": true }}
      />
    </section>
  );
}

function LinkRow({ link, onUnlink }: { link: WorkLink; onUnlink?: () => void }) {
  const names = link.names.slice(0, 3);
  return (
    <li
      className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
      data-title-link={`${link.provider}:${link.externalId}`}
      data-rejected={link.rejected || undefined}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {link.url ? (
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-1 text-[14px] font-medium text-foreground underline-offset-4 hover:underline sm:min-h-0"
            >
              {linkLabel(link)}
              <ExternalLink className="size-3.5 text-subtle-foreground" aria-hidden />
            </a>
          ) : (
            <span className="text-[14px] font-medium text-foreground">{linkLabel(link)}</span>
          )}
          {link.season != null ? <Badge>Season {link.season}</Badge> : null}
          {link.rejected ? (
            <Badge variant="danger">Unlinked</Badge>
          ) : link.verified ? (
            <Badge variant="success">Verified</Badge>
          ) : (
            <Badge variant="info">Suggested</Badge>
          )}
        </div>
        <p className="text-[12px] text-subtle-foreground">
          {SOURCES[link.source] ?? link.source}
          {link.givesNames && !link.rejected ? ". Its names are used to search" : ""}
        </p>
        {names.length > 0 ? (
          <p className="truncate text-[12px] text-muted-foreground" title={link.names.join(", ")}>
            {names.join(", ")}
          </p>
        ) : null}
      </div>
      {onUnlink ? (
        <Button
          variant="outline"
          className="min-h-11 shrink-0 self-start sm:self-center"
          onClick={onUnlink}
          data-title-link-unlink
        >
          Unlink
        </Button>
      ) : null}
    </li>
  );
}
