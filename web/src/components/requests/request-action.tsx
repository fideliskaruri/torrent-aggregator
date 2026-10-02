import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RequestDialog } from "@/components/requests/request-dialog";
import { requestViewFor, type RequestState, type RequesterTitle } from "@/lib/requests";

/**
 * What someone who can't download sees where the owner's Download sits: the
 * state of their request, and a Request button while there is something to ask
 * for. A title the catalog can't name says so instead of showing a dead button.
 */
export function RequestAction({
  title,
  state,
  onRequested,
  size = "lg",
  className,
}: {
  /** Null when the catalog can't name the title well enough to ask for it. */
  title: RequesterTitle | null;
  state: RequestState;
  onRequested?: () => void;
  size?: "sm" | "lg";
  className?: string;
}) {
  const [asking, setAsking] = useState<RequesterTitle | null>(null);
  // Shows "Requested" straight away instead of waiting for the next catalog read.
  const [sent, setSent] = useState(false);
  const view = requestViewFor(
    sent && !state.requestStatus && !state.inLibrary ? { ...state, requestStatus: "pending" } : state,
    title?.isSeries === true,
  );
  const canAsk = title?.providerId != null;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);

  return (
    <>
      {view.label ? (
        <Badge
          ref={statusRef}
          // Focus lands here after a request when no button is left to hold it.
          tabIndex={-1}
          variant={view.tone}
          data-request-status={
            state.inLibrary || (!state.requestStatus && (state.availableSeasons?.length ?? 0) > 0)
              ? "available"
              : (state.requestStatus ?? "pending")
          }
          className="self-center justify-self-start px-2 py-1 text-[13px]"
        >
          {view.label}
        </Badge>
      ) : null}
      {view.note ? (
        <p className="self-center text-sm text-subtle-foreground" data-request-note>
          {view.note}
        </p>
      ) : null}
      {view.action && canAsk ? (
        <Button
          ref={buttonRef}
          type="button"
          size={size}
          variant={view.label ? "secondary" : "default"}
          onClick={() => title && setAsking(title)}
          data-request-button={title?.key ?? ""}
          className={className ?? "w-full min-w-0 md:w-auto md:min-w-[8rem]"}
        >
          <Plus aria-hidden />
          {view.action}
        </Button>
      ) : view.action ? (
        <p className="self-center text-sm text-subtle-foreground" data-request-unmatched>
          Couldn't match this title to a catalog entry. Search for it to request it.
        </p>
      ) : null}
      <RequestDialog
        title={asking}
        onClose={() => setAsking(null)}
        returnFocusTo={() => buttonRef.current ?? statusRef.current}
        onCreated={() => {
          setSent(true);
          onRequested?.();
        }}
      />
    </>
  );
}
