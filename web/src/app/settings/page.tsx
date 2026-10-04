import { Link } from "react-router";
import { HardDrive } from "lucide-react";
import { PageQueryBoundary } from "@/components/tf/page-query-boundary";
import { TfPageHeader } from "@/components/tf/page-header";
import { PageSkeletonFrame, SkeletonBlock } from "@/components/ui/loading";
import { Button } from "@/components/ui/button";
import { DesktopSection } from "@/components/settings/desktop-section";
import { JellyfinSettings } from "@/components/settings/jellyfin-settings";
import { RemoteAccessSection } from "@/components/settings/remote-access-section";
import { SourcesSettings } from "@/components/settings/sources-settings";
import { DownloadSettingsSection } from "./download-settings-section";
import { QualitySettingsSection } from "./quality-settings-section";
import { useSettings } from "./use-settings";

export default function SettingsPage() {
  const { query, save, saving } = useSettings();

  return (
    <PageQueryBoundary
      query={query}
      skeleton={(visible) => <SettingsSkeleton visible={visible} />}
      errorTitle="Could not load your settings"
      errorMessage={(error) => `${error} Try again to reload your saved values.`}
      frame={(node) => <main className="container-app max-w-2xl space-y-5 py-6 pb-24 sm:py-8">{node}</main>}
    >
      {(settings) => (
        <main className="container-app max-w-2xl space-y-5 py-6 pb-24 sm:py-8">
          <TfPageHeader
            title="Settings"
            description="Choose where downloads go and set your preferences."
            meta={
              <Button asChild variant="link" className="h-auto min-h-11 px-0">
                <Link to="/settings/library">
                  <HardDrive aria-hidden="true" className="size-4" />
                  Import a folder
                </Link>
              </Button>
            }
          />
          {!settings.setupComplete ? (
            <div role="status" className="rounded-lg border border-brand/30 bg-brand-dim p-3 text-sm">
              Choose a download folder and space limit before your first download.
            </div>
          ) : null}
          <DownloadSettingsSection
            key={JSON.stringify([settings.baseDownloadPath, settings.maxStorageGb, settings.maxActiveDownloads])}
            settings={settings}
            saving={saving}
            onSave={save}
          />
          <QualitySettingsSection
            key={JSON.stringify([settings.preferredResolution, settings.audioLanguage])}
            settings={settings}
            saving={saving}
            onSave={save}
          />
          <SourcesSettings />
          <JellyfinSettings />
          <RemoteAccessSection />
          <DesktopSection />
        </main>
      )}
    </PageQueryBoundary>
  );
}

function SettingsSkeleton({ visible }: { visible: boolean }) {
  return (
    <PageSkeletonFrame
      aria-label="Loading settings"
      className={`container-app max-w-2xl space-y-5 py-6 transition-opacity duration-150 ${visible ? "" : "opacity-0"}`}
    >
      <h1 className="sr-only">Settings</h1>
      <div className="surface space-y-4 p-4">
        <SkeletonBlock className="h-5 w-36" />
        <SkeletonBlock className="h-11 w-full" />
        <SkeletonBlock className="h-11 w-48 max-w-full" />
      </div>
      <div className="surface space-y-4 p-4">
        <SkeletonBlock className="h-5 w-36" />
        <SkeletonBlock className="h-11 w-full" />
      </div>
    </PageSkeletonFrame>
  );
}
