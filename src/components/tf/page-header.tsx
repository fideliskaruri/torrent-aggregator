import { cn } from "@/lib/utils";

export function TfPageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-3 sm:gap-4",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-[var(--text)]">
          {title}
        </h1>
        {description ? (
          <div className="text-[13px] text-[var(--text-tertiary)]">
            {description}
          </div>
        ) : null}
        {meta ? <div className="pt-1">{meta}</div> : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
