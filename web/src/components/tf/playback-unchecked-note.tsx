import { TriangleAlert } from "lucide-react";

/** Shown inside a delete confirmation once the server couldn't check Jellyfin playback. */
export function PlaybackUncheckedNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground"
      data-playback-unchecked
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>{message}</p>
    </div>
  );
}
