import { Link } from "react-router";
import { TfPageHeader } from "@/components/tf/page-header";
import { InstallAppCard } from "@/components/pwa/install-app-card";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";

export default function AboutPage() {
  useDocumentTitle("About");

  return (
    <div className="container-app max-w-xl py-8 sm:py-12 space-y-8 min-w-0">
      <TfPageHeader
        title="About"
        description="TorrentFlow is a self-hosted search UI over public torrent indexers. It does not host files or magnets."
      />

      <InstallAppCard />

      <section className="surface p-4 sm:p-5 space-y-3 text-[13px] text-[var(--text-secondary)] leading-relaxed">
        <h2 className="text-[13px] font-medium text-[var(--text)]">Legal</h2>
        <p>
          You are responsible for complying with copyright and other laws where
          you live. Only download content you have the right to access.
        </p>
        <p>
          Indexer availability and bot-protection are controlled by third
          parties. Client credentials are encrypted at rest when{" "}
          <code className="text-[12px] text-[var(--accent-text)]">
            AUTH_SECRET
          </code>{" "}
          is set.
        </p>
      </section>

      <section className="surface p-4 sm:p-5 space-y-3">
        <h2 className="text-[13px] font-medium text-[var(--text)]">Keyboard</h2>
        {/* Only shortcuts the app actually binds. `m` (copy magnet) and `s`
            (send to client) were listed here long after the result cards
            stopped handling them — documentation for keys that do nothing is
            worse than none, because the user blames themselves. */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px] font-mono text-[var(--text-tertiary)]">
          <dt className="text-[var(--text-secondary)]">/</dt>
          <dd>Focus search, or open Search from anywhere</dd>
          <dt className="text-[var(--text-secondary)]">j / k</dt>
          <dd>Next / previous result</dd>
          <dt className="text-[var(--text-secondary)]">← / →</dt>
          <dd>Move between cards in a browse rail</dd>
          <dt className="text-[var(--text-secondary)]">g then …</dt>
          <dd>h browse · s search · w watchlist · c downloads · a notifications · r rules · d download log · t settings</dd>
        </dl>
      </section>

      <Button asChild variant="ghost" size="sm" className="px-0 h-auto">
        <Link to="/">← Browse</Link>
      </Button>
    </div>
  );
}
