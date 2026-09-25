import { useEffect, useState } from "react";

type Density = "comfortable" | "compact";

/** Mirrors the stored density preference onto `<html data-density>`. */
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
      // localStorage is an external store; syncing it on mount belongs in an effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDensityState(stored);
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  return children;
}