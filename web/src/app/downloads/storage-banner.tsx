import { useState } from "react";
import { Link } from "react-router";
import { HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CleanupSheet } from "@/components/settings/cleanup-sheet";
import { useStorageRoots } from "@/components/settings/storage-locations";

export function StorageBanner() {
  const { roots, refresh } = useStorageRoots();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const enabled = roots.filter((root) => root.enabled);
  if (enabled.length === 0 || enabled.some((root) => root.status === "online")) return null;

  const anyFull = enabled.some((root) => root.status === "full");
  const anyOffline = enabled.some((root) => root.status === "offline" || root.status === "review");
  const title =
    anyFull && anyOffline
      ? "Your drives are full or unplugged"
      : anyFull
        ? "Your drives are full"
        : "No drive is connected";
  const detail = anyFull
    ? "New downloads wait until there is room. Delete something you have watched or add another drive."
    : "Downloads wait and pick up again by themselves when a drive is plugged back in.";

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 sm:flex-row sm:items-center"
      data-storage-banner
    >
      <HardDrive className="hidden size-5 shrink-0 text-warning sm:block" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        {anyFull ? (
          <Button type="button" size="sm" onClick={() => setCleanupOpen(true)}>
            Free up space
          </Button>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link to="/settings#downloads">Storage settings</Link>
        </Button>
      </div>
      <CleanupSheet open={cleanupOpen} onOpenChange={setCleanupOpen} onDeleted={() => void refresh()} />
    </div>
  );
}
