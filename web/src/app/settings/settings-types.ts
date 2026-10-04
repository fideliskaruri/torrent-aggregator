export type AudioLanguage = "auto" | "english" | "any";

export interface SettingsData {
  baseDownloadPath: string;
  maxStorageGb: string;
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

export type SettingsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; settings: SettingsData; saving: boolean };
