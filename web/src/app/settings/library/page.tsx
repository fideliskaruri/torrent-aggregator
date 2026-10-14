import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TfPageHeader } from "@/components/tf/page-header";
import { FolderImport } from "@/components/library/folder-import";
import { useDocumentTitle } from "@/hooks/use-document-title";

export default function LibrarySettingsPage() {
  useDocumentTitle("Import a folder");
  return (
    <div className="container-app max-w-3xl space-y-5 py-6 pb-24 sm:py-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/settings"><ChevronLeft aria-hidden />Settings</Link>
      </Button>
      <TfPageHeader title="Import a folder" description="Scan a folder of films or episodes you already have. You review every match before anything changes." />
      <section id="import" aria-label="Import a folder" className="surface space-y-4 rounded-xl p-4 sm:p-5">
        <FolderImport />
      </section>
    </div>
  );
}
