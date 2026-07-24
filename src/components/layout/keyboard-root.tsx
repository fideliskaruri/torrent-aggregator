"use client";

import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

export function KeyboardRoot({ children }: { children: React.ReactNode }) {
  useKeyboardShortcuts();
  return <>{children}</>;
}
