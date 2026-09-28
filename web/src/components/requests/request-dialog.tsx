import { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TfErrorState } from "@/components/tf/error-state";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  formatSeasons,
  parseSeasons,
  requestSeasonsUrl,
  sendRequest,
  type RequestScope,
  type RequesterTitle,
} from "@/lib/requests";
import { useCapabilities } from "@/lib/capabilities";

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
  // The owner's preview renders the dialog but never sends: the server only takes requests from requesters.
  const { previewing, ownerSession } = useCapabilities();
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

  // The preview reads the same season list through the owner's session, so it shows exactly what a requester picks from.
  const seasonsUrl = requestSeasonsUrl(title, ownerSession);
  const seasonQuery = useApiQuery<number[]>(seasonsUrl, {
    enabled: open,
    select: parseSeasons,
    emptyOnUnauthorized: false,
    deps: [seasonsUrl],
  });
  const seasonList = seasonQuery.data ?? [];

  const needsSeasons = title?.isSeries === true && scope === "seasons";
  const canSubmit = !busy && !previewing && (!needsSeasons || seasons.length > 0);

  const toggleSeason = (season: number, checked: boolean) =>
    setSeasons((current) =>
      checked ? [...new Set([...current, season])] : current.filter((s) => s !== season),
    );

  async function submit() {
    if (!title || !canSubmit) return;
    if (previewing) {
      setError("Requests aren't sent while previewing. Exit preview to go back to your own view.");
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await sendRequest(title, { scope, seasons, note });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    toast.success(`Requested ${title.title}`);
    onCreated();
    onClose();
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogContent className="gap-4 overflow-y-auto p-5 sm:max-w-md" data-request-dialog>
        <DialogHeader>
          <DialogTitle>Request {title?.title ?? ""}</DialogTitle>
          <DialogDescription>
            The owner decides. Follow it under Requests.
          </DialogDescription>
        </DialogHeader>

        {title?.isSeries ? (
          <fieldset className="space-y-2" data-request-scope>
            <legend className="mb-1 text-xs font-medium text-muted-foreground">What to get</legend>
            <RadioGroup
              value={scope}
              onValueChange={(value) => setScope(value as RequestScope)}
              aria-label="What to get"
            >
              <ScopeOption
                id={`${noteId}-scope-series`}
                value="series"
                label="Whole series"
                hint="Every season, including new ones."
              />
              <ScopeOption
                id={`${noteId}-scope-seasons`}
                value="seasons"
                label="Pick seasons"
                hint={seasons.length > 0 ? formatSeasons(seasons) : "Choose one or more below."}
              />
            </RadioGroup>
            {scope === "seasons" ? (
              <div className="pt-1" data-request-seasons>
                {seasonQuery.loading ? (
                  <p className="flex items-center gap-2 text-sm text-subtle-foreground">
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
                  <p className="text-sm text-subtle-foreground">
                    No season list for this one. Ask for the whole series instead.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                    {seasonList.map((season) => {
                      const id = `${noteId}-season-${season}`;
                      return (
                        <Label
                          key={season}
                          htmlFor={id}
                          className="min-h-11 cursor-pointer gap-2 rounded-md px-2 font-normal text-foreground hover:bg-muted lg:min-h-9"
                        >
                          <Checkbox
                            id={id}
                            checked={seasons.includes(season)}
                            onCheckedChange={(checked) => toggleSeason(season, checked === true)}
                            data-request-season={season}
                          />
                          Season {season}
                        </Label>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </fieldset>
        ) : null}

        <FormField label="Note for the owner (optional)" htmlFor={noteId}>
          <Textarea
            id={noteId}
            rows={2}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Anything they should know"
            className="min-w-0 scroll-mb-32"
            data-request-note
          />
        </FormField>

        {previewing ? (
          <p className="text-sm text-muted-foreground" data-request-preview-note>
            Preview: requests aren&apos;t sent. Exit preview to go back to your own view.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive" data-request-error>
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Not now
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit} data-request-submit>
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
            {busy ? "Requesting…" : "Request"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScopeOption({
  id,
  value,
  label,
  hint,
}: {
  id: string;
  value: RequestScope;
  label: string;
  hint: string;
}) {
  return (
    <Label
      htmlFor={id}
      className="min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 font-normal has-data-[state=checked]:border-brand/25 has-data-[state=checked]:bg-brand-dim"
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" data-request-scope-option={value} />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs leading-snug text-subtle-foreground">{hint}</span>
      </span>
    </Label>
  );
}
