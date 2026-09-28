import { readJsonBody, sendErrorFromBody } from "@/lib/api-json";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { TfPageHeader } from "@/components/tf/page-header";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";
import { useDownloadSetup } from "@/components/setup/download-setup";
import { magnetFromShare } from "@/lib/pwa/magnet-from-share";
import { toast } from "@/lib/toast";
import { useDocumentTitle } from "@/hooks/use-document-title";

type ShareState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "ok"; name?: string }
  | { kind: "error"; message: string }
  | { kind: "missing" };

/**
 * Web Share Target landing page (owner only; the router's capability guard keeps others out). Extracts a magnet from the share
 * payload and posts it through the same /api/torrent/send path as Downloads.
 */
export default function SharePage() {
  useDocumentTitle("Share");
  const [params] = useSearchParams();
  const { ensureDownloadSetup } = useDownloadSetup();
  const [state, setState] = useState<ShareState>({ kind: "idle" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const magnet = magnetFromShare({
      url: params.get("url"),
      text: params.get("text"),
      title: params.get("title"),
    });
    if (!magnet) {
      setState({ kind: "missing" });
      return;
    }

    let cancelled = false;
    (async () => {
      setState({ kind: "working" });
      if (!(await ensureDownloadSetup())) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: "Finish download setup before adding a shared magnet.",
          });
        }
        return;
      }
      try {
        const res = await fetch("/api/torrent/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            magnet,
            source: "share-target",
            target: "primary",
            retention: "keep",
          }),
        });
        const data = await readJsonBody<{ ok?: boolean; message?: string; error?: string; name?: string }>(res);
        if (cancelled) return;
        if (res.ok && data && data.ok !== false) {
          setState({ kind: "ok", name: data.name });
          toast.success(data.message || "Added shared magnet to downloads");
        } else {
          const { message } = sendErrorFromBody(data, res.status);
          setState({ kind: "error", message });
          toast.error(message);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error && err.message ? err.message : "Couldn't reach TorrentFlow. Try again.";
          setState({ kind: "error", message });
          toast.error(message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ensureDownloadSetup, params]);


  return (
    <div className="container-app max-w-xl py-8 sm:py-12 space-y-6 min-w-0" data-share-page>
      <TfPageHeader
        title="Shared link"
        description="Magnets shared to TorrentFlow land here and start as ordinary downloads."
      />

      {state.kind === "working" || state.kind === "idle" ? (
        <div
          className="surface flex items-center gap-3 p-4 text-[13px] text-[var(--text-secondary)]"
          aria-busy="true"
          data-share-state="working"
        >
          <LoadingGlyph />
          Adding the shared magnet…
        </div>
      ) : null}

      {state.kind === "ok" ? (
        <div className="surface space-y-3 p-4" data-share-state="ok">
          <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed">
            Added to downloads{state.name ? `: ${state.name}` : ""}.
          </p>
          <Button asChild size="sm">
            <Link to="/downloads">Open downloads</Link>
          </Button>
        </div>
      ) : null}

      {state.kind === "missing" ? (
        <div className="surface space-y-3 p-4" data-share-state="missing">
          <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed">
            No magnet link was found in what was shared. Share a{" "}
            <code className="text-[12px] text-[var(--accent-text)]">magnet:</code> URI
            and try again.
          </p>
          <Button asChild size="sm" variant="secondary">
            <Link to="/downloads">Go to downloads</Link>
          </Button>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="surface space-y-3 p-4" data-share-state="error">
          <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed">
            {state.message}
          </p>
          <Button asChild size="sm" variant="secondary">
            <Link to="/downloads">Go to downloads</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
