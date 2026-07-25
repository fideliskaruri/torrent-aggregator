import { cn } from "@/lib/utils";

/**
 * A labelled form field.
 *
 * Placeholder-only forms lose their labels the moment a value is typed, and a
 * bare numeric input tells the user nothing at all. Every control that takes
 * user input should say what it is.
 */
export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]"
      >
        {label}
      </label>
      {children}
      {hint ? (
        <p className="text-[11px] text-[var(--text-tertiary)]">{hint}</p>
      ) : null}
    </div>
  );
}
