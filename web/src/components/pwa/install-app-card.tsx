import { useCallback, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveInstallState, type InstallState } from "./install-state";
import { installStore } from "./install-store";

/**
 * The install affordance for TorrentFlow, shown on About.
 *
 * Renders nothing unless installing is actually possible, so there is never a
 * button that does nothing — including after a declined install, where the
 * card explains the browser's own install control rather than offering a retry
 * that would throw on a spent `beforeinstallprompt` event.
 *
 * All environment reads live in the store and are only taken after mount, so
 * server and first-client render agree.
 */
export function InstallAppCard() {
  const snapshot = useSyncExternalStore(
    installStore.subscribe,
    installStore.getSnapshot,
    installStore.getServerSnapshot,
  );

  const install = useCallback(() => {
    void installStore.promptInstall();
  }, []);

  const dismiss = useCallback(() => {
    installStore.dismiss();
  }, []);

  const state: InstallState = resolveInstallState(snapshot);
  if (state === "unsupported") return null;

  return (
    <Card
      data-install-card
      data-install-state={state}
      className="sm:[--card-spacing:--spacing(5)]"
    >
      <CardHeader>
        <CardTitle className="text-[13px]" role="heading" aria-level={2}>Install</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">

      {state === "installed" ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          TorrentFlow is installed on this device. It still needs your server
          running. The app window is a shortcut, not a copy.
        </p>
      ) : (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Add TorrentFlow to this device to open it in its own window, without
          browser chrome. It still talks to your server for everything; nothing
          plays offline.
        </p>
      )}

      {state === "prompt" || state === "prompting" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={install}
            disabled={state === "prompting"}
            aria-label="Install TorrentFlow on this device"
            data-install-action
          >
            {state === "prompting"
              ? "Waiting for the browser…"
              : "Install TorrentFlow"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={dismiss}
            disabled={state === "prompting"}
            aria-label="Dismiss the install prompt"
            data-install-dismiss
          >
            Not now
          </Button>
        </div>
      ) : null}

      {state === "declined" || state === "error" ? (
        <div className="space-y-3">
          <p
            className="text-[12px] leading-relaxed text-subtle-foreground"
            data-install-note
          >
            {state === "error"
              ? `The browser couldn't open the install dialog: ${snapshot.errorMessage}`
              : "You closed the install dialog."}{" "}
            A browser offers this once at a time. Install from the icon in the
            address bar, or the browser menu → Install TorrentFlow. The button
            here returns when the browser offers again.
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={dismiss}
            aria-label="Dismiss the install prompt"
            data-install-dismiss
          >
            Not now
          </Button>
        </div>
      ) : null}

      {state === "ios" ? (
        <ol className="list-decimal pl-5 space-y-1 text-[12px] leading-relaxed text-subtle-foreground">
          <li>Tap the Share button in Safari&apos;s toolbar.</li>
          <li>Choose &ldquo;Add to Home Screen&rdquo;.</li>
          <li>Confirm. TorrentFlow opens full-screen from then on.</li>
        </ol>
      ) : null}
      </CardContent>
    </Card>
  );
}
