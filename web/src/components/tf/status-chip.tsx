import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TONE_CLASS = {
  neutral: "bg-muted text-muted-foreground",
  active: "bg-brand-dim text-brand-foreground",
  waiting: "bg-info/15 text-info",
  done: "bg-success/15 text-success",
  error: "bg-destructive/15 text-destructive",
} as const;

export function StatusChip({
  label,
  tone,
  className,
}: {
  label: string;
  tone: keyof typeof TONE_CLASS;
  className?: string;
}) {
  return <Badge variant="secondary" className={cn(TONE_CLASS[tone], className)}>{label}</Badge>;
}
