import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RailArrow({
  direction,
  hidden,
  onClick,
}: {
  direction: "left" | "right";
  hidden: boolean;
  onClick: () => void;
}) {
  const Icon = direction === "left" ? ChevronLeft : ChevronRight;
  return (
    <div
      aria-hidden
      data-rail-arrow={direction}
      className={cn(
        "pointer-events-none absolute inset-y-0 z-[1] hidden w-12 items-center md:flex",
        "transition-opacity duration-150",
        direction === "left"
          ? "left-0 justify-start bg-gradient-to-r from-background via-background/80 to-transparent pl-1"
          : "right-0 justify-end bg-gradient-to-l from-background via-background/80 to-transparent pr-1",
        hidden
          ? "opacity-0"
          : "opacity-0 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100",
      )}
    >
      <Button
        type="button"
        variant="outline"
        size="icon"
        tabIndex={-1}
        onClick={onClick}
        className={cn(
          "rounded-full bg-card/90 text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground dark:bg-card/90",
          !hidden && "pointer-events-auto",
        )}
      >
        <Icon aria-hidden />
      </Button>
    </div>
  );
}
