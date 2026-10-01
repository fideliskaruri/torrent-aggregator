/**
 * A release's languages in plain words, shared by every release card and the
 * Find another source dialog's current release. The server judges the fit
 * against the owner's audio language setting; this only shows it.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type LanguageFit = "preferred" | "neutral" | "backup" | "clash";

export interface ReleaseLanguageInfo {
  /** Display names, e.g. ["Japanese"]. */
  audio: string[];
  subtitles: string[];
  subtitleState: "known_english" | "known_non_english" | "unknown" | "mixed";
  fit: LanguageFit;
  /** Where the languages were read. */
  basis: "name" | "category" | "files" | "header" | "group" | "none";
  confidence: "high" | "medium" | "low";
  /** One plain line, e.g. "Japanese audio, English subtitles" or "Language not stated". */
  label: string;
}

const FIT_BADGES: Record<LanguageFit, { label: string; variant: "success" | "default" | "danger" } | null> = {
  preferred: { label: "Preferred", variant: "success" },
  neutral: null,
  backup: { label: "Backup", variant: "default" },
  clash: { label: "Other language", variant: "danger" },
};

const BASIS_WORDS: Record<ReleaseLanguageInfo["basis"], string | null> = {
  name: "From the release name",
  category: "From the site's category",
  files: "From the file list",
  header: "Checked in the video",
  group: "From the release group",
  none: null,
};

const CONFIDENCE_WORDS: Record<ReleaseLanguageInfo["confidence"], string> = {
  high: "high confidence",
  medium: "medium confidence",
  low: "low confidence",
};

/** Where the languages were read, in plain words: "From the release name, medium confidence". */
export function languageBasisText(info: Pick<ReleaseLanguageInfo, "basis" | "confidence">): string | null {
  const basis = BASIS_WORDS[info.basis] ?? null;
  if (!basis) return null;
  const confidence = CONFIDENCE_WORDS[info.confidence];
  return confidence ? `${basis}, ${confidence}` : basis;
}

/** The language line with its fit badge; nothing when the server sent no languages. */
export function ReleaseLanguages({
  info,
  className,
}: {
  info: ReleaseLanguageInfo | null | undefined;
  className?: string;
}) {
  if (!info) return null;
  const label = info.label?.trim();
  const badge = FIT_BADGES[info.fit] ?? null;
  if (!label && !badge) return null;
  const basis = languageBasisText(info);
  return (
    <p
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-muted-foreground", className)}
      title={basis ?? undefined}
      data-release-languages
      data-language-fit={info.fit}
    >
      {label ? <span className="min-w-0 break-words">{label}</span> : null}
      {basis ? <span className="sr-only">{`(${basis})`}</span> : null}
      {badge ? (
        <Badge variant={badge.variant} data-language-fit-badge>
          {badge.label}
        </Badge>
      ) : null}
    </p>
  );
}
