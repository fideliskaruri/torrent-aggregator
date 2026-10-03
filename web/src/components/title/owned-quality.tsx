import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowUpCircle, Check, CheckCircle2, Loader2, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { qualityLabel } from "@/lib/torrents/quality";
import { cn } from "@/lib/utils";
import { ownedLabel } from "./owned-state";
import type { TitleBestAvailable, TitleOwned, TitleUpgradeOffer, TitleUpgradeQueued } from "./types";

/** Which owned item an action is about: the film, a season, or one episode. */
export interface OwnedScope {
  season?: number;
  episode?: number;
}

interface UpgradeReply {
  accepted?: boolean;
  queued?: number;
  message?: string;
}

/** "2 hours ago", "just now", "3 days ago". Null when the time is unreadable. */
export function checkedAgo(checkedAt: string, now: Date = new Date()): string | null {
  const then = new Date(checkedAt);
  if (Number.isNaN(then.getTime())) return null;
  const minutes = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "just now";
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
}

/** "480p is the best available, checked 2 hours ago". */
export function bestAvailableLabel(
  owned: TitleOwned | null | undefined,
  best: TitleBestAvailable,
): string {
  const quality = qualityLabel(best.resolution ?? owned?.resolution ?? null);
  const head = quality ? `${quality} is the best available` : "This is the best available";
  const ago = checkedAgo(best.checkedAt);
  return ago ? `${head}, checked ${ago}` : head;
}

/** "Upgrade to 1080p (4 seeders)". */
export function upgradeLabel(offer: TitleUpgradeOffer): string {
  const quality = qualityLabel(offer.resolution) ?? `${offer.resolution}p`;
  const seeders = `${offer.seeders} seeder${offer.seeders === 1 ? "" : "s"}`;
  return `Upgrade to ${quality} (${seeders})`;
}

/** "Upgrade to 1080p queued" while waiting, "Upgrading to 1080p" once the download runs. */
export function upgradeQueuedLabel(queued: TitleUpgradeQueued): string {
  const quality = qualityLabel(queued.resolution);
  if (queued.state === "fetching" || queued.state === "filing")
    return quality ? `Upgrading to ${quality}` : "Upgrading";
  if (queued.state === "paused") return quality ? `Upgrade to ${quality} paused` : "Upgrade paused";
  return quality ? `Upgrade to ${quality} queued` : "Upgrade queued";
}

/** The honest one-line result of an Upgrade reply. */
export function upgradeOutcome(reply: UpgradeReply | null, ok: boolean): { text: string; good: boolean } {
  if (!ok || !reply) return { text: "Upgrade did not go through. Try again.", good: false };
  if (reply.accepted && (reply.queued ?? 0) > 0) {
    const n = reply.queued ?? 0;
    return { text: n === 1 ? "Upgrade queued" : `${n} upgrades queued`, good: true };
  }
  if (reply.accepted) return { text: "Already queued", good: true };
  return { text: reply.message?.trim() || "No healthy upgrade is available. Check again.", good: false };
}

function scopeBody(scope: OwnedScope): string {
  const body: OwnedScope = {};
  if (scope.season != null) body.season = scope.season;
  if (scope.episode != null) body.episode = scope.episode;
  return JSON.stringify(body);
}

/**
 * Owner actions for an owned item's quality: Check again and Upgrade. Both post
 * to the title's owner-only endpoints and then ask the page to reload the title.
 */
export function useOwnedQualityActions(workKey: string, scope: OwnedScope, onChanged?: () => void) {
  const [pending, setPending] = useState<"check" | "upgrade" | null>(null);
  const [message, setMessage] = useState<{ text: string; good: boolean } | null>(null);
  const base = `/api/title/${encodeURIComponent(workKey)}`;

  async function post(path: string): Promise<{ ok: boolean; json: unknown }> {
    try {
      const res = await fetch(`${base}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: scopeBody(scope),
      });
      const json: unknown = await res.json().catch(() => null);
      return { ok: res.ok, json };
    } catch {
      return { ok: false, json: null };
    }
  }

  async function checkAgain(): Promise<{ text: string; good: boolean }> {
    setPending("check");
    setMessage(null);
    const { ok } = await post("check-again");
    setPending(null);
    const result = ok
      ? { text: "Checked just now", good: true }
      : { text: "The check did not finish. Try again.", good: false };
    if (!ok) setMessage(result);
    onChanged?.();
    return result;
  }

  async function upgrade(): Promise<{ text: string; good: boolean }> {
    setPending("upgrade");
    setMessage(null);
    const { ok, json } = await post("upgrade");
    setPending(null);
    const result = upgradeOutcome(json as UpgradeReply | null, ok);
    setMessage(result);
    onChanged?.();
    return result;
  }

  return { pending, message, checkAgain, upgrade };
}

function PendingBody({ pending, icon, children }: { pending: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <>
      <span className={cn("inline-flex items-center gap-1.5", pending && "invisible")}>
        {icon}
        {children}
      </span>
      {pending ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="animate-spin" aria-hidden />
        </span>
      ) : null}
    </>
  );
}

export interface OwnedQualityProps {
  workKey: string;
  /** Spoken name of the item, used in accessible labels ("Sintel", "S01E02"). */
  name: string;
  owned: TitleOwned;
  upgrade?: TitleUpgradeOffer | null;
  bestAvailable?: TitleBestAvailable | null;
  /** An accepted upgrade in flight. Shown instead of the Upgrade button. */
  upgradeQueued?: TitleUpgradeQueued | null;
  scope?: OwnedScope;
  /** Owner only. Requesters see what is owned and nothing to press. */
  canAct: boolean;
  onChanged?: () => void;
  /** `title`: the hero line under a film. `row`: the compact slot on an episode card. */
  variant: "title" | "row";
  /** Row variant: the card's shared action pill look, beside Download and Open alike. */
  pillClassName?: string;
  className?: string;
}

/**
 * The one owned/upgrade line for a film and an episode row alike:
 * "In your library, 480p" with Upgrade to 1080p (4 seeders), or
 * "480p is the best available, checked 2 hours ago" with Check again.
 * At or above the preferred quality the server sends neither, and the line
 * just says what you have.
 */
export function OwnedQuality({
  workKey,
  name,
  owned,
  upgrade,
  bestAvailable,
  upgradeQueued,
  scope = {},
  canAct,
  onChanged,
  variant,
  pillClassName,
  className,
}: OwnedQualityProps) {
  const actions = useOwnedQualityActions(workKey, scope, onChanged);
  const queued = upgradeQueued ?? null;
  const offer = queued ? null : upgrade ?? null;
  const best = offer || queued ? null : bestAvailable ?? null;
  const queuedText = queued ? upgradeQueuedLabel(queued) : null;
  const ownedText = ownedLabel(owned) ?? "In your library";
  const bestText = best ? bestAvailableLabel(owned, best) : null;
  const checking = actions.pending === "check";
  const upgrading = actions.pending === "upgrade";
  const state = queued ? "queued" : offer ? "upgrade" : best ? "best" : "owned";

  if (variant === "row") {
    const quality = qualityLabel(owned.resolution) ?? "In library";
    const notify = (result: { text: string; good: boolean }) => {
      if (result.good) toast.success(`${name}: ${result.text}`);
      else toast.error(`${name}: ${result.text}`);
    };
    return (
      <span className={cn("flex items-center gap-1.5", className)} data-owned-quality={state}>
        <Badge
          data-episode-owned
          aria-label={`${bestText ?? ownedText}, ${name}`}
          title={bestText ?? ownedText}
          className={cn(pillClassName, "border px-3 text-[13px] font-medium")}
        >
          <Check aria-hidden className="size-3.5 text-brand-foreground" />
          {quality}
        </Badge>
        {queued ? (
          <span
            data-owned-queued={queued.state}
            role="status"
            aria-label={`${queuedText}, ${name}`}
            title={queuedText ?? undefined}
            className={cn(pillClassName, "inline-flex items-center gap-1.5 border border-border px-3 text-[13px] text-foreground")}
          >
            <ArrowUpCircle aria-hidden className="size-3.5" />
            {qualityLabel(queued.resolution) ? `${qualityLabel(queued.resolution)} queued` : "Queued"}
          </span>
        ) : canAct && offer ? (
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            data-owned-upgrade
            aria-label={`${upgradeLabel(offer)}, ${name}`}
            title={upgradeLabel(offer)}
            aria-busy={upgrading || undefined}
            disabled={actions.pending !== null}
            onClick={(event) => {
              event.stopPropagation();
              void actions.upgrade().then(notify);
            }}
            className={cn(pillClassName, "relative w-auto px-3 text-[13px]")}
          >
            <PendingBody pending={upgrading} icon={<ArrowUpCircle aria-hidden />}>
              {qualityLabel(offer.resolution) ?? "Upgrade"}
            </PendingBody>
          </Button>
        ) : canAct && best ? (
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            data-owned-check
            aria-label={`Check again, ${name}. ${bestText}`}
            title={`${bestText}. Check again`}
            aria-busy={checking || undefined}
            disabled={actions.pending !== null}
            onClick={(event) => {
              event.stopPropagation();
              void actions.checkAgain().then((result) => {
                if (!result.good) notify(result);
              });
            }}
            className={cn(pillClassName, "relative w-11")}
          >
            <PendingBody pending={checking} icon={<RotateCw aria-hidden />}>
              <span className="sr-only">Check again</span>
            </PendingBody>
          </Button>
        ) : null}
      </span>
    );
  }

  return (
    <div
      data-title-owned
      data-owned-quality={state}
      className={cn("flex w-full min-w-0 flex-col gap-2 md:mr-2 md:w-auto md:flex-row md:flex-wrap md:items-center", className)}
    >
      <p className="flex min-h-10 min-w-0 items-center gap-2 text-[14px] font-medium text-foreground">
        <CheckCircle2 aria-hidden className="size-4 shrink-0 text-brand-foreground" />
        <span data-owned-text>{checking ? "Checking for a better copy" : bestText ?? ownedText}</span>
      </p>
      {queuedText ? (
        <p
          data-owned-queued={queued?.state}
          role="status"
          className="flex min-h-10 min-w-0 items-center gap-2 text-[14px] text-muted-foreground"
        >
          <ArrowUpCircle aria-hidden className="size-4 shrink-0" />
          {queuedText}
        </p>
      ) : canAct && offer ? (
        <Button
          type="button"
          size="lg"
          data-owned-upgrade
          aria-label={`${upgradeLabel(offer)}, ${name}`}
          aria-busy={upgrading || undefined}
          disabled={actions.pending !== null}
          onClick={() => void actions.upgrade()}
          className="relative w-full min-w-0 md:w-auto"
        >
          <PendingBody pending={upgrading} icon={<ArrowUpCircle aria-hidden />}>
            {upgradeLabel(offer)}
          </PendingBody>
        </Button>
      ) : canAct && best ? (
        <Button
          type="button"
          size="lg"
          variant="secondary"
          data-owned-check
          aria-label={`Check again, ${name}`}
          aria-busy={checking || undefined}
          disabled={actions.pending !== null}
          onClick={() => void actions.checkAgain()}
          className="relative w-full min-w-0 md:w-auto"
        >
          <PendingBody pending={checking} icon={<RotateCw aria-hidden />}>
            Check again
          </PendingBody>
        </Button>
      ) : null}
      {actions.message && !(actions.message.good && queued) ? (
        <p
          role="status"
          data-owned-message={actions.message.good ? "ok" : "refused"}
          className={cn(
            "text-[13px] md:basis-full",
            actions.message.good ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {actions.message.text}
        </p>
      ) : null}
    </div>
  );
}
