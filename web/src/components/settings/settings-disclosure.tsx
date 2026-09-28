import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
    <Collapsible
      asChild
      open={open}
      onOpenChange={(next) => {
        if (next !== open) onToggle();
      }}
    >
      <section
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-card",
          className,
        )}
      >
        <CollapsibleTrigger
          id={id}
          aria-controls={panelId}
          className="group/disclosure flex min-h-[52px] w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted focus-visible:outline-offset-[-3px]"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {title}
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-subtle-foreground">
              {summary}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-subtle-foreground transition-transform group-data-[state=open]/disclosure:rotate-180 motion-reduce:transition-none"
          />
        </CollapsibleTrigger>
        <CollapsibleContent
          id={panelId}
          role="region"
          aria-labelledby={id}
          className="border-t border-border p-4 sm:p-5"
        >
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
