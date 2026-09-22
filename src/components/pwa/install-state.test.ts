/**
 * The install affordance must never show a button that cannot install, and
 * must never disappear out from under an open browser dialog.
 * These are the rules that decide what renders.
 */
import assert from "node:assert/strict";
import {
  detectIosSafari,
  resolveInstallState,
  type InstallSignals,
} from "@/components/pwa/install-state";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

function signals(overrides: Partial<InstallSignals> = {}): InstallSignals {
  return {
    phase: "idle",
    hasDeferredPrompt: false,
    isStandalone: false,
    isIosSafari: false,
    isSecureContext: true,
    dismissed: false,
    ...overrides,
  };
}

console.log("pwa install state…");

check("a held beforeinstallprompt shows the install button", () => {
  assert.equal(
    resolveInstallState(signals({ hasDeferredPrompt: true })),
    "prompt",
  );
});

check("no prompt event on a desktop browser renders nothing", () => {
  assert.equal(resolveInstallState(signals()), "unsupported");
});

check("iOS gets instructions instead of a dead button", () => {
  assert.equal(resolveInstallState(signals({ isIosSafari: true })), "ios");
});

check("an already-installed app reports installed, prompt or not", () => {
  assert.equal(
    resolveInstallState(signals({ isStandalone: true })),
    "installed",
  );
  assert.equal(
    resolveInstallState(
      signals({ isStandalone: true, hasDeferredPrompt: true }),
    ),
    "installed",
  );
  // Installed state outranks dismissal — it is a statement of fact, not an ask.
  assert.equal(
    resolveInstallState(signals({ isStandalone: true, dismissed: true })),
    "installed",
  );
});

check("an insecure origin cannot install, so nothing renders", () => {
  assert.equal(
    resolveInstallState(
      signals({ isSecureContext: false, hasDeferredPrompt: true }),
    ),
    "unsupported",
  );
});

check("dismissal hides both the prompt and the iOS instructions", () => {
  assert.equal(
    resolveInstallState(signals({ hasDeferredPrompt: true, dismissed: true })),
    "unsupported",
  );
  assert.equal(
    resolveInstallState(signals({ isIosSafari: true, dismissed: true })),
    "unsupported",
  );
});

console.log("pwa install state: during and after the browser dialog…");

check("the card stays mounted while the dialog is open", () => {
  // The event is already spent at this point — `hasDeferredPrompt` is false —
  // so only the phase can keep the surface alive behind the browser dialog.
  assert.equal(
    resolveInstallState(
      signals({ phase: "prompting", hasDeferredPrompt: false }),
    ),
    "prompting",
  );
  // Even a stored dismissal must not yank it away mid-dialog.
  assert.equal(
    resolveInstallState(signals({ phase: "prompting", dismissed: true })),
    "prompting",
  );
});

check("a declined install explains, rather than vanishing or retrying", () => {
  assert.equal(resolveInstallState(signals({ phase: "declined" })), "declined");
  // …and on iOS-less desktop it must not fall through to the Share-sheet copy.
  assert.equal(
    resolveInstallState(signals({ phase: "declined", isIosSafari: true })),
    "declined",
  );
});

check("a fresh prompt event supersedes an earlier decline", () => {
  assert.equal(
    resolveInstallState(signals({ phase: "declined", hasDeferredPrompt: true })),
    "prompt",
  );
});

check("a failed prompt() surfaces an error state", () => {
  assert.equal(resolveInstallState(signals({ phase: "error" })), "error");
});

check("declined/error still respect an explicit dismissal", () => {
  assert.equal(
    resolveInstallState(signals({ phase: "declined", dismissed: true })),
    "unsupported",
  );
  assert.equal(
    resolveInstallState(signals({ phase: "error", dismissed: true })),
    "unsupported",
  );
});

check("installing during the dialog wins over every phase", () => {
  assert.equal(
    resolveInstallState(signals({ phase: "prompting", isStandalone: true })),
    "installed",
  );
});

console.log("pwa iOS detection…");

check("detects iPhone/iPad WebKit shells", () => {
  assert.equal(
    detectIosSafari(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1",
    ),
    true,
  );
  assert.equal(
    detectIosSafari(
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120 Mobile/15E148",
    ),
    true,
  );
});

check("does not treat desktop browsers as iOS", () => {
  assert.equal(
    detectIosSafari(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    ),
    false,
  );
  assert.equal(
    detectIosSafari(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    ),
    false,
  );
});

if (failures > 0) {
  console.error(`\n${failures} install-state check(s) failed`);
  process.exit(1);
}
console.log("\npwa install state: all checks passed");
