import { Bell } from "lucide-react";
import { Link, useLocation } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useUnreadNotifications } from "@/app/notifications/use-unread";
import { cn } from "@/lib/utils";

export function NotificationBell() {
  const { count, badge } = useUnreadNotifications();
  const pathname = useLocation().pathname;
  const active = ["/notifications", "/activity", "/history"].some((href) => pathname === href || pathname.startsWith(`${href}/`));
  return (
    <Button asChild variant="ghost"
      className={cn("relative hidden md:inline-flex h-9 min-w-9 pointer-coarse:h-11 pointer-coarse:min-w-11 shrink-0", badge ? "gap-0.5 pl-2 pr-1.5" : "w-9 pointer-coarse:w-11 px-0",
        active ? "bg-muted text-foreground" : "text-muted-foreground")}>
      <Link to="/notifications" aria-label={`Notifications${count ? `, ${count} unread` : ""}`}
        aria-current={active ? "page" : undefined}
        data-notification-bell>
        <Bell className="size-5" aria-hidden />
        {/* Phones carry the count on the Alerts tab, so the bell is desktop only.
            In flow beside the bell, raised like a superscript: hung off the
            corner it lost its top half to the header and covered the glyph. */}
        {badge && <Badge variant="solid" data-notification-badge aria-hidden
          className="-mt-4 h-[18px] min-h-[18px] min-w-[18px] rounded-full px-1 text-[12px] font-semibold leading-[18px] tabular-nums">{badge}</Badge>}
      </Link>
    </Button>
  );
}
