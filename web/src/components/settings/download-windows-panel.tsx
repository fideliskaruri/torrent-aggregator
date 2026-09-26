import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DAY_LABELS,
  MAX_DOWNLOAD_WINDOWS,
  MAX_WINDOW_ACTIVE,
  describeWindow,
  formatHour,
  newWindowDraft,
  validateDraft,
  type DownloadWindowDraft,
} from "@/lib/download-windows";
import { cn } from "@/lib/utils";

interface DownloadWindowsPanelProps {
  windows: DownloadWindowDraft[];
  onChange: (windows: DownloadWindowDraft[]) => void;
  /** Server's view of "now" for the saved schedule; null while unknown. */
  open: boolean | null;
}

const SELECT_CLASS =
  "h-11 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-base text-[var(--text)] focus-visible:border-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-dim)] sm:text-sm";

const START_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const END_HOURS = Array.from({ length: 24 }, (_, index) => index + 1);

export function DownloadWindowsPanel({ windows, onChange, open }: DownloadWindowsPanelProps) {
  const update = (index: number, patch: Partial<DownloadWindowDraft>) =>
    onChange(windows.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  const toggleDay = (index: number, day: number) => {
    const days = windows[index].days;
    update(index, {
      days: days.includes(day) ? days.filter((d) => d !== day) : [...days, day],
    });
  };

  return (
    <div className="space-y-3" data-download-windows>
      <div className="space-y-1">
        <p className="text-xs font-medium text-[var(--text-secondary)]">Download hours</p>
        <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
          {windows.length
            ? "New downloads only start inside these hours (this computer's time). Running downloads keep going, and Resume or Download now always starts one right away."
            : "Downloads can start at any time. Add hours to only start new downloads at night or on weekends."}
        </p>
        {windows.length && open != null ? (
          <p
            className={cn(
              "text-xs font-medium",
              open ? "text-[var(--success)]" : "text-[var(--accent-text)]",
            )}
            data-download-window-status={open ? "open" : "closed"}
          >
            {open ? "Open now — new downloads can start" : "Closed now — new downloads wait"}
          </p>
        ) : null}
      </div>

      {windows.map((window, index) => {
        const problem = validateDraft(window);
        const idPrefix = `download-window-${index}`;
        return (
          <fieldset
            key={index}
            className="space-y-3 rounded-lg border border-[var(--border)] p-3"
            data-download-window={index}
          >
            <legend className="sr-only">Download hours rule {index + 1}</legend>
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 pt-2 text-sm font-medium text-[var(--text)]" data-download-window-summary>
                {describeWindow(window)}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove download hours rule ${index + 1}`}
                onClick={() => onChange(windows.filter((_, i) => i !== index))}
                data-download-window-remove
              >
                <Trash2 />
              </Button>
            </div>

            <div role="group" aria-label="Days" className="grid grid-cols-7 gap-1">
              {DAY_LABELS.map((day) => {
                const on = window.days.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    aria-pressed={on}
                    aria-label={day.long}
                    onClick={() => toggleDay(index, day.value)}
                    className={cn(
                      "min-h-[44px] rounded-md border text-xs font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                      on
                        ? "border-[var(--primary)] bg-[var(--accent-dim)] text-[var(--text)]"
                        : "border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--bg-muted)]",
                    )}
                    data-download-window-day={day.value}
                  >
                    {day.short}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor={`${idPrefix}-start`} className="text-xs font-medium text-[var(--text-secondary)]">
                  From
                </label>
                <select
                  id={`${idPrefix}-start`}
                  value={window.startHour}
                  onChange={(event) => update(index, { startHour: Number(event.target.value) })}
                  className={SELECT_CLASS}
                  data-download-window-start
                >
                  {START_HOURS.map((hour) => (
                    <option key={hour} value={hour}>
                      {formatHour(hour)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${idPrefix}-end`} className="text-xs font-medium text-[var(--text-secondary)]">
                  Until
                </label>
                <select
                  id={`${idPrefix}-end`}
                  value={window.endHour}
                  onChange={(event) => update(index, { endHour: Number(event.target.value) })}
                  className={SELECT_CLASS}
                  data-download-window-end
                >
                  {END_HOURS.map((hour) => (
                    <option key={hour} value={hour}>
                      {hour === 24 ? "24:00 (midnight)" : formatHour(hour)}
                      {hour <= window.startHour ? " next day" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <label htmlFor={`${idPrefix}-active`} className="text-xs font-medium text-[var(--text-secondary)]">
                  Downloads at once
                </label>
                <Input
                  id={`${idPrefix}-active`}
                  type="number"
                  min={1}
                  max={MAX_WINDOW_ACTIVE}
                  step={1}
                  inputMode="numeric"
                  placeholder="Usual"
                  value={window.maxActiveDownloads}
                  onChange={(event) => update(index, { maxActiveDownloads: event.target.value })}
                  className="h-11 text-base sm:text-sm"
                  data-download-window-active
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${idPrefix}-down`} className="text-xs font-medium text-[var(--text-secondary)]">
                  Download limit (MB/s)
                </label>
                <Input
                  id={`${idPrefix}-down`}
                  type="number"
                  min={0.01}
                  step="any"
                  inputMode="decimal"
                  placeholder="No limit"
                  value={window.maxDownloadMbps}
                  onChange={(event) => update(index, { maxDownloadMbps: event.target.value })}
                  className="h-11 text-base sm:text-sm"
                  data-download-window-down
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${idPrefix}-up`} className="text-xs font-medium text-[var(--text-secondary)]">
                  Upload limit (MB/s)
                </label>
                <Input
                  id={`${idPrefix}-up`}
                  type="number"
                  min={0.01}
                  step="any"
                  inputMode="decimal"
                  placeholder="No limit"
                  value={window.maxUploadMbps}
                  onChange={(event) => update(index, { maxUploadMbps: event.target.value })}
                  className="h-11 text-base sm:text-sm"
                  data-download-window-up
                />
              </div>
            </div>

            {problem ? (
              <p role="alert" className="text-xs text-[var(--destructive)]" data-download-window-error>
                Fix this rule: {problem}.
              </p>
            ) : null}
          </fieldset>
        );
      })}

      {windows.length < MAX_DOWNLOAD_WINDOWS ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange([...windows, newWindowDraft()])}
          data-download-window-add
        >
          <Plus />
          {windows.length ? "Add more hours" : "Add download hours"}
        </Button>
      ) : null}
    </div>
  );
}
