/**
 * Lifecycle tests for the install store.
 *
 * `beforeinstallprompt` is one-shot: once `prompt()` has been called the event
 * is spent and calling it again throws, whatever the user chose. Two bugs live
 * in that sentence, and both are asserted here:
 *
 *   1. dropping the event and publishing *before* awaiting the dialog, which
 *      unmounted the card behind the open browser dialog and lost it entirely
 *      when the user cancelled;
 *   2. "fixing" that by re-using the spent event on a retry button.
 *
 * Also asserted: the store reads nothing from the environment until it is
 * subscribed, so the server snapshot and the first client render agree.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveInstallState } from "@/components/pwa/install-state";
import {
  createInstallStore,
  SERVER_SNAPSHOT,
  type BeforeInstallPromptEvent,
  type InstallEnv,
} from "@/components/pwa/install-store";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

type Harness = {
  env: InstallEnv;
  fire: (type: string, event?: Partial<Event>) => void;
  reads: number;
  setStandalone: (value: boolean) => void;
};

function harness(
  options: { userAgent?: string; secure?: boolean; dismissed?: boolean } = {},
): Harness {
  const handlers = new Map<string, (event: Event) => void>();
  let standalone = false;
  let dismissed = options.dismissed ?? false;
  const state = {
    env: {
      addEventListener: (type, listener) => handlers.set(type, listener),
      matchesStandalone: () => {
        state.reads += 1;
        return standalone;
      },
      isSecureContext: () => options.secure ?? true,
      userAgent: () =>
        options.userAgent ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131 Safari/537.36",
      readDismissed: () => dismissed,
      writeDismissed: () => {
        dismissed = true;
      },
    } as InstallEnv,
    fire: (type: string, event: Partial<Event> = {}) => {
      const handler = handlers.get(type);
      assert.ok(handler, `no handler registered for ${type}`);
      handler(event as Event);
    },
    reads: 0,
    setStandalone: (value: boolean) => {
      standalone = value;
    },
  };
  return state;
}

/** A single-use event that throws on a second `prompt()`, like the real one. */
function promptEvent(outcome: "accepted" | "dismissed") {
  let spent = false;
  let prevented = 0;
  const event = {
    preventDefault: () => {
      prevented += 1;
    },
    prompt: async () => {
      if (spent) throw new Error("prompt() may only be called once");
      spent = true;
    },
    get userChoice() {
      return Promise.resolve({ outcome });
    },
    prompts: () => (spent ? 1 : 0),
    prevented: () => prevented,
  };
  return event as unknown as BeforeInstallPromptEvent & {
    prompts: () => number;
    prevented: () => number;
  };
}

async function main() {
  console.log("pwa install store: hydration safety…");

  await check("nothing is read from the browser before subscribe", () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    assert.deepEqual(store.getSnapshot(), SERVER_SNAPSHOT);
    assert.deepEqual(store.getServerSnapshot(), SERVER_SNAPSHOT);
    assert.equal(h.reads, 0);
    // An iOS UA must not change the pre-subscribe snapshot, or hydration
    // mismatches exactly where the extra Share-sheet markup would appear.
    const ios = createInstallStore(
      () =>
        harness({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" }).env,
    );
    assert.equal(resolveInstallState(ios.getSnapshot()), "unsupported");
    assert.equal(resolveInstallState(ios.getServerSnapshot()), "unsupported");
  });

  await check("a null env (server) leaves the snapshot untouched", () => {
    const store = createInstallStore(() => null);
    store.subscribe(() => {});
    store.dismiss();
    assert.deepEqual(store.getSnapshot(), SERVER_SNAPSHOT);
  });

  console.log("pwa install store: the one-shot prompt…");

  await check("root capture retains an event until the About card mounts", async () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    const detachRoot = store.subscribe(() => {});
    const event = promptEvent("accepted");
    h.fire("beforeinstallprompt", event as unknown as Event);
    const detachCard = store.subscribe(() => {});
    assert.equal(resolveInstallState(store.getSnapshot()), "prompt");
    assert.equal(event.prompts(), 0);
    await store.promptInstall();
    assert.equal(event.prompts(), 1);
    detachCard();
    detachRoot();
    const registrar = fs.readFileSync("src/components/pwa/service-worker-registrar.tsx", "utf8");
    const card = fs.readFileSync("src/components/pwa/install-app-card.tsx", "utf8");
    for (const source of [registrar, card]) {
      assert.match(source, /import \{ installStore \} from "\.\/install-store"/);
      assert.doesNotMatch(source, /createInstallStore\(/);
    }
    assert.match(registrar, /installStore\.subscribe\(/);
  });

  await check("a received event is held, not fired by the browser", () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    store.subscribe(() => {});
    const event = promptEvent("accepted");
    h.fire("beforeinstallprompt", event as unknown as Event);
    assert.equal(event.prevented(), 1, "mini-infobar suppressed");
    assert.equal(resolveInstallState(store.getSnapshot()), "prompt");
  });

  await check("the card stays mounted for the whole dialog", async () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    const seen: string[] = [];
    let recording = false;
    store.subscribe(() => {
      if (recording) seen.push(resolveInstallState(store.getSnapshot()));
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const event = {
      preventDefault: () => {},
      prompt: () => gate,
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    } as unknown as BeforeInstallPromptEvent;
    h.fire("beforeinstallprompt", event as unknown as Event);
    // Only what the user sees from the moment the button is available.
    recording = true;

    const pending = store.promptInstall();
    assert.equal(
      resolveInstallState(store.getSnapshot()),
      "prompting",
      "visible while the browser dialog is open",
    );
    release?.();
    await pending;
    assert.ok(
      !seen.includes("unsupported"),
      `card must never unmount mid-prompt; saw ${seen.join(" → ")}`,
    );
  });

  await check("accepting the dialog ends in the installed state", async () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    store.subscribe(() => {});
    const event = promptEvent("accepted");
    h.fire("beforeinstallprompt", event as unknown as Event);
    await store.promptInstall();
    assert.equal(resolveInstallState(store.getSnapshot()), "installed");
    assert.equal(event.prompts(), 1);
  });

  await check(
    "declining leaves an explanation, and never re-uses the spent event",
    async () => {
      const h = harness();
      const store = createInstallStore(() => h.env);
      store.subscribe(() => {});
      const event = promptEvent("dismissed");
      h.fire("beforeinstallprompt", event as unknown as Event);
      await store.promptInstall();
      assert.equal(resolveInstallState(store.getSnapshot()), "declined");

      // Anything that tries to prompt again must be a no-op, not a throw and
      // not a second dialog: the event is gone.
      await store.promptInstall();
      assert.equal(event.prompts(), 1, "prompt() called exactly once");
      assert.equal(resolveInstallState(store.getSnapshot()), "declined");
    },
  );

  await check("a fresh event after a decline restores the button", async () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    store.subscribe(() => {});
    const first = promptEvent("dismissed");
    h.fire("beforeinstallprompt", first as unknown as Event);
    await store.promptInstall();
    assert.equal(resolveInstallState(store.getSnapshot()), "declined");

    const second = promptEvent("accepted");
    h.fire("beforeinstallprompt", second as unknown as Event);
    assert.equal(resolveInstallState(store.getSnapshot()), "prompt");
    await store.promptInstall();
    assert.equal(resolveInstallState(store.getSnapshot()), "installed");
    assert.equal(first.prompts(), 1, "the spent event was never reused");
    assert.equal(second.prompts(), 1);
  });

  await check("a rejected prompt() surfaces the reason", async () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    store.subscribe(() => {});
    const event = {
      preventDefault: () => {},
      prompt: async () => {
        throw new Error("The app is already installed.");
      },
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    } as unknown as BeforeInstallPromptEvent;
    h.fire("beforeinstallprompt", event as unknown as Event);
    await store.promptInstall();
    assert.equal(resolveInstallState(store.getSnapshot()), "error");
    assert.equal(
      store.getSnapshot().errorMessage,
      "The app is already installed.",
    );
  });

  await check("concurrent presses cannot open two dialogs", async () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    store.subscribe(() => {});
    const event = promptEvent("accepted");
    h.fire("beforeinstallprompt", event as unknown as Event);
    await Promise.all([store.promptInstall(), store.promptInstall()]);
    assert.equal(event.prompts(), 1);
  });

  console.log("pwa install store: other browser signals…");

  await check("appinstalled flips the card to installed", () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    store.subscribe(() => {});
    h.fire("beforeinstallprompt", promptEvent("accepted") as unknown as Event);
    h.fire("appinstalled");
    assert.equal(resolveInstallState(store.getSnapshot()), "installed");
  });

  await check("dismiss persists and hides the card", () => {
    const h = harness();
    const store = createInstallStore(() => h.env);
    store.subscribe(() => {});
    h.fire("beforeinstallprompt", promptEvent("accepted") as unknown as Event);
    store.dismiss();
    assert.equal(resolveInstallState(store.getSnapshot()), "unsupported");
    assert.equal(h.env.readDismissed(), true, "written through to storage");
  });

  await check("a stored dismissal is honoured on the next visit", () => {
    const h = harness({ dismissed: true });
    const store = createInstallStore(() => h.env);
    store.subscribe(() => {});
    h.fire("beforeinstallprompt", promptEvent("accepted") as unknown as Event);
    assert.equal(resolveInstallState(store.getSnapshot()), "unsupported");
  });

  if (failures > 0) {
    console.error(`\n${failures} install store check(s) failed`);
    process.exit(1);
  }
  console.log("\npwa install store: all checks passed");
}

void main();
