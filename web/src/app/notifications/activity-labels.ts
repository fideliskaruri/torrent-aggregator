export function statusVariant(
  status: string,
): "success" | "danger" | "secondary" | "accent" | "default" {
  switch (status) {
    case "sent": return "success";
    case "failed": return "danger";
    case "skipped": return "secondary";
    case "searching":
    case "queued": return "accent";
    default: return "default";
  }
}

const STATUS_LABELS: Record<string, string> = {
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
  searching: "Searching",
  queued: "Waiting",
  downloaded: "Downloaded",
  completed: "Finished",
  complete: "Finished",
  info: "Info",
};

export function statusLabel(status: string): string {
  const known = STATUS_LABELS[status];
  if (known) return known;
  const words = status.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Update";
}
