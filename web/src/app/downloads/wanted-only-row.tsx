import { Link } from "react-router";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TfWorkThumb } from "@/components/tf/work-thumb";
import { openReleasePicker } from "@/components/releases/release-picker-store";
import { titlePath } from "@/components/title/work-key";
import { wantedSubtitle, wantedTooltip, type WantedTitle } from "./wanted-groups";
import { SearchingBadge } from "./searching-badge";
import { WantedMenuActions } from "./wanted-menu-actions";
import type { useDownloads } from "./use-downloads";

type WantedState = ReturnType<typeof useDownloads>["wanted"];

export function WantedOnlyRow({ title, wanted }: { title: WantedTitle; wanted: WantedState }) {
  const primary = title.groups[0];
  const href = titlePath(title.workKey, {
    title: title.title,
    year: title.year,
    mediaType: title.mediaType,
    season: primary.season,
  });
  const subtitle = wantedSubtitle(title);
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 px-3 py-2.5 transition-colors hover:bg-muted/60 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-3"
      data-wanted-only-row={title.workKey}>
      <span aria-hidden className="size-4 shrink-0" />
      <div className="flex min-w-0 items-center gap-2.5">
        <Link to={href} tabIndex={-1} aria-hidden className="shrink-0">
          <TfWorkThumb title={title.title} sizePx={40} />
        </Link>
        <div className="min-w-0 flex-1 space-y-1">
          <Link to={href} className="block min-h-11 truncate rounded-sm text-[13px] font-medium leading-snug outline-none hover:text-brand-foreground focus-visible:ring-2 focus-visible:ring-ring lg:min-h-0"
            data-wanted-title>
            {title.title}
          </Link>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {subtitle ? <p className="text-[12px] text-muted-foreground" data-wanted-subtitle>{subtitle}</p> : null}
            <SearchingBadge groups={title.groups} />
          </div>
          <span className="sr-only">{wantedTooltip(title.groups)}</span>
        </div>
      </div>
      <div className="col-start-2 flex items-center justify-end gap-2 sm:col-start-auto">
        <Button type="button" variant="secondary" size="sm" className="max-md:min-h-11"
          onClick={() => openReleasePicker({
            workKey: primary.workKey,
            title: primary.name,
            season: primary.season,
            episode: primary.episode,
            onPicked: () => void wanted.reload(),
          })}
          aria-label={`Pick a release for ${title.title}`} data-wanted-pick>
          <Search className="size-3.5" />
          Pick a release
        </Button>
        <WantedMenuActions groups={title.groups} includePick={false}
          onChanged={wanted.reload} setRows={wanted.setRows}
          label={`More actions for ${title.title}`} triggerProps={{ "data-wanted-more": "" }} />
      </div>
    </div>
  );
}
