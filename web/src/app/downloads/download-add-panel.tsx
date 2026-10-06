import { Link } from "react-router";
import { ChevronDown, Magnet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { LoadingGlyph } from "@/components/ui/loading";
import { TORRENT_SOURCE_INPUT_HINT } from "@/lib/torrents/magnet-input";
import type { useDownloadsPage } from "./use-downloads-page";

type Model = ReturnType<typeof useDownloadsPage>;

export function DownloadAddPanel({ page }: { page: Model }) {
  return (
    <Collapsible open={page.addPanelOpen} onOpenChange={page.toggleAddPanel}
      className="surface group/add" data-raw-torrent-send>
      <CollapsibleTrigger
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-[inherit] px-4 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
        data-raw-torrent-toggle>
        <Magnet aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[13px] font-medium text-foreground">Add torrent</span>
        <span className="hidden min-w-0 truncate text-[12px] text-subtle-foreground sm:inline">Magnet link or .torrent URL</span>
        <ChevronDown aria-hidden className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/add:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-4 pb-4 pt-1">
        <p className="text-[12px] leading-relaxed text-subtle-foreground">
          Paste a magnet link or a direct .torrent URL, then add it to your downloads.
        </p>
        <Textarea ref={page.rawSendInputRef} className="min-h-24" value={page.rawSendValue}
          onChange={(event) => {
            page.setRawSendValue(event.target.value);
            if (page.rawSendError) page.setRawSendError(null);
          }}
          placeholder="magnet:?xt=urn:btih:… or https://example.com/source.torrent"
          aria-label="Paste a magnet link or .torrent URL"
          aria-invalid={page.rawSendInvalid || page.rawSendError?.field === "source" || undefined}
          aria-describedby={page.rawSendAnyError ? "raw-torrent-send-error" : undefined}
          data-raw-torrent-send-input />
        {page.rawSendInvalid ? (
          <p id="raw-torrent-send-error" className="text-[12px] leading-relaxed text-destructive"
            data-raw-torrent-send-error="source" data-raw-torrent-invalid>
            {TORRENT_SOURCE_INPUT_HINT}
          </p>
        ) : page.rawSendError ? (
          <p id="raw-torrent-send-error" role="alert" className="text-[12px] leading-relaxed text-destructive"
            data-raw-torrent-send-error={page.rawSendError.field ?? "send"}>
            {page.rawSendError.message}
            {page.rawSendError.field === "savePath" ? (
              <>{" "}<Link to="/settings" className="inline-flex min-h-[44px] items-center font-medium text-brand-foreground underline underline-offset-2 lg:min-h-0">Open Settings</Link></>
            ) : null}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => void page.sendRawTorrent()}
            disabled={page.sendingRaw || !page.rawSendTrimmed || page.rawSendInvalid}
            className="w-full shrink-0 sm:w-auto" data-raw-torrent-send-button>
            {page.sendingRaw ? <LoadingGlyph className="h-3.5 w-3.5" /> : <Magnet aria-hidden />}
            Add torrent
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
