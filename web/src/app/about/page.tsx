import { Link } from "react-router";
import { TfPageHeader } from "@/components/tf/page-header";
import { InstallAppCard } from "@/components/pwa/install-app-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useCapabilities } from "@/lib/capabilities";

export default function AboutPage() {
  useDocumentTitle("About");
  // Shared page: requesters get install, legal and keys, never how the owner's machine is set up.
  const { canManage } = useCapabilities();

  return (
    <div className="container-app max-w-xl py-8 sm:py-12 space-y-8 min-w-0">
      <TfPageHeader
        title="About"
        description="TorrentFlow is a self-hosted search UI over public torrent indexers. It does not host files or magnets."
      />

      <InstallAppCard />

      <Card className="min-w-0 sm:[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-[13px]" role="heading" aria-level={2}>Legal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-[13px] leading-relaxed break-words text-muted-foreground">
        <p className="break-words whitespace-normal">
          You are responsible for complying with copyright and other laws where
          you live. Only download content you have the right to access.
        </p>
        {canManage ? (
        <p className="break-words whitespace-normal" data-about-owner-config>
          Indexer availability and bot-protection are controlled by third
          parties. Client credentials are encrypted at rest when{" "}
          <code className="break-all font-mono text-[12px] text-brand-foreground">
            AUTH_SECRET
          </code>{" "}
          is set.
        </p>
        ) : null}
        </CardContent>
      </Card>

      <Card className="min-w-0 sm:[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-[13px]" role="heading" aria-level={2}>Keyboard</CardTitle>
        </CardHeader>
        <CardContent>
        {/* Only shortcuts the app actually binds. `m` (copy magnet) and `s`
            (send to client) were listed here long after the result cards
            stopped handling them — documentation for keys that do nothing is
            worse than none, because the user blames themselves. */}
        <dl className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-[auto_1fr] sm:items-center sm:gap-x-4 sm:gap-y-2.5">
          <div className="min-w-0 sm:contents">
            <dt><Kbd className="font-mono">/</Kbd></dt>
            <dd className="break-words text-subtle-foreground">
              Focus search, or open Search from anywhere
            </dd>
          </div>
          <div className="min-w-0 sm:contents">
            <dt><KbdGroup><Kbd className="font-mono">j</Kbd><Kbd className="font-mono">k</Kbd></KbdGroup></dt>
            <dd className="break-words text-subtle-foreground">
              Next / previous result
            </dd>
          </div>
          <div className="min-w-0 sm:contents">
            <dt><KbdGroup><Kbd>←</Kbd><Kbd>→</Kbd></KbdGroup></dt>
            <dd className="break-words text-subtle-foreground">
              Move between cards in a browse rail
            </dd>
          </div>
          <div className="min-w-0 sm:contents">
            <dt className="flex items-center gap-1 text-muted-foreground"><Kbd className="font-mono">g</Kbd> then</dt>
            <dd className="break-words text-subtle-foreground">
              {canManage
                ? "h browse · s search · w watchlist · c downloads · a notifications · r rules · d download log · t settings"
                : "h browse · s search · w watchlist · a notifications"}
            </dd>
          </div>
        </dl>
        </CardContent>
      </Card>

      <Button asChild variant="ghost" size="sm" className="px-0 h-auto">
        <Link to="/">← Browse</Link>
      </Button>
    </div>
  );
}
