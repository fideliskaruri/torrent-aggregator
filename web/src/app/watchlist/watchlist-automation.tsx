import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Radar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { LoadingGlyph } from "@/components/ui/loading";
import { useDownloadPrefs } from "@/hooks/use-download-prefs";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { automationStateCopy } from "@/components/library/library-state";
import { toast } from "@/lib/toast";

type Summary = { at: string; sent: number; skipped: number; failed: number; offline: boolean };
const STORAGE_KEY = "tf:last-automation";

function readSummary(): Summary | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Summary : null;
  } catch {
    return null;
  }
}

export function WatchlistAutomation({ count }: { count: number }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [last, setLast] = useState<Summary | null>(readSummary);
  const { prefs, loaded } = useDownloadPrefs();
  const automation = useApiMutation<Record<string, never>, {
    ok?: boolean;
    offline?: boolean;
    message?: string;
    summary?: { library?: { sent?: number; skipped?: number; failed?: number } };
  }>("/api/automation/run");

  async function run() {
    try {
      const result = await automation.run({});
      if (!result || result.ok === false) throw new Error(result?.message ?? "Automation could not finish. Try again.");
      const summary: Summary = {
        at: new Date().toISOString(),
        sent: result.summary?.library?.sent ?? 0,
        skipped: result.summary?.library?.skipped ?? 0,
        failed: result.summary?.library?.failed ?? 0,
        offline: Boolean(result.offline),
      };
      setLast(summary);
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(summary)); } catch { /* Storage is optional. */ }
      const detail = `${summary.sent} sent · ${summary.skipped} skipped · ${summary.failed} failed`;
      if (summary.offline) toast.warning(result.message ?? "Torrent client is offline", { description: detail });
      else toast.success(result.message ?? "Automation finished", { description: detail });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Automation could not finish. Try again.");
    } finally {
      setConfirmOpen(false);
    }
  }

  if (!count) return null;
  const interval = loaded ? prefs.automationIntervalMinutes ?? 0 : null;
  return <>
    <section className="space-y-3" data-watchlist-automation>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm leading-relaxed text-subtle-foreground">
          Checks monitored titles and may download matching sources. {automationStateCopy(interval)}
        </p>
        <Button type="button" size="sm" onClick={() => setConfirmOpen(true)} disabled={automation.pending}>
          {automation.pending ? <LoadingGlyph className="size-3.5" /> : <Radar className="size-3.5" />} Run automation
        </Button>
      </div>
      {last ? <div className="surface flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
        <span className="text-muted-foreground">Last automation{last.offline ? <Badge variant="danger" className="ml-1.5 align-middle">offline</Badge> : null}
          <span className="text-subtle-foreground"> · {last.sent} sent · {last.skipped} skipped · {last.failed} failed</span>
        </span>
        <Link to="/history" className="inline-flex min-h-11 items-center gap-1 font-medium text-brand-foreground hover:underline lg:min-h-0">View in Activity <ArrowRight className="size-3" /></Link>
      </div> : null}
    </section>
    <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} contentData={{ "data-automation-review": true }} title="Run library automation?" description="TorrentFlow searches every monitored title and may send matching sources to your download client right away. Review enabled titles and rules before you continue." cancelLabel="Review library" busy={automation.pending} icon={<Radar className="size-3.5" />} confirmLabel="Search and download matches" onConfirm={() => void run()} />
  </>;
}
