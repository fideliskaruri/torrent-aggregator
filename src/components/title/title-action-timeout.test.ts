/**
 * A grab that outlives the client's own deadline must not be reported as a
 * failed or missing release.
 *
 * The title POST is abandoned after 30 s, but the server's acquisition runs on
 * a much longer budget (torrent metadata alone is given 90 s). The old message
 * — "Could not send this episode" — claimed a failure this client had no
 * evidence for, and users saw the download appear moments later.
 */
import assert from "node:assert/strict";
import {
  GRAB_TIMEOUT_MESSAGE,
  postTitleAction,
} from "@/components/title/title-action-request";

let failures = 0;
const originalFetch = globalThis.fetch;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const INPUT = {
  workKey: "ninja-assassin-2009",
  action: { season: null, episode: null } as never,
  retention: "keep" as never,
};

async function main() {
  console.log("title action: honest timeouts…");

  await check("a client-side deadline says the grab may still be running", async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    }) as typeof fetch;
    await assert.rejects(() => postTitleAction(INPUT), (err: Error) => {
      assert.equal(err.message, GRAB_TIMEOUT_MESSAGE);
      assert.doesNotMatch(err.message, /no release|unavailable|not found/i);
      return true;
    });
  });

  await check("a real network failure keeps its own message", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(() => postTitleAction(INPUT), /fetch failed/);
  });

  await check("a caller's own cancellation still propagates as an AbortError", async () => {
    // An unmount or a season switch aborts the request on purpose. That is not
    // a failed grab and must not be dressed as one.
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;
    await assert.rejects(
      () => postTitleAction(INPUT),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
  });

  await check("a server refusal still speaks the server's reason", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          message:
            "Timed out waiting for torrent metadata (no peers / blocked DHT?). Try another release or check network.",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    await assert.rejects(() => postTitleAction(INPUT), /no peers \/ blocked DHT/);
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nAll title action timeout tests passed.");
});
