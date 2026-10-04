import { Suspense } from "react";
import { useSearchParams } from "react-router";
import { ActivityColumn } from "@/components/notifications/activity-view-toggle";
import { ActivityContent } from "./activity-content";
import { ActivitySkeleton } from "./activity-skeleton";

export function NotificationsView({ sentOnly: sentOnlyOverride }: { sentOnly?: boolean }) {
  const [searchParams] = useSearchParams();
  const sentOnly = sentOnlyOverride ?? searchParams.get("filter") === "sent";
  return (
    <ActivityColumn view={sentOnly ? "log" : "inbox"}>
      <Suspense fallback={<ActivitySkeleton />}>
        <ActivityContent sentOnly={sentOnly} />
      </Suspense>
    </ActivityColumn>
  );
}
