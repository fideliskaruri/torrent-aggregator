import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useApiQuery } from "@/hooks/use-api-query";
import {
  DESKTOP_URL,
  UPDATE_DISMISS_KEY,
  isBusy,
  progressPercent,
  shouldShowUpdateBanner,
  startUpdate,
  type DesktopStatus,
} from "@/lib/desktop";

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(UPDATE_DISMISS_KEY);
  } catch {
    return null;
  }
}

/** A slim notice under the header when the installed Windows app has an update; hidden everywhere else. */
export function UpdateBanner() {
  const [fastPoll, setFastPoll] = useState(false);
  const { data, refetch } = useApiQuery<DesktopStatus>(DESKTOP_URL, {
    refreshMs: fastPoll ? 1000 : 30 * 60_000,
    emptyOnUnauthorized: true,
  });
  const [dismissed, setDismissed] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readDismissed(),
  );
  const [error, setError] = useState<string | null>(null);

  const install = data?.updates.install;
  const busy = isBusy(install);
  useEffect(() => {
    setFastPoll(busy);
  }, [busy]);

  if (!shouldShowUpdateBanner(data, dismissed) || !data) return null;
  const latest = data.updates.latest;
  const version = latest?.version ?? "";

  async function update() {
    setError(null);
    try {
      await startUpdate();
      setFastPoll(true);
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  function dismiss() {
    try {
      window.localStorage.setItem(UPDATE_DISMISS_KEY, version);
    } catch {
      // Private mode: dismiss for this page view only.
    }
    setDismissed(version);
  }

  const pct = install ? progressPercent(install) : null;
  const failed = install?.state === "failed";

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-[var(--border)] bg-[var(--bg-elevated)]"
      data-update-banner
    >
      <div className="container-app flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-2 py-2">
        <Download className="h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm text-[var(--text)]">
          {busy
            ? install?.state === "installing"
              ? `Installing TorrentFlow ${version}. It will reopen in a moment.`
              : `Downloading TorrentFlow ${version}${pct !== null ? ` · ${pct}%` : ""}`
            : failed
              ? <span className="text-[var(--danger)]">{install?.error ?? "The update failed."}</span>
              : `TorrentFlow ${version} is available.`}
          {error ? <span className="ml-2 text-[var(--danger)]">{error}</span> : null}
        </p>
        {busy ? (
          <Progress
            value={install?.state === "installing" ? 100 : pct ?? 0}
            className="order-last w-full basis-full sm:order-none sm:w-40 sm:basis-auto"
            aria-label="Update progress"
          />
        ) : latest?.hasInstaller ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" onClick={() => void update()} aria-label={`Update to TorrentFlow ${version}`} data-update-banner-install>
              {failed ? "Try again" : "Update"}
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss update notice" data-update-banner-dismiss>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            {latest?.pageUrl ? (
              <Button asChild variant="secondary" size="sm">
                <a href={latest.pageUrl} target="_blank" rel="noreferrer">Release page</a>
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss update notice" data-update-banner-dismiss>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
