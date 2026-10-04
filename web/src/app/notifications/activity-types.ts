export interface ActivityItem {
  id: string;
  type: "grab" | "history";
  title: string;
  status: string;
  message: string | null;
  kind: string | null;
  magnet: string | null;
  category: string | null;
  createdAt: string;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
  hasMore: boolean;
}
