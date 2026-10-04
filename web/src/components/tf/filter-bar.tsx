import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type FilterField<T> = {
  key: keyof T;
  label: string;
  kind: "search" | "select" | "toggle";
  options?: readonly { value: string; label: string }[];
};

export type FilterBarState = {
  activeCount: number;
  clearFilters: () => void;
};

export function FilterBar<T>({
  fields,
  onPredicateChange,
  children,
}: {
  fields: readonly FilterField<T>[];
  onPredicateChange: (predicate: (item: T) => boolean) => void;
  children: (state: FilterBarState) => ReactNode;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const predicate = useMemo(() => (item: T) => fields.every((field) => {
    const value = values[String(field.key)];
    if (field.kind === "search") {
      const needle = String(value ?? "").trim().toLocaleLowerCase();
      return !needle || String(item[field.key] ?? "").toLocaleLowerCase().includes(needle);
    }
    if (field.kind === "select") return !value || item[field.key] === value;
    return !value || Boolean(item[field.key]);
  }), [fields, values]);
  const activeCount = Object.values(values).filter((value) => value !== "" && value !== false && value != null).length;
  const clearFilters = () => setValues({});

  useEffect(() => onPredicateChange(predicate), [onPredicateChange, predicate]);

  const controls = fields.map((field) => {
    const name = String(field.key);
    if (field.kind === "search") {
      return (
        <label key={name} className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
          <span>{field.label}</span>
          <Input value={String(values[name] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} />
        </label>
      );
    }
    if (field.kind === "select") {
      return (
        <label key={name} className="min-w-0 space-y-1 text-xs text-muted-foreground">
          <span>{field.label}</span>
          <select value={String(values[name] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground">
            <option value="">All</option>
            {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      );
    }
    return (
      <label key={name} className="flex min-h-10 items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={Boolean(values[name])} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.checked }))} />
        {field.label}
      </label>
    );
  });

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-end">
        {fields.some((field) => field.kind === "search") && controls.filter((_, index) => fields[index]?.kind === "search")}
        {fields.some((field) => field.kind !== "search") && (
          <>
            <Button type="button" variant="outline" className="min-h-10 sm:hidden" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
              <Filter aria-hidden className="size-4" /> Filters{activeCount ? ` (${activeCount})` : ""}
            </Button>
            <div className={`${filtersOpen ? "grid" : "hidden"} gap-3 sm:flex sm:items-end`}>
              {controls.filter((_, index) => fields[index]?.kind !== "search")}
            </div>
          </>
        )}
      </div>
      {children({ activeCount, clearFilters })}
    </div>
  );
}
