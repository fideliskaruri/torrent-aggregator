import { toast } from "@/lib/toast";
import {
  PICK_TOAST_CLASSNAMES,
  pickReleaseToastButton,
  type ReleasePickTarget,
} from "@/components/releases/release-picker-store";

/** Keeps a toast's Retry a 44px touch target on phones. */
const RETRY_TOAST_CLASSNAMES = {
  actionButton: "max-sm:min-h-11 max-sm:px-4!",
} as const;

export interface DownloadOutcomeRetry {
  label: string;
  onClick: (event: { preventDefault: () => void }) => void;
}

/**
 * The one toast for how a Download went: the title page (single grab and
 * season), the library's on-demand grab, and anything else that sends a
 * download. A miss can offer "Pick a release yourself" and a Retry; both
 * keep the toast up until the owner acts. Retry owns the action slot (it keeps
 * the toast open), so the pick then sits in the cancel slot, which closes it.
 */
export function toastDownloadOutcome({
  ok,
  message,
  description,
  id,
  pick,
  retry,
}: {
  ok: boolean;
  message: string;
  description?: string;
  /** Reuse a toast, e.g. the season's "Retrying" toast. */
  id?: string;
  /** Offers "Pick a release yourself" for this target. Null when the viewer can't download. */
  pick?: ReleasePickTarget | null;
  retry?: DownloadOutcomeRetry;
}) {
  const pickButton = pick ? pickReleaseToastButton(pick) : undefined;
  const options = {
    ...(id ? { id } : {}),
    description,
    // A plain success fades; anything the owner can act on stays.
    duration: pickButton || retry || !ok ? Infinity : undefined,
    action: retry ?? pickButton,
    cancel: retry ? pickButton : undefined,
    classNames: pickButton ? PICK_TOAST_CLASSNAMES : retry ? RETRY_TOAST_CLASSNAMES : undefined,
  };
  return ok ? toast.success(message, options) : toast.error(message, options);
}
