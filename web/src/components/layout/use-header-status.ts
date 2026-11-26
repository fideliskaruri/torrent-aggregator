import { useSessionInfo } from "@/lib/session";

export function useHeaderStatus(_canReviewRequests: boolean) {
  const { via, email } = useSessionInfo();
  return {
    email,
    showAccount: via === "tunnel" && Boolean(email),
    requestsBadge: null,
  };
}
