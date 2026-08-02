import assert from "node:assert/strict";
import { startVisiblePoller, type VisiblePollerDocument } from "./polling";

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeDocument implements VisiblePollerDocument {
  visibilityState: DocumentVisibilityState = "visible";
  listeners = new Set<() => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "visibilitychange") this.listeners.add(listener as () => void);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "visibilitychange") this.listeners.delete(listener as () => void);
  }

  setVisible(visible: boolean): void {
    this.visibilityState = visible ? "visible" : "hidden";
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeTimers {
  next = 1;
  timers = new Map<number, () => void>();
  cleared: number[] = [];

  set = (fn: () => void): ReturnType<typeof setTimeout> => {
    const id = this.next++;
    this.timers.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clear = (timer: ReturnType<typeof setTimeout> | undefined): void => {
    if (timer == null) return;
    const id = timer as unknown as number;
    this.cleared.push(id);
    this.timers.delete(id);
  };

  fire(id = Math.min(...this.timers.keys())): void {
    const fn = this.timers.get(id);
    assert.ok(fn, `timer ${id} should be pending`);
    this.timers.delete(id);
    fn();
  }
}

async function main(): Promise<void> {
  console.log("\n/client visible polling");

  await check("a slow response cannot overlap with the next poll", async () => {
    const doc = new FakeDocument();
    const timers = new FakeTimers();
    const first = deferred();
    let calls = 0;
    startVisiblePoller({
      poll: () => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve();
      },
      intervalMs: () => 5_000,
      document: doc,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    timers.fire();
    assert.equal(calls, 1);
    assert.equal(timers.timers.size, 0, "no next timer while the poll is in flight");
    first.resolve();
    await Promise.resolve();
    assert.equal(timers.timers.size, 1, "next timer appears only after the response settles");
  });

  await check("a hidden tab has no pending timer and resumes immediately on show", async () => {
    const doc = new FakeDocument();
    const timers = new FakeTimers();
    let calls = 0;
    startVisiblePoller({
      poll: () => {
        calls += 1;
      },
      intervalMs: () => 5_000,
      document: doc,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    assert.equal(timers.timers.size, 1);
    doc.setVisible(false);
    assert.equal(timers.timers.size, 0);
    doc.setVisible(true);
    assert.equal(calls, 1, "showing the tab refreshes immediately");
    await Promise.resolve();
    assert.equal(timers.timers.size, 1);
  });

  await check("cleanup removes the listener and pending timer before it can fire", () => {
    const doc = new FakeDocument();
    const timers = new FakeTimers();
    let calls = 0;
    const stop = startVisiblePoller({
      poll: () => {
        calls += 1;
      },
      intervalMs: () => 5_000,
      document: doc,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    assert.equal(doc.listeners.size, 1);
    assert.equal(timers.timers.size, 1);
    stop();
    assert.equal(doc.listeners.size, 0);
    assert.equal(timers.timers.size, 0);
    doc.setVisible(true);
    assert.equal(calls, 0);
  });

  console.log(`\n${failures === 0 ? "client polling: all tests passed" : `client polling: ${failures} failing`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
