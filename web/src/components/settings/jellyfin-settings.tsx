import { useEffect, useState } from "react";
import { SkeletonBlock } from "@/components/ui/loading";
import { TfErrorState } from "@/components/tf/error-state";
import { useApiQuery } from "@/hooks/use-api-query";
import { JELLYFIN_URL, connectedLine, type JellyfinStatus } from "@/lib/jellyfin";
import { JellyfinConnected } from "./jellyfin-connected";
import { JellyfinSignIn } from "./jellyfin-signin";
import { SettingsDisclosure } from "./settings-disclosure";

export function JellyfinSettings() {
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#jellyfin-settings",
  );
  const query = useApiQuery<JellyfinStatus>(JELLYFIN_URL, { emptyOnUnauthorized: false });
  const [status, setStatus] = useState<JellyfinStatus | null>(null);
  useEffect(() => { if (query.data) setStatus(query.data); }, [query.data]);

  const summary = !status ? "Play, watch progress and library folders."
    : status.configured ? connectedLine(status) : "Not connected. Play, watch progress and library folders.";

  return (
    <SettingsDisclosure id="jellyfin-settings" title="Jellyfin" summary={summary} open={open}
      onToggle={() => setOpen((value) => !value)} className="scroll-mt-20">
      <div className="min-w-0" data-jellyfin-settings>
        {status ? (
          status.configured
            ? <JellyfinConnected status={status} onChange={setStatus} />
            : <JellyfinSignIn initialServer={status.serverUrl ?? ""} onConnected={setStatus} />
        ) : query.error ? (
          <TfErrorState title="Could not load Jellyfin settings" message={query.error} onRetry={query.refetch} />
        ) : (
          <div className="space-y-3" aria-busy="true" aria-label="Loading Jellyfin settings">
            <SkeletonBlock className="h-4 w-56 max-w-full" />
            <SkeletonBlock className="h-11 w-full" />
            <SkeletonBlock className="h-11 w-full" />
          </div>
        )}
      </div>
    </SettingsDisclosure>
  );
}
