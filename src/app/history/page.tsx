import { redirect } from "next/navigation";

export default function HistoryPage() {
  redirect("/activity?filter=sent");
}
