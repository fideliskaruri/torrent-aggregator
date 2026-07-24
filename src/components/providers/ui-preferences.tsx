"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

type Density = "comfortable" | "compact";

interface UiPrefs {
  density: Density;
  setDensity: (d: Density) => void;
}

const Ctx = createContext<UiPrefs>({
  density: "compact",
  setDensity: () => undefined,
});

export function UiPreferencesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  /** Compact by default (Seerr/Linear density); respect stored preference. */
  const [density, setDensityState] = useState<Density>("compact");

  useEffect(() => {
    const stored = localStorage.getItem("tf-density") as Density | null;
    if (stored === "comfortable" || stored === "compact") {
      setDensityState(stored);
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    localStorage.setItem("tf-density", d);
  }, []);

  return (
    <Ctx.Provider value={{ density, setDensity }}>{children}</Ctx.Provider>
  );
}

export function useUiPreferences() {
  return useContext(Ctx);
}
