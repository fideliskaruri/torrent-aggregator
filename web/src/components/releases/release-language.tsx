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
  /** The English rule (docs/release-language.md): automatic picks take pass, then unknown, never fail. */
  english?: "pass" | "unknown" | "fail";
  /** What decided it, e.g. "French subtitles only". */
  englishReason?: string | null;
  /** Facts read before the download: AnimeTosho's track lists or the site's file list. */
  hint?: "animetosho" | "filelist" | null;
}

/** "from AnimeTosho" or "from file list": where facts read before the download came from. */
const HINT_WORDS: Record<NonNullable<ReleaseLanguageInfo["hint"]>, string> = {
  animetosho: "from AnimeTosho",
  filelist: "from file list",
};

export function languageHintText(info: Pick<ReleaseLanguageInfo, "hint"> | null | undefined): string | null {
  return info?.hint ? (HINT_WORDS[info.hint] ?? null) : null;
}

/** A release with no English audio or subtitles: never picked or recommended automatically, only by hand. */
export function hasNoEnglish(info: ReleaseLanguageInfo | null | undefined): boolean {
  return info?.english === "fail";
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
  const noEnglish = hasNoEnglish(info);
  // No English outranks the fit: it is the one thing that stops an automatic pick.
  const badge = noEnglish ? { label: "No English", variant: "danger" as const } : (FIT_BADGES[info.fit] ?? null);
  if (!label && !badge) return null;
  const hint = languageHintText(info);
  const basis = [noEnglish && info.englishReason ? info.englishReason : null, hint ? null : languageBasisText(info)]
    .filter(Boolean)
    .join(". ") || null;
  return (
    <p
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-muted-foreground", className)}
      title={basis ?? undefined}
      data-release-languages
      data-language-fit={info.fit}
      data-english={info.english}

    >
      {label ? <span className="min-w-0 break-words">{label}</span> : null}
      {hint ? (
        <>
          <span aria-hidden>·</span>
          <span className="min-w-0 break-words" data-language-hint={info.hint ?? undefined}>
            {hint}
          </span>
        </>
      ) : null}
      {basis ? <span className="sr-only">{`(${basis})`}</span> : null}
      {badge ? (
        <Badge variant={badge.variant} data-language-fit-badge>
          {badge.label}
        </Badge>
      ) : null}
    </p>
  );
}
