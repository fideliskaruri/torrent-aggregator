import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MaxActiveDownloadsControl } from "@/components/settings/max-active-downloads";
import { DownloadRecovery } from "@/components/settings/download-recovery";
import { SettingsDisclosure } from "@/components/settings/settings-disclosure";
import { StorageLocations } from "@/components/settings/storage-locations";
import type { SettingsPatch } from "./settings-types";

interface DownloadSettings {
  baseDownloadPath: string | null;
  maxActiveDownloads: number;
}

export function DownloadSettingsSection({
  settings,
  saving,
  onSave,
}: {
  settings: DownloadSettings;
  saving: boolean;
  onSave: (patch: SettingsPatch) => Promise<boolean>;
}) {
  const [maxActive, setMaxActive] = useState(settings.maxActiveDownloads);
  const [open, setOpen] = useState(true);

  return (
    <SettingsDisclosure
      id="downloads"
      title="Downloads"
      summary="Choose where downloads are stored and how many run at once."
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div className="space-y-5" data-settings-downloads>
        <DownloadRecovery revision={settings.baseDownloadPath ?? undefined} />
        <StorageLocations />
        <FormField label="Downloads at once" htmlFor="max-active-downloads">
          <div className="flex flex-wrap items-center gap-3">
            <MaxActiveDownloadsControl
              id="max-active-downloads"
              value={maxActive}
              onChange={setMaxActive}
              className="max-w-fit"
            />
            <Button
              type="button"
              variant="outline"
              disabled={saving || maxActive === settings.maxActiveDownloads}
              onClick={() => void onSave({ maxActiveDownloads: maxActive })}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-subtle-foreground">
            The rest wait in line. Download now starts one right away.
          </p>
        </FormField>
      </div>
    </SettingsDisclosure>
  );
}
