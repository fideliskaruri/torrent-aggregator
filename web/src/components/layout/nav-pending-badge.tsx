import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/** The pending-requests count on a nav link: header, its More menu and the phone nav. */
export function NavPendingBadge({
  count,
  className,
  ...attrs
}: {
  count: string;
  className?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <Badge
      variant="solid"
      aria-label={`${count} pending`}
      className={cn("min-w-5 rounded-full px-1.5 text-[12px] font-semibold tabular-nums", className)}
      {...attrs}
    >
      {count}
    </Badge>
  );
}
