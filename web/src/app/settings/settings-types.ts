export type AudioLanguage = "auto" | "en" | "english" | "any";

export interface SettingsData {
  baseDownloadPath: string;
  maxStorageGb: string | number;
  maxActiveDownloads: number;
  preferredResolution: number;
  audioLanguage: AudioLanguage;
  setupComplete: boolean;
}

export type SettingsPatch = Partial<
  Pick<
    SettingsData,
    | "baseDownloadPath"
    | "maxStorageGb"
    | "maxActiveDownloads"
    | "preferredResolution"
    | "audioLanguage"
  >
>;
