import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

export const QUALITY_CHOICES = [
  { value: 480, label: "480p", hint: "Small files" },
  { value: 720, label: "720p", hint: "Balanced" },
  { value: 1080, label: "1080p", hint: "Recommended" },
  { value: 2160, label: "4K", hint: "Largest files" },
] as const;

/** The minimum download quality choices, shared by Settings and per-title controls. */
export function QualityOptions({
  name,
  value,
  onChange,
  disabled,
  className,
}: {
  name: string;
  value: number | null | undefined;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <RadioGroup
      name={name}
      aria-label="Minimum download quality"
      value={value == null ? "" : String(value)}
      disabled={disabled}
      onValueChange={(next) => onChange(Number(next))}
      className={cn("grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-2", className)}
    >
      {QUALITY_CHOICES.map((choice) => (
        <Label
          key={choice.value}
          htmlFor={`${name}-${choice.value}`}
          className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 font-normal transition-colors hover:border-input has-data-checked:border-brand has-data-checked:bg-brand-dim"
        >
          <RadioGroupItem id={`${name}-${choice.value}`} value={String(choice.value)} className="mt-0.5" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] font-medium text-foreground">{choice.label}</span>
            <span className="text-xs text-subtle-foreground">{choice.hint}</span>
          </span>
        </Label>
      ))}
    </RadioGroup>
  );
}
