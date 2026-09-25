import { createContext, useContext, type ReactNode } from "react";
import { useApiQuery } from "@/hooks/use-api-query";

export interface Features {
  streaming: boolean;
}

const FeaturesContext = createContext<Features>({ streaming: false });

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const { data, loading, error } = useApiQuery<Features>("/api/features", {
    refreshMs: 30_000,
    emptyOnUnauthorized: false,
  });
  const streaming = !loading && !error && data?.streaming === true;
  return (
    <FeaturesContext.Provider value={{ streaming }}>
      {children}
    </FeaturesContext.Provider>
  );
}

export function useFeatures(): Features {
  return useContext(FeaturesContext);
}
