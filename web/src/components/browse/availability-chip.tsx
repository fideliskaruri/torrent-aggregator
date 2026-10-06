import { AlertCircle, Check, Download, Zap } from "lucide-react";
import type { AvailabilityState } from "@/lib/browse";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
type Unresolved = null;
type AvailabilityTone = "success" | "accent" | "secondary" | "tertiary" | "info";
type AvailabilityMeta = { label: string; tone: AvailabilityTone; description: string | null };

function assertNever(value: never): never {
  throw new Error(`Unhandled availability state: ${String(value)}`);
}

function availabilityMeta(state: AvailabilityState | Unresolved): AvailabilityMeta {
  if (state === null) return { label: "Not checked", tone: "info", description: null };
  switch (state) {
    case "ready":
      return { label: "Ready", tone: "success", description: "Downloaded in full." };
    case "warm":
      return {
        label: "Partial",
        tone: "accent",
        description: "Partly downloaded. The rest is on its way.",
      };
    case "fetchable":
      return {
        label: "Can get",
        tone: "secondary",
        description: "Not on disk yet, but a viable source exists.",
      };
    case "unavailable":
      return {
        label: "Unavailable",
        tone: "tertiary",
        description: "Searched, and nothing viable came back.",
      };
    default:
      return assertNever(state);
  }
}

/**
 * The state of a title, in one word and a glyph.
 *
 * Colour is a reinforcement, never the message: the chip always carries the
 * word *and* a shape, so it reads the same to a colour-blind user, in a
 * screenshot, and through a screen reader. Backgrounds are mixed from the theme
 * tokens rather than eyeballed, and stay opaque because a chip sits on top of
 * poster art of unknown brightness.
 *
 * Both maps below are keyed by a whole union, so a state added upstream is a
 * compile error here rather than a chip that silently renders blank.
 */
const TONE_VARIANT: Record<
  AvailabilityTone,
  "success" | "accent" | "info" | "outline" | "default"
> = {
  success: "success",
  accent: "accent",
  info: "info",
  secondary: "outline",
  tertiary: "default",
};

// Chips sit on poster art of unknown brightness, so the tinted variants get an
// opaque card underneath instead of the page showing through.
const TONE_CLASS: Record<AvailabilityTone, string> = {
  success: "[background:color-mix(in_srgb,var(--success)_16%,var(--card))]",
  accent: "[background:color-mix(in_srgb,var(--brand)_18%,var(--card))]",
  info: "[background:color-mix(in_srgb,var(--info)_14%,var(--card))]",
  secondary: "border-input bg-card text-muted-foreground",
  tertiary: "bg-card text-subtle-foreground",
};

const STATE_ICON: Record<AvailabilityState, typeof Check> = {
  ready: Check,
  warm: Zap,
  fetchable: Download,
  unavailable: AlertCircle,
};

export function AvailabilityChip({
  state,
  className,
  compact = false,
  ...data
}: {
  /** `null` is the unresolved answer, not missing data. */
  state: AvailabilityState | Unresolved;
  className?: string;
  /** Icon-first, tighter padding — for the corner of a poster. */
  compact?: boolean;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const meta = availabilityMeta(state);

  // "Can get" is not a state worth a chip. It only says a viable release
  // exists — which the Download action right next to it already offers —
  // so as a badge it is the app narrating its own plumbing. The title hero
  // suppresses it for this exact reason; doing it here at the shared seam means
  // the word never appears on rail cards, episode rows, or the browse hero
  // either. The meaningful states (Ready, Partial, Unavailable) still render.
  if (state === "fetchable") return null;

  // "Nobody checked yet" is a normal, expected answer — not a warning — and it
  // was true of nearly every card, so a blue "Not checked" pill was pure noise.
  // Render it as a faint dot: present enough to mark the unknown, quiet enough
  // to disappear next to a real Ready / Unavailable badge. The word still
  // reaches assistive tech and the hover title.
  if (state === null) {
    return (
      <span
        data-availability="unresolved"
        title={meta.label}
        className={cn(
          "inline-flex items-center justify-center",
          compact ? "h-4 w-4" : "h-5 w-5",
          className,
        )}
      >
        <span
          className="size-1.5 rounded-full bg-subtle-foreground opacity-60"
          aria-hidden
        />
        <span className="sr-only">{meta.label}</span>
      </span>
    );
  }

  const Icon = STATE_ICON[state];

  return (
    <Badge
      {...data}
      variant={TONE_VARIANT[meta.tone]}
      data-availability={state ?? "unresolved"}
      title={meta.description ?? undefined}
      className={cn(
        "justify-start py-1 leading-none",
        compact ? "text-[11px]" : "px-2 text-xs",
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" strokeWidth={2.25} aria-hidden />
      <span className="truncate">{meta.label}</span>
      {/* No sentence means no node: an empty ` — ` reads aloud as a dangling
          dash, and a `title` of "" is a tooltip that flashes and says nothing. */}
      {meta.description ? (
        <span className="sr-only">. {meta.description}</span>
      ) : null}
    </Badge>
  );
}
