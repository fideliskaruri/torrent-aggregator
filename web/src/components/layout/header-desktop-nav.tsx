import { Link, useNavigate } from "react-router";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { NavPendingBadge } from "./nav-pending-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  navigationMenuTriggerStyle,
} from "@/components/ui/navigation-menu";
import { Separator } from "@/components/ui/separator";
import { type NavItem } from "@/lib/navigation";

export function HeaderDesktopNav({
  activeHref,
  dividerHref,
  fold,
  inlineItems,
  moreItems,
  navRef,
  requestsBadge,
  tightLinks,
}: {
  activeHref: string | null;
  dividerHref: string | null;
  fold: number;
  inlineItems: readonly NavItem[];
  moreItems: readonly NavItem[];
  navRef: React.RefObject<HTMLElement | null>;
  requestsBadge: string | null;
  tightLinks: boolean;
}) {
  const navigate = useNavigate();
  const moreActive = moreItems.some((item) => item.href === activeHref);

  return (
    <NavigationMenu
      ref={navRef}
      viewport={false}
      className="hidden md:flex flex-1 min-w-0 max-w-none justify-start overflow-hidden py-1.5 -my-1.5 px-0.5 -mx-0.5"
      data-desktop-nav
      data-header-fold={fold}
      aria-label="Main"
    >
      <NavigationMenuList className="flex-none justify-start gap-0.5">
        {inlineItems.map((item) => {
          const active = item.href === activeHref;
          return (
            <NavigationMenuItem key={item.href} className="flex items-center">
              {item.href === dividerHref ? (
                <Separator orientation="vertical" className="mx-1 data-vertical:h-4 data-vertical:self-center" />
              ) : null}
              <NavigationMenuLink asChild active={active}>
                <Link
                  to={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    navigationMenuTriggerStyle(),
                    "h-9 pointer-coarse:h-11 gap-1.5 whitespace-nowrap text-[13px]",
                    tightLinks ? "px-2" : "px-3",
                    active ? "bg-muted text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
                  )}
                >
                  {item.label}
                  {item.badge === "pending-requests" && requestsBadge ? (
                    <NavPendingBadge count={requestsBadge} data-nav-requests-pending />
                  ) : null}
                </Link>
              </NavigationMenuLink>
            </NavigationMenuItem>
          );
        })}
        {moreItems.length ? (
          <NavigationMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                data-header-more
                aria-current={moreActive ? "page" : undefined}
                className={cn(
                  navigationMenuTriggerStyle(),
                  "h-9 pointer-coarse:h-11 gap-1 px-2 text-[13px] whitespace-nowrap",
                  moreActive ? "bg-muted text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
                )}
              >
                More
                {requestsBadge && moreItems.some((item) => item.badge === "pending-requests") ? (
                  <NavPendingBadge count={requestsBadge} data-nav-more-pending />
                ) : null}
                <ChevronDown className="size-3.5" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {moreItems.map((item) => (
                  <DropdownMenuItem
                    key={item.href}
                    onSelect={() => navigate(item.href)}
                    className={cn("min-h-11", item.href === activeHref && "bg-muted text-foreground")}
                  >
                    {item.label}
                    {item.badge === "pending-requests" && requestsBadge ? (
                      <span className="ml-auto text-[12px] tabular-nums text-subtle-foreground">
                        {requestsBadge} pending
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </NavigationMenuItem>
        ) : null}
      </NavigationMenuList>
    </NavigationMenu>
  );
}
