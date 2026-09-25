import { createContext, useContext, type ReactNode } from "react";
import { useApiQuery } from "@/hooks/use-api-query";
import { displayPath, type DisplayPathMapping } from "@/lib/display-path";

export interface Features {
  streaming: boolean;
  runningInContainer: boolean;
  openFolder: boolean;
  displayPathMappings: DisplayPathMapping[];
}

const FeaturesContext = createContext<Features>({ streaming: false, runningInContainer: false, openFolder: false, displayPathMappings: [] });

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const { data, loading, error } = useApiQuery<Features>("/api/features", {
    refreshMs: 30_000,
    emptyOnUnauthorized: false,
  });
  const streaming = !loading && !error && data?.streaming === true;
  const openFolder = !loading && !error && data?.openFolder === true;
  const runningInContainer = data?.runningInContainer === true;
  const displayPathMappings = Array.isArray(data?.displayPathMappings) ? data.displayPathMappings : [];
  return (
    <FeaturesContext.Provider value={{ streaming, runningInContainer, openFolder, displayPathMappings }}>
      {children}
    </FeaturesContext.Provider>
  );
}

export function useFeatures(): Features {
  return useContext(FeaturesContext);
}

export function useDisplayPath(): (path: string) => string {
  const { displayPathMappings } = useFeatures();
  return (path) => displayPath(path, displayPathMappings);
}
