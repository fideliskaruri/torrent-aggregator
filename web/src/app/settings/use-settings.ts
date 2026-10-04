import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { toast } from "@/lib/toast";
import type {
  AudioLanguage,
  SettingsData,
  SettingsPatch,
  SettingsState,
} from "./settings-types";

interface SettingsResponse {
  settings?: Partial<SettingsData> | null;
}

const DEFAULT_SETTINGS: SettingsData = {
  baseDownloadPath: "",
  maxStorageGb: "0",
  maxActiveDownloads: 4,
  preferredResolution: 1080,
  audioLanguage: "auto",
  setupComplete: false,
};

function audioLanguage(value: unknown): AudioLanguage {
  return value === "english" || value === "any" ? value : "auto";
}

function normalize(settings?: Partial<SettingsData> | null): SettingsData {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    baseDownloadPath: settings?.baseDownloadPath ?? "",
    maxStorageGb:
      settings?.maxStorageGb != null && Number(settings.maxStorageGb) > 0
        ? String(settings.maxStorageGb)
        : "0",
    audioLanguage: audioLanguage(settings?.audioLanguage),
    setupComplete: settings?.setupComplete === true,
  };
}

export function useSettings() {
  const [state, setState] = useState<SettingsState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await get<SettingsResponse>("/api/settings/client", {
        cache: "no-store",
      });
      if (!response.ok) throw response.error ?? new Error("Could not load settings.");
      setState({ status: "ready", settings: normalize(response.data?.settings), saving: false });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not load settings.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  const save = useCallback(async (patch: SettingsPatch) => {
    if (state.status !== "ready") return false;
    setState({ ...state, saving: true });
    try {
      const response = await send<SettingsResponse>("/api/settings/client", {
        method: "PUT",
        body: patch,
      });
      if (!response.ok) throw response.error ?? new Error("Could not save settings.");
      const settings = normalize(response.data?.settings);
      setState({ status: "ready", settings, saving: false });
      toast.success("Changes saved");
      return true;
    } catch (error) {
      setState({ ...state, saving: false });
      toast.error(error instanceof Error ? error.message : "Could not save settings.");
      return false;
    }
  }, [state]);

  return { state, retry, save };
}
