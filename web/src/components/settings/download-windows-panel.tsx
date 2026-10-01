import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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


const START_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const END_HOURS = Array.from({ length: 24 }, (_, index) => index + 1);

export function DownloadWindowsPanel({ windows, onChange, open }: DownloadWindowsPanelProps) {
  const update = (index: number, patch: Partial<DownloadWindowDraft>) =>
    onChange(windows.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  // Apply only the toggled day so the saved day order matches click order.
  const setDays = (index: number, next: string[]) => {
    const days = windows[index].days;
    const picked = next.map(Number);
    const added = picked.filter((d) => !days.includes(d));
    update(index, {
      days: [...days.filter((d) => picked.includes(d)), ...added],
    });
  };

  return (
    <div className="space-y-3" data-download-windows>
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Download hours</p>
        <p className="text-xs leading-relaxed text-subtle-foreground">
          {windows.length
            ? "New downloads only start inside these hours (this computer's time). Running downloads keep going, and Download now always starts one right away."
            : "Downloads can start at any time. Add hours to only start new downloads at night or on weekends."}
        </p>
        {windows.length && open != null ? (
          <p
            className={cn(
              "text-xs font-medium",
              open ? "text-success" : "text-brand-foreground",
            )}
            data-download-window-status={open ? "open" : "closed"}
          >
            {open ? "Open now, new downloads can start" : "Closed now, new downloads wait"}
          </p>
        ) : null}
      </div>

      {windows.map((window, index) => {
        const problem = validateDraft(window);
        const idPrefix = `download-window-${index}`;
        return (
          <fieldset
            key={index}
            className="space-y-3 rounded-lg border border-border p-3"
            data-download-window={index}
          >
            <legend className="sr-only">Download hours rule {index + 1}</legend>
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 pt-2 text-sm font-medium text-foreground" data-download-window-summary>
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

            <ToggleGroup
              type="multiple"
              variant="outline"
              spacing={1}
              aria-label="Days"
              value={window.days.map(String)}
              onValueChange={(next) => setDays(index, next)}
              className="grid w-full grid-cols-7"
            >
              {DAY_LABELS.map((day) => (
                <ToggleGroupItem
                  key={day.value}
                  value={String(day.value)}
                  aria-label={day.long}
                  className="w-full rounded-md max-md:min-h-11 pointer-coarse:min-h-11 text-xs text-subtle-foreground data-[state=on]:border-primary data-[state=on]:bg-brand-dim data-[state=on]:text-foreground motion-reduce:transition-none"
                  data-download-window-day={day.value}
                >
                  {day.short}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="From" htmlFor={`${idPrefix}-start`}>
                <Select
                  value={String(window.startHour)}
                  onValueChange={(value) => update(index, { startHour: Number(value) })}
                >
                  <SelectTrigger id={`${idPrefix}-start`} className="w-full" data-download-window-start>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {START_HOURS.map((hour) => (
                      <SelectItem key={hour} value={String(hour)}>
                        {formatHour(hour)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Until" htmlFor={`${idPrefix}-end`}>
                <Select
                  value={String(window.endHour)}
                  onValueChange={(value) => update(index, { endHour: Number(value) })}
                >
                  <SelectTrigger id={`${idPrefix}-end`} className="w-full" data-download-window-end>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {END_HOURS.map((hour) => (
                      <SelectItem key={hour} value={String(hour)}>
                        {hour === 24 ? "24:00 (midnight)" : formatHour(hour)}
                        {hour <= window.startHour ? " next day" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField label="Downloads at once" htmlFor={`${idPrefix}-active`}>
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
                  className="text-base sm:text-sm"
                  data-download-window-active
                />
              </FormField>
              <FormField label="Download limit (MB/s)" htmlFor={`${idPrefix}-down`}>
                <Input
                  id={`${idPrefix}-down`}
                  type="number"
                  min={0.01}
                  step="any"
                  inputMode="decimal"
                  placeholder="No limit"
                  value={window.maxDownloadMbps}
                  onChange={(event) => update(index, { maxDownloadMbps: event.target.value })}
                  className="text-base sm:text-sm"
                  data-download-window-down
                />
              </FormField>
              <FormField label="Upload limit (MB/s)" htmlFor={`${idPrefix}-up`}>
                <Input
                  id={`${idPrefix}-up`}
                  type="number"
                  min={0.01}
                  step="any"
                  inputMode="decimal"
                  placeholder="No limit"
                  value={window.maxUploadMbps}
                  onChange={(event) => update(index, { maxUploadMbps: event.target.value })}
                  className="text-base sm:text-sm"
                  data-download-window-up
                />
              </FormField>
            </div>
            {problem ? (
              <p role="alert" className="text-xs text-destructive" data-download-window-error>
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
