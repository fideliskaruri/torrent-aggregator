"use client";

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
 *   - Every target is min-h-[44px].
 *   - Existing `AlertDialog` primitives and semantic tokens only; no new pattern.
 */

import Link from "next/link";
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
import { capOverridePrompt, type StorageOverrideFacts } from "@/lib/library/storage-override";
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
    `${message} This is the one limit that cannot be waived — the file is ` +
    `larger than the space that exists, and forcing it would corrupt the ` +
    `download partway through.`
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
            {facts?.overridable ? prompt?.body : blockedBody(facts)}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          {/*
            Cancel is rendered first deliberately. Radix moves initial focus to
            the first tabbable element in the content, so this keeps the safe
            choice as the default and stops "Download anyway" from being
            triggered by a reflexive Enter at a frustrating moment.
          */}
          <AlertDialogCancel className="min-h-[44px]">
            {prompt?.cancelLabel ?? "Cancel"}
          </AlertDialogCancel>

          <Link
            href={facts?.settingsHref ?? "/settings?tab=folders"}
            className={cn(buttonVariants({ variant: "secondary" }), "min-h-[44px]")}
            onClick={onCancel}
          >
            {facts?.overridable ? (prompt?.raiseCapLabel ?? "Raise the cap") : "Open settings"}
          </Link>

          {facts?.overridable ? (
            <AlertDialogAction className="min-h-[44px]" onClick={onConfirm}>
              {prompt?.confirmLabel ?? "Download anyway"}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
