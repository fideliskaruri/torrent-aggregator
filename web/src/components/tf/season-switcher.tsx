/**
 * The one season picker. `tabs` is the series dialog's chapter rail (inside
 * a `Tabs`), `select` is the phone and title-page dropdown, and `pills` is
 * the add-to-library "start from a season" row (inside a `RadioGroup`).
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface SeasonOption {
  value: string;
  label: string;
  /** Shown under the label in a tab; appended to the label in a select. */
  detail?: ReactNode;
  detailText?: string;
  attrs?: Record<string, string | number | undefined>;
}

type SeasonSwitcherProps =
  | {
      variant: "tabs";
      options: SeasonOption[];
      value: string | null;
      ariaLabel: string;
    }
  | {
      variant: "select";
      options: SeasonOption[];
      value: string | null;
      onValueChange: (value: string) => void;
      triggerClassName?: string;
      triggerAttrs?: Record<string, string>;
      itemClassName?: string;
      align?: "start" | "center" | "end";
      placeholder?: string;
    }
  | {
      variant: "pills";
      options: SeasonOption[];
    };

export function SeasonSwitcher(props: SeasonSwitcherProps) {
  if (props.variant === "tabs") return <SeasonTabs {...props} />;
  if (props.variant === "pills") {
    return (
      <div className="flex flex-wrap gap-2">
        {props.options.map((option) => (
          <Label
            key={option.value}
            {...option.attrs}
            className="relative h-11 min-w-[44px] cursor-pointer justify-center rounded-full border border-border bg-background px-3.5 text-[13px] font-normal tabular-nums text-muted-foreground transition-colors hover:border-input hover:text-foreground has-data-checked:border-brand has-data-checked:bg-brand-dim has-data-checked:text-foreground has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
          >
            <RadioGroupItem value={option.value} aria-label={option.label} className="absolute inset-0 size-full opacity-0 after:hidden" />
            {option.label}
          </Label>
        ))}
      </div>
    );
  }
  return (
    <Select value={props.value ?? undefined} onValueChange={props.onValueChange}>
      <SelectTrigger aria-label="Season" className={props.triggerClassName} {...props.triggerAttrs}>
        <SelectValue placeholder={props.placeholder ?? "Season"} />
      </SelectTrigger>
      <SelectContent position="popper" align={props.align}>
        {props.options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className={props.itemClassName}
            {...option.attrs}
          >
            {option.detailText ? `${option.label} · ${option.detailText}` : option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SeasonTabs({
  options,
  value,
  ariaLabel,
}: {
  options: SeasonOption[];
  value: string | null;
  ariaLabel: string;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);

  // Keeps the selected season in view inside the scroll viewport as seasons
  // arrive, the rail resizes, or the season changes from elsewhere.
  const ensureSelectedVisible = useCallback(() => {
    const viewport = railRef.current?.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    );
    if (!viewport || viewport.clientWidth === 0) return;
    const activeTab = viewport.querySelector<HTMLElement>('[data-season-tab-active="true"]');
    if (!activeTab) return;
    const viewportRect = viewport.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    if (tabRect.left < viewportRect.left) {
      viewport.scrollLeft -= viewportRect.left - tabRect.left;
    } else if (tabRect.right > viewportRect.right) {
      viewport.scrollLeft += tabRect.right - viewportRect.right;
    }
  }, []);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(ensureSelectedVisible);
    observer.observe(rail);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(ensureSelectedVisible);
    mutationObserver?.observe(rail, {
      subtree: true,
      childList: true,
      attributeFilter: ["data-season-tab-active"],
    });
    ensureSelectedVisible();
    return () => {
      mutationObserver?.disconnect();
      observer.disconnect();
    };
  }, [ensureSelectedVisible]);

  return (
    <div ref={railRef} className="shrink-0 border-b border-border" data-season-rail>
      <ScrollArea className="w-full">
        <TabsList aria-label={ariaLabel} className="mx-4 my-2 gap-1.5 group-data-horizontal/tabs:h-auto sm:mx-5">
          {options.map((option) => (
            <TabsTrigger
              key={option.value}
              value={option.value}
              data-season-tab
              data-season-tab-key={option.value}
              data-season-tab-active={option.value === value ? "true" : "false"}
              {...option.attrs}
              className={cn(
                "group/season h-auto flex-none flex-col items-start gap-1 px-3 py-1.5 text-left max-md:min-h-11 pointer-coarse:min-h-11",
              )}
            >
              <span className="whitespace-nowrap text-[12px] font-medium">{option.label}</span>
              {option.detail}
            </TabsTrigger>
          ))}
        </TabsList>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
