import {
  detectIosSafari,
  type InstallPhase,
  type InstallSignals,
} from "./install-state";

/**
 * Minimal shape of the Chromium-only `beforeinstallprompt` event. It is not in
 * lib.dom, and declaring it globally would imply it exists everywhere — which
 * is exactly the mistake this store avoids.
 */
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallSnapshot = InstallSignals & {
  errorMessage: string | null;
};

/**
 * Everything the store reads from the browser. Narrowed to an interface so the
 * install lifecycle — which is where the real bugs live — can be driven in a
 * test without a DOM.
 */
export type InstallEnv = {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  matchesStandalone: () => boolean;
  isSecureContext: () => boolean;
  userAgent: () => string;
  readDismissed: () => boolean;
  writeDismissed: () => void;
};

export const DISMISS_KEY = "tf:pwa-install-dismissed";

/**
 * What the server renders, and therefore what the client must render on its
 * first pass too. Every other field is an environment read — `navigator`,
 * `window.isSecureContext`, `localStorage` — so none of them may happen during
 * render. Reading them there produced markup on the client (notably the iOS
 * branch) that the server could never have produced.
 */
export const SERVER_SNAPSHOT: InstallSnapshot = {
  phase: "idle",
  hasDeferredPrompt: false,
  isStandalone: false,
  isIosSafari: false,
  isSecureContext: false,
  dismissed: false,
  errorMessage: null,
};

export function createInstallStore(getEnv: () => InstallEnv | null) {
  /** The unspent event. Cleared the moment `prompt()` is called on it. */
  let deferred: BeforeInstallPromptEvent | null = null;
  let phase: InstallPhase = "idle";
  let errorMessage: string | null = null;
  let snapshot: InstallSnapshot = SERVER_SNAPSHOT;
  const listeners = new Set<() => void>();
  let started = false;

  function refresh(patch: Partial<InstallSnapshot> = {}) {
    const env = getEnv();
    if (!env) return;
    const next: InstallSnapshot = {
      phase,
      hasDeferredPrompt: deferred !== null,
      isStandalone: env.matchesStandalone(),
      isIosSafari: detectIosSafari(env.userAgent()),
      isSecureContext: env.isSecureContext(),
      dismissed: env.readDismissed(),
      errorMessage,
      ...patch,
    };
    const unchanged = (Object.keys(next) as (keyof InstallSnapshot)[]).every(
      (key) => next[key] === snapshot[key],
    );
    if (unchanged) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function onPrompt(event: Event) {
    // Suppressing the mini-infobar is the whole point of holding the event:
    // the install action belongs on the card, next to the explanation. A new
    // event also clears a previous decline — the browser is offering again.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    phase = "idle";
    errorMessage = null;
    refresh();
  }

  function onInstalled() {
    deferred = null;
    phase = "idle";
    errorMessage = null;
    refresh({ isStandalone: true });
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      const env = getEnv();
      if (env && !started) {
        started = true;
        env.addEventListener("beforeinstallprompt", onPrompt);
        env.addEventListener("appinstalled", onInstalled);
      }
      refresh();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    dismiss() {
      getEnv()?.writeDismissed();
      refresh({ dismissed: true });
    },
    /**
     * Opens the browser's install dialog exactly once per received event.
     *
     * `prompt()` spends the event permanently — a second call throws, whatever
     * the user chose — so the reference is dropped up front and never reused.
     * `phase`, not the event, is what keeps the card mounted while the browser
     * owns the screen; an earlier version cleared the event and published
     * before awaiting, which unmounted the card behind the open dialog and
     * lost it for good if the user cancelled.
     */
    async promptInstall() {
      const event = deferred;
      if (!event || phase === "prompting") return;
      deferred = null;
      phase = "prompting";
      errorMessage = null;
      refresh();
      try {
        await event.prompt();
        const choice = await event.userChoice;
        phase = choice.outcome === "accepted" ? "idle" : "declined";
        refresh(
          choice.outcome === "accepted" ? { isStandalone: true } : undefined,
        );
      } catch (error) {
        phase = "error";
        errorMessage =
          error instanceof Error
            ? error.message
            : "The browser refused the install prompt.";
        refresh();
      }
    },
  };
}

export type InstallStore = ReturnType<typeof createInstallStore>;

/** The real-browser environment. Only called after mount. */
export function browserInstallEnv(): InstallEnv | null {
  if (typeof window === "undefined") return null;
  return {
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    matchesStandalone: () =>
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      // iOS Safari predates display-mode and uses this non-standard flag.
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    isSecureContext: () => window.isSecureContext,
    userAgent: () => navigator.userAgent,
    readDismissed: () => {
      try {
        return window.localStorage.getItem(DISMISS_KEY) === "1";
      } catch {
        // Private-mode storage denial is not a reason to hide the card.
        return false;
      }
    },
    writeDismissed: () => {
      try {
        window.localStorage.setItem(DISMISS_KEY, "1");
      } catch {
        // Dismissal simply won't persist; the card still closes now.
      }
    },
  };
}

export const installStore = createInstallStore(browserInstallEnv);
