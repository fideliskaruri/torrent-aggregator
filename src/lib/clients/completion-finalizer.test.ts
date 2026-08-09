import assert from "node:assert/strict";
import { finalizeCompletedDownload } from "./completion-finalizer";

async function main() {
  {
    const order: string[] = [];
    const result = await finalizeCompletedDownload({
      quiesce: () => order.push("quiesce"),
      drainSnapshots: async () => {
        order.push("drain");
      },
      buildManifest: async () => {
        order.push("manifest");
        return { files: 2 };
      },
      persistManifest: async () => {
        order.push("persist");
      },
      detachPreservingFiles: async () => {
        order.push("detach:false");
      },
      afterDetach: () => {
        order.push("detached");
      },
    });
    assert.equal(result, true);
    assert.deepEqual(order, [
      "quiesce",
      "drain",
      "manifest",
      "persist",
      "detach:false",
      "detached",
    ]);
  }

  {
    const order: string[] = [];
    await assert.rejects(
      finalizeCompletedDownload({
        quiesce: () => order.push("quiesce"),
        drainSnapshots: async () => {
          order.push("drain");
        },
        buildManifest: async () => ({ files: 1 }),
        persistManifest: async () => {
          order.push("persist");
          throw new Error("database unavailable");
        },
        detachPreservingFiles: async () => {
          order.push("detach");
        },
      }),
    );
    assert.deepEqual(order, ["quiesce", "drain", "persist"]);
  }

  {
    let detached = false;
    const result = await finalizeCompletedDownload({
      quiesce: () => undefined,
      drainSnapshots: async () => undefined,
      buildManifest: async () => null,
      persistManifest: async () => assert.fail("must not persist"),
      detachPreservingFiles: async () => {
        detached = true;
      },
    });
    assert.equal(result, false);
    assert.equal(detached, false);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
