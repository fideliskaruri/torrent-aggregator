import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TfPageHeader } from "@/components/tf/page-header";
import { FolderImport } from "@/components/library/folder-import";
import { StorageRoots } from "@/components/library/storage-roots";
import { useDocumentTitle } from "@/hooks/use-document-title";

export default function LibrarySettingsPage() {
  useDocumentTitle("Drives and import");
  return (
    <div className="container-app max-w-2xl space-y-5 py-6 pb-24 sm:py-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/settings"><ChevronLeft aria-hidden />Settings</Link>
      </Button>
      <TfPageHeader title="Drives and import" description="Choose where your library lives and bring in files you already have." />
      <div className="surface divide-y divide-border overflow-hidden rounded-xl">
        <section id="drives" aria-labelledby="drives-title" className="scroll-mt-20 space-y-4 p-4 sm:p-5">
          <div>
            <h2 id="drives-title" className="text-sm font-medium text-foreground">Drives</h2>
            <p className="mt-1 text-xs text-subtle-foreground">
              New files go to the first drive that accepts their kind, until it reaches its keep free amount.
            </p>
          </div>
          <StorageRoots />
        </section>
        <section id="import" aria-labelledby="import-title" className="scroll-mt-20 space-y-4 p-4 sm:p-5">
          <div>
            <h2 id="import-title" className="text-sm font-medium text-foreground">Import a folder</h2>
            <p className="mt-1 text-xs text-subtle-foreground">
              Scan a folder of films or episodes you already have. You review every match before anything changes.
            </p>
          </div>
          <FolderImport />
        </section>
      </div>
    </div>
  );
}
