import type { ReactNode } from "react";
import { ArrowDownUp, Search } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DOWNLOAD_TABS,
  DOWNLOAD_TAB_LABELS,
} from "./media-filter";
import {
  DOWNLOAD_SORT_LABELS,
  DOWNLOAD_SORTS,
  downloadSortShortLabel,
} from "./sort";
import type { DownloadSort } from "./sort";
import type { StatusFilter } from "./use-downloads-page-state";
import type { useDownloadsPage } from "./use-downloads-page";

type Model = ReturnType<typeof useDownloadsPage>;

export function DownloadFilters({ page, children }: { page: Model; children: ReactNode }) {
  const statusChips: { id: StatusFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "downloading", label: "Downloading" },
    ...(page.stats.queued > 0 || page.statusFilter === "queued" ? [{ id: "queued" as const, label: "Queued" }] : []),
    { id: "ready", label: "Ready" },
    { id: "paused", label: "Paused" },
    ...(page.stats.error > 0 || page.statusFilter === "attention" ? [{ id: "attention" as const, label: "Needs attention" }] : []),
  ];
  return (
    <Tabs value={page.mediaTab} onValueChange={(value) => page.setMediaTab(value as typeof page.mediaTab)}
      className="min-w-0 gap-4">
      <ScrollArea className="min-w-0">
        <TabsList aria-label="Media type" className="group-data-horizontal/tabs:h-auto" data-media-tabs>
          {DOWNLOAD_TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab} data-media-tab={tab}
              className="h-8 flex-none px-3 text-[13px] max-md:h-11 pointer-coarse:h-11">
              {DOWNLOAD_TAB_LABELS[tab]}
            </TabsTrigger>
          ))}
        </TabsList>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <TabsContent value={page.mediaTab} className="min-w-0 space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2 sm:max-w-md sm:flex-1">
            <InputGroup className="h-auto min-w-0 flex-1">
              <InputGroupAddon><Search aria-hidden className="size-3.5" /></InputGroupAddon>
              <InputGroupInput value={page.filter} onChange={(event) => page.setFilter(event.target.value)}
                placeholder="Filter torrents…" aria-label="Filter downloads" data-client-filter />
            </InputGroup>
            <Select value={page.sort} onValueChange={(value) => page.setSort(value as DownloadSort)}>
              <SelectTrigger size="sm" aria-label="Sort downloads" title="Sort"
                className="shrink-0 text-[13px]" data-downloads-sort>
                <ArrowDownUp aria-hidden className="size-3.5 text-muted-foreground" />
                <SelectValue>{downloadSortShortLabel(page.sort)}</SelectValue>
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {DOWNLOAD_SORTS.map((option) => (
                  <SelectItem key={option} value={option} className="min-h-11 sm:min-h-0"
                    data-downloads-sort-option={option}>{DOWNLOAD_SORT_LABELS[option]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ScrollArea className="min-w-0 sm:shrink-0">
            <ToggleGroup type="single" value={page.statusFilter}
              onValueChange={(value) => { if (value) page.setStatusFilter(value as StatusFilter); }}
              aria-label="Status" spacing={1} className="flex-nowrap" data-status-filters>
              {statusChips.map((chip) => (
                <ToggleGroupItem key={chip.id} value={chip.id} size="sm" data-status-filter={chip.id}
                  className="px-2.5 text-xs text-subtle-foreground hover:text-muted-foreground data-[state=on]:text-foreground max-md:h-11 max-md:min-w-11 pointer-coarse:h-11 pointer-coarse:min-w-11">
                  {chip.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>
        {children}
      </TabsContent>
    </Tabs>
  );
}
