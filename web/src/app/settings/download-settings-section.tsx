import { useState } from "react";
import { useDisplayPath, useFeatures } from "@/lib/features";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MaxActiveDownloadsControl } from "@/components/settings/max-active-downloads";
import { DownloadLocationFields } from "@/components/settings/download-location-fields";
import { DownloadRecovery } from "@/components/settings/download-recovery";
import { FolderPicker } from "@/components/settings/folder-picker";
import { SettingsDisclosure } from "@/components/settings/settings-disclosure";
import type { SettingsPatch } from "./settings-types";

interface DownloadSettings {
  baseDownloadPath: string | null;
  maxStorageGb: string | number;
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
  const [path, setPath] = useState(settings.baseDownloadPath ?? "");
  const [cap, setCap] = useState(String(settings.maxStorageGb));
  const [maxActive, setMaxActive] = useState(settings.maxActiveDownloads);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [open, setOpen] = useState(true);
  const { runningInContainer } = useFeatures();
  const displayPath = useDisplayPath();

  async function save() {
    await onSave({
      baseDownloadPath: path.trim(),
      maxStorageGb: cap,
      maxActiveDownloads: maxActive,
    });
  }

  return (
    <SettingsDisclosure
      id="downloads"
      title="Downloads"
      summary="Choose the download folder, space limit and how many downloads run at once."
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div className="space-y-4" data-settings-downloads>
        <DownloadRecovery revision={settings.baseDownloadPath ?? undefined} />
        <DownloadLocationFields
          folder={path}
          onFolderChange={setPath}
          onBrowse={() => setPickerOpen(true)}
          spaceGb={cap}
          onSpaceGbChange={setCap}
        />
        {runningInContainer ? (
          <p className="break-words text-xs text-subtle-foreground" data-container-path>
            Container paths are used for downloads.{" "}
            {displayPath(path || "/media") !== (path || "/media")
              ? `Host location: ${displayPath(path || "/media")}.`
              : "Set MEDIA_DISPLAY_PATH to show the host location."}
          </p>
        ) : null}
        <FormField label="Downloads at once" htmlFor="max-active-downloads">
          <MaxActiveDownloadsControl
            id="max-active-downloads"
            value={maxActive}
            onChange={setMaxActive}
            className="max-w-fit"
          />
          <p className="text-xs text-subtle-foreground">
            The rest wait in line. Download now starts one right away.
          </p>
        </FormField>
        <div className="flex justify-end">
          <Button type="button" disabled={saving || !path.trim() || Number(cap) < 1} onClick={() => void save()}>
            Save downloads
          </Button>
        </div>
        <FolderPicker
          open={pickerOpen}
          initialPath={path}
          title="Choose download folder"
          onClose={() => setPickerOpen(false)}
          onSelect={(selected) => {
            setPath(selected);
            setPickerOpen(false);
          }}
        />
      </div>
    </SettingsDisclosure>
  );
}
