import { cn } from "@/lib/utils";

export const CARD_WIDTH = "w-full sm:w-[300px] sm:shrink-0 sm:snap-start";

export const CARD_ACTION_PILL = cn(
  "h-11 gap-1 rounded-full border-foreground/14 dark:border-foreground/14",
  "bg-background/86 text-foreground shadow-sm backdrop-blur-sm dark:bg-background/86",
  "hover:border-input hover:bg-background dark:hover:bg-background",
  "disabled:cursor-default disabled:opacity-100",
);

export const CARD_ACTION_SLOT =
  "absolute bottom-2 right-2 z-10 flex items-center gap-1.5 sm:bottom-auto sm:top-2";
