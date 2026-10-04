import { useApiMutation } from "@/hooks/use-api-mutation";
import { useApiQuery } from "@/hooks/use-api-query";
import { toast } from "@/lib/toast";
import type { SettingsData, SettingsPatch } from "./settings-types";

interface SettingsResponse {
  settings?: SettingsData | null;
}

export function useSettings() {
  const query = useApiQuery<SettingsData>("/api/settings/client", {
    emptyOnUnauthorized: false,
    select: (json) => {
      const settings = (json as SettingsResponse | null)?.settings;
      if (!settings) throw new Error("Could not load settings.");
      return settings;
    },
  });
  const mutation = useApiMutation<SettingsPatch, SettingsResponse>("/api/settings/client", "PUT");

  async function save(patch: SettingsPatch) {
    try {
      await mutation.run(patch);
      query.refetch();
      toast.success("Changes saved");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save settings.");
      return false;
    }
  }

  return { query, save, saving: mutation.pending };
}
