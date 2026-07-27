export interface HistoryFacts {
  message: string | null;
  context: string | null;
  category: string | null;
  savePath: string | null;
  clientType: string | null;
  sendKind: string | null;
}

export interface HistoryFactRow {
  message?: string | null;
  context?: string | null;
  category?: string | null;
  savePath?: string | null;
  clientType?: string | null;
  sendKind?: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function historyMessageFromFacts(facts: HistoryFactRow): string | null {
  return clean(facts.message);
}

export function parseHistoryFacts(row: HistoryFactRow): HistoryFacts {
  const facts: HistoryFacts = {
    message: clean(row.message),
    context: clean(row.context),
    category: clean(row.category),
    savePath: clean(row.savePath),
    clientType: clean(row.clientType),
    sendKind: clean(row.sendKind),
  };

  const parts = (row.message ?? "")
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.some((part) => /^[a-z]+=/i.test(part))) return facts;

  const prose: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      prose.push(part);
      continue;
    }
    const key = part.slice(0, eq).toLowerCase();
    const value = clean(part.slice(eq + 1));
    if (!value) continue;
    if (key === "cat" && !facts.category) facts.category = value;
    else if (key === "path" && !facts.savePath) facts.savePath = value;
    else if (key === "via" && !facts.clientType) facts.clientType = value;
    else if (key === "kind" && !facts.sendKind) facts.sendKind = value;
    else prose.push(part);
  }

  const legacyContext =
    /^(On-demand|Library automation|Auto-rule|Title page|Pre-warm)\b/.test(
      prose[0] ?? "",
    );
  if (prose.length > 1 && !facts.context && legacyContext) {
    facts.context = prose[0];
    facts.message = prose.slice(1).join(" · ");
  } else {
    facts.message = prose.join(" · ") || null;
  }

  return facts;
}

function pathParts(savePath: string): string[] {
  return savePath
    .replaceAll("/", "\\")
    .split("\\")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function formatSaveLocation(
  savePath: string | null | undefined,
  category?: string | null,
): string | null {
  const raw = clean(savePath);
  if (!raw) return null;

  const parts = pathParts(raw);
  const lower = parts.map((part) => part.toLowerCase());
  const categoryIndex = category
    ? lower.lastIndexOf(category.toLowerCase())
    : -1;
  if (categoryIndex >= 0) return parts.slice(categoryIndex).join("\\");

  const downloadsIndex = lower.lastIndexOf("downloads");
  if (downloadsIndex >= 0 && downloadsIndex < parts.length - 1) {
    return parts.slice(downloadsIndex + 1).join("\\");
  }

  const leechIndex = lower.lastIndexOf("leech");
  if (leechIndex >= 0 && leechIndex < parts.length - 1) {
    return parts.slice(leechIndex + 1).join("\\");
  }

  return parts.slice(-Math.min(3, parts.length)).join("\\");
}
