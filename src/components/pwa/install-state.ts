/**
 * Pure install-affordance state resolution, kept out of the component so the
 * rules can be asserted without a browser.
 *
 * Two rules drive everything here:
 *
 * 1. Never render an Install button that cannot install. Chromium tells us via
 *    `beforeinstallprompt`; iOS Safari never fires it and needs written
 *    instructions instead; everything else gets nothing at all.
 * 2. `beforeinstallprompt` is one-shot. Once `prompt()` has been called the
 *    event is spent — calling it again throws, whatever the user chose. So a
 *    declined install must NOT offer a retry button that re-uses it. The card
 *    stays visible, explains where the browser's own install control lives,
 *    and silently becomes a working button again if the browser fires a fresh
 *    event (it usually does on the next navigation).
 */
export type InstallState =
  /** Running from the home screen / app window already. */
  | "installed"
  /** A fresh, unspent deferred prompt is held; show the primary button. */
  | "prompt"
  /** `prompt()` is open; the browser owns the screen. Do not unmount. */
  | "prompting"
  /** The user closed the browser dialog. The event is spent; no retry. */
  | "declined"
  /** `prompt()` itself failed. Show the reason. */
  | "error"
  /** iOS Safari: installable, but only through Share → Add to Home Screen. */
  | "ios"
  /** Not installable here (or not a secure context); render nothing. */
  | "unsupported";

/** Where the install attempt currently is, independent of the environment. */
export type InstallPhase = "idle" | "prompting" | "declined" | "error";

export type InstallSignals = {
  phase: InstallPhase;
  /** An unspent event is held. False once `prompt()` has been called on it. */
  hasDeferredPrompt: boolean;
  isStandalone: boolean;
  isIosSafari: boolean;
  isSecureContext: boolean;
  dismissed: boolean;
};

export function resolveInstallState(signals: InstallSignals): InstallState {
  if (signals.isStandalone) return "installed";
  if (!signals.isSecureContext) return "unsupported";
  // The browser dialog is open: the card must stay mounted behind it, or the
  // user returns from a cancelled install to a surface that has vanished.
  if (signals.phase === "prompting") return "prompting";
  if (signals.dismissed) return "unsupported";
  // A fresh event outranks a past decline — the browser re-offered, so we do.
  if (signals.hasDeferredPrompt) return "prompt";
  if (signals.phase === "declined") return "declined";
  if (signals.phase === "error") return "error";
  if (signals.isIosSafari) return "ios";
  return "unsupported";
}

/** iOS Safari/WebKit, where the manifest exists but the prompt event doesn't. */
export function detectIosSafari(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  // iPadOS 13+ reports as a Mac and is indistinguishable from desktop Safari
  // by UA alone, so "macintosh" deliberately does not match: a wrong positive
  // would print Share-sheet steps to desktop users who have no Share sheet.
  if (!/iphone|ipad|ipod/.test(ua)) return false;
  // Chrome/Firefox/Edge on iOS are WebKit shells that also cannot prompt, and
  // their Add to Home Screen lives in the same place, so they count too.
  return true;
}
