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
      data-page-header
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4",
        className,
      )}
    >
      <div className="min-w-0 w-full flex-1 space-y-1">
        <h1 className="font-heading text-balance text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          {title}
        </h1>
        {description ? (
          <div className="max-w-prose whitespace-normal break-words text-[13px] leading-relaxed text-subtle-foreground">
            {description}
          </div>
        ) : null}
        {meta ? <div className="pt-1">{meta}</div> : null}
      </div>
      {actions ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
