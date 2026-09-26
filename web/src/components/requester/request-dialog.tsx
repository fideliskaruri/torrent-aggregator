import { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TfErrorState } from "@/components/tf/error-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { sessionAwareFetch } from "@/lib/session-expiry";
import { cn } from "@/lib/utils";
import {
  createRequestBody,
  formatSeasons,
  parseSeasons,
  requestErrorMessage,
  type RequestScope,
  type RequesterTitle,
} from "./requests";

const NOTE_MAX = 500;

/**
 * Asks for one title. Movies confirm with an optional note; series choose the
 * whole series or specific seasons from the catalog's season list.
 */
export function RequestDialog({
  title,
  onClose,
  onCreated,
}: {
  title: RequesterTitle | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const open = title != null;
  const noteId = useId();
  const [scope, setScope] = useState<RequestScope>("series");
  const [seasons, setSeasons] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setScope("series");
    setSeasons([]);
    setNote("");
    setError(null);
    setBusy(false);
  }, [title?.key, title?.provider, title?.providerId]);

  const seasonsUrl = title?.isSeries
    ? `/api/requester/seasons?${new URLSearchParams({
        provider: title.provider,
        providerId: title.providerId ?? "",
        mediaType: title.mediaType,
        title: title.title,
        ...(title.year ? { year: String(title.year) } : {}),
      })}`
    : null;
  const seasonQuery = useApiQuery<number[]>(seasonsUrl, {
    enabled: open,
    select: parseSeasons,
    emptyOnUnauthorized: false,
    deps: [seasonsUrl],
  });
  const seasonList = seasonQuery.data ?? [];

  const needsSeasons = title?.isSeries === true && scope === "seasons";
  const canSubmit = !busy && (!needsSeasons || seasons.length > 0);

  const toggleSeason = (season: number, checked: boolean) =>
    setSeasons((current) =>
      checked ? [...new Set([...current, season])] : current.filter((s) => s !== season),
    );

  async function submit() {
    if (!title || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sessionAwareFetch("/api/requester/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createRequestBody(title, { scope, seasons, note })),
      });
      const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
      if (!res.ok) {
        setError(requestErrorMessage(body?.code, body?.error));
        return;
      }
      toast.success(`Asked for ${title.title}`);
      onCreated();
      onClose();
    } catch (err) {
      setError(requestErrorMessage(null, (err as Error)?.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogContent className="gap-4 overflow-y-auto p-5 sm:max-w-md" data-request-dialog>
        <DialogHeader>
          <DialogTitle>Request {title?.title ?? ""}</DialogTitle>
          <DialogDescription>
            The owner decides. You can follow it under My requests.
          </DialogDescription>
        </DialogHeader>

        {title?.isSeries ? (
          <fieldset className="space-y-2" data-request-scope>
            <legend className="mb-1 text-xs font-medium text-[var(--text-secondary)]">What to get</legend>
            <ScopeOption
              name="scope"
              value="series"
              checked={scope === "series"}
              onSelect={() => setScope("series")}
              label="Whole series"
              hint="Every season, including new ones."
            />
            <ScopeOption
              name="scope"
              value="seasons"
              checked={scope === "seasons"}
              onSelect={() => setScope("seasons")}
              label="Pick seasons"
              hint={seasons.length > 0 ? formatSeasons(seasons) : "Choose one or more below."}
            />
            {scope === "seasons" ? (
              <div className="pt-1" data-request-seasons>
                {seasonQuery.loading ? (
                  <p className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]">
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Loading seasons…
                  </p>
                ) : seasonQuery.error ? (
                  <TfErrorState
                    title="Couldn't load seasons"
                    message="Ask for the whole series instead, or try again."
                    onRetry={seasonQuery.refetch}
                    retrying={seasonQuery.refreshing}
                  />
                ) : seasonList.length === 0 ? (
                  <p className="text-sm text-[var(--text-tertiary)]">
                    No season list for this one. Ask for the whole series instead.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                    {seasonList.map((season) => {
                      const id = `${noteId}-season-${season}`;
                      return (
                        <label
                          key={season}
                          htmlFor={id}
                          className="flex min-h-11 cursor-pointer items-center gap-1 rounded-md px-1 text-sm text-[var(--text)] hover:bg-[var(--bg-muted)] lg:min-h-9 lg:gap-2 lg:px-2"
                        >
                          <Checkbox
                            id={id}
                            checked={seasons.includes(season)}
                            onCheckedChange={(checked) => toggleSeason(season, checked === true)}
                            data-request-season={season}
                          />
                          Season {season}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </fieldset>
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor={noteId} className="text-xs font-medium text-[var(--text-secondary)]">
            Note for the owner <span className="text-[var(--text-tertiary)]">(optional)</span>
          </label>
          <textarea
            id={noteId}
            rows={2}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Anything they should know"
            className="w-full min-w-0 scroll-mb-32 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)] placeholder:text-[var(--text-tertiary)] focus-visible:border-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-dim)] sm:text-sm"
            data-request-note
          />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-[var(--danger)]" data-request-error>
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Not now
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit} data-request-submit>
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
            {busy ? "Sending…" : "Send request"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScopeOption({
  name,
  value,
  checked,
  onSelect,
  label,
  hint,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3",
        checked ? "border-[var(--accent-border)] bg-[var(--accent-dim)]" : "border-[var(--border)]",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
        data-request-scope-option={value}
      />
      <span>
        <span className="block text-sm font-medium text-[var(--text)]">{label}</span>
        <span className="block text-xs text-[var(--text-tertiary)]">{hint}</span>
      </span>
    </label>
  );
}
