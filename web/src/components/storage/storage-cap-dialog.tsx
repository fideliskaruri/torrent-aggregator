/**
 * The storage cap, presented as a question rather than a verdict.
 *
 * ## Why this exists
 *
 * A Download that would exceed the cap used to end in a toast naming a settings
 * tab that does not exist, offering advice the owner could not follow. That is
 * the app overruling its user about their own disk. The cap is a guardrail, so
 * this dialog states the real figures and offers three ways forward: raise the
 * cap, proceed knowingly, or cancel.
 *
 * ## What it will NOT offer
 *
 * Two refusals have no "do it anyway", and both are honest about why:
 *
 *   - **wont-fit** — the release needs more bytes than the drive has free. No
 *     button can create disk, and a write that runs the volume to zero can
 *     corrupt files already in flight. This is the one hard stop.
 *   - **setup** — no download folder or cap chosen yet, so there is nothing to
 *     override. The way forward is to finish setup.
 *
 * Note what is *not* in that list: the free-space margin. A release that fits
 * but leaves the drive tighter than the app prefers is a preference, and the
 * owner overrules it like any other. Both non-overridable cases still link to
 * settings, so neither is a dead end.
 *
 * Play never reaches here: streaming reclaims its own cache and proceeds.
 *
 * ## UI rules honoured
 *
 *   - Esc cancels, focus is trapped, focus restores on close (Radix built-ins).
 *   - The consequential action is NOT the focused default — Radix focuses the
 *     first tabbable element, and Cancel is rendered first for exactly that
 *     reason (see the footer comment).
 *   - Every target is at least 44px tall on phones and touch screens.
 *   - Existing `AlertDialog` primitives and semantic tokens only; no new pattern.
 */

import { Link } from "react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import {
  capOverridePrompt,
  type StorageBar,
  type StorageBreakdownRow,
  type StorageOverrideFacts,
} from "@/lib/library/storage-override";
import { cn } from "@/lib/utils";

/**
 * Titles for the two refusals with no way through.
 *
 * They are named apart because they are different problems with different
 * answers — one needs disk, the other needs setup — and a shared "not enough
 * free disk space" heading would have been simply untrue for the setup case.
 */
function blockedTitle(facts: StorageOverrideFacts | null): string {
  return facts?.limit === "setup"
    ? "Finish setting up downloads"
    : "This will not fit on the drive";
}

function blockedBody(facts: StorageOverrideFacts | null): string {
  const message = facts?.message ?? "";
  if (facts?.limit === "setup") return message;
  // The measured reason already leads with both numbers, so this only adds the
  // part the numbers cannot say: why there is no "anyway" button here when the
  // other storage prompts have one.
  return (
    `${message} This is the one limit that cannot be waived. The file is ` +
    `larger than the space that exists, and forcing it would corrupt the ` +
    `download partway through.`
  );
}

const SWATCH: Record<StorageBreakdownRow["key"], string | null> = {
  used: "bg-subtle-foreground",
  incoming: "bg-brand",
  queued: "bg-brand opacity-40",
  cap: null,
  free: null,
  left: null,
};

/** Used, this download and the queue laid end to end, with a tick where the cap sits. */
function StorageBarView({ bar }: { bar: StorageBar }) {
  return (
    <div className="relative pt-1" aria-hidden="true" data-storage-bar>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {bar.segments.map((segment) => (
          <div
            key={segment.key}
            className={cn("h-full", SWATCH[segment.key])}
            style={{ width: `${segment.fraction * 100}%` }}
          />
        ))}
      </div>
      {bar.markerFraction != null ? (
        <div
          className="absolute top-0 h-4 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: `${bar.markerFraction * 100}%` }}
          data-storage-bar-cap
        />
      ) : null}
    </div>
  );
}

function StorageBreakdown({ rows }: { rows: StorageBreakdownRow[] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm" data-storage-breakdown>
      {rows.map((row) => (
        <div key={row.key} className="contents" data-storage-row={row.key}>
          <dt className="flex min-w-0 items-center gap-2 text-muted-foreground">
            {SWATCH[row.key] ? (
              <span className={cn("h-2 w-2 shrink-0 rounded-full", SWATCH[row.key])} aria-hidden="true" />
            ) : (
              <span className="h-2 w-2 shrink-0 rounded-full border border-foreground" aria-hidden="true" />
            )}
            {row.label}
          </dt>
          <dd
            className={cn(
              "text-right font-medium tabular-nums",
              row.key === "incoming" ? "text-brand-foreground" : "text-foreground",
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface StorageCapDialogProps {
  /** The refusal being explained. Null closes the dialog. */
  facts: StorageOverrideFacts | null;
  /** Called on cancel, Esc, or an outside dismiss. Must send nothing. */
  onCancel: () => void;
  /** Called only when the owner explicitly chooses to proceed past the limit. */
  onConfirm: () => void;
}

export function StorageCapDialog({ facts, onCancel, onConfirm }: StorageCapDialogProps) {
  const open = facts != null;
  const prompt = facts ? capOverridePrompt(facts) : null;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Any close that is not the explicit confirm is a cancel. Radix routes
        // Esc and the overlay through here, so this is the single place that
        // guarantees "dismissed" never means "sent".
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {facts?.overridable ? prompt?.title : blockedTitle(facts)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {facts?.overridable ? prompt?.summary : blockedBody(facts)}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {facts?.overridable && prompt ? (
          <div className="space-y-3 rounded-lg border border-border bg-background p-3.5">
            {prompt.bar ? <StorageBarView bar={prompt.bar} /> : null}
            <StorageBreakdown rows={prompt.rows} />
          </div>
        ) : null}
        {facts?.overridable && prompt ? (
          <p className="text-xs text-subtle-foreground" data-storage-note>
            {prompt.note}
          </p>
        ) : null}

        <AlertDialogFooter>
          {/*
            Cancel is rendered first deliberately. Radix moves initial focus to
            the first tabbable element in the content, so this keeps the safe
            choice as the default and stops "Download anyway" from being
            triggered by a reflexive Enter at a frustrating moment.
          */}
          <AlertDialogCancel className="max-md:min-h-11 pointer-coarse:min-h-11">
            {prompt?.cancelLabel ?? "Cancel"}
          </AlertDialogCancel>

          <Link
            to={facts?.settingsHref ?? "/settings?tab=folders"}
            className={cn(buttonVariants({ variant: "secondary" }), "max-md:min-h-11 pointer-coarse:min-h-11")}
            onClick={onCancel}
          >
            {facts?.overridable ? (prompt?.raiseCapLabel ?? "Raise the cap") : "Open settings"}
          </Link>

          {facts?.overridable ? (
            <AlertDialogAction className="max-md:min-h-11 pointer-coarse:min-h-11" onClick={onConfirm}>
              {prompt?.confirmLabel ?? "Download anyway"}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
