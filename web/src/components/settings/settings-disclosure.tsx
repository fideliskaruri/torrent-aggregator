"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsDisclosureProps {
  id: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}

export function SettingsDisclosure({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
  className,
}: SettingsDisclosureProps) {
  const panelId = `${id}-panel`;

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]",
        className,
      )}
    >
      <button
        id={id}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex min-h-[52px] w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[var(--bg-muted)] focus-visible:outline-offset-[-3px]"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-[var(--text)]">
            {title}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-tertiary)]">
            {summary}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-[var(--text-tertiary)] transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={id}
          className="border-t border-[var(--border)] p-4 sm:p-5"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}
