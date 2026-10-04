import { Search, X } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SEARCH_SCOPES } from "@/lib/torrents/search-scopes";
import { placeholderFor } from "./search-overlay-state";
import type { SearchOverlayController } from "./use-search-overlay-controller";
import type { TitleSearchState } from "./use-title-search";

export function SearchOverlayControls({
  controller,
  search,
}: {
  controller: SearchOverlayController;
  search: TitleSearchState;
}) {
  return (
    <div className="shrink-0 space-y-2.5 border-b border-border p-3">
      <InputGroup role="search" className="h-11 bg-background">
        <InputGroupAddon>
          <Search className="text-subtle-foreground" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={controller.inputRef}
          type="search"
          data-search-input="true"
          data-search-overlay-input="true"
          value={search.query}
          onChange={(event) => search.onQueryChange(event.target.value)}
          onKeyDown={controller.onInputKeyDown}
          placeholder={placeholderFor(search.scopeId)}
          aria-label="Search"
          autoComplete="off"
          spellCheck={false}
          className="h-full text-base [&::-webkit-search-cancel-button]:appearance-none"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            onClick={controller.close}
            aria-label="Close search"
            className="size-9 text-subtle-foreground hover:text-foreground max-md:size-11 pointer-coarse:size-11"
          >
            <X aria-hidden />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <ScrollArea className="-mx-3 sm:mx-0">
        <TabsList
          aria-label="Search category"
          className="mx-3 group-data-horizontal/tabs:h-auto sm:mx-0"
        >
          {SEARCH_SCOPES.map((scope) => (
            <TabsTrigger
              key={scope.id}
              value={scope.id}
              title={scope.blurb}
              data-search-scope={scope.id}
              onKeyDown={controller.onScopeKeyDown}
              className="h-8 flex-none px-3 text-[13px] max-md:h-11 pointer-coarse:h-11"
            >
              {scope.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
