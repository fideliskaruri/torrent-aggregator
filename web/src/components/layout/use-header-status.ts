import { pendingBadge } from "@/lib/requests";
import { useSessionInfo } from "@/lib/session";

export function useHeaderStatus(canReviewRequests: boolean) {
  const { pendingRequests, via, email } = useSessionInfo();
  return {
    email,
    showAccount: via === "tunnel" && Boolean(email),
    requestsBadge: canReviewRequests ? pendingBadge(pendingRequests) : null,
  };
}
