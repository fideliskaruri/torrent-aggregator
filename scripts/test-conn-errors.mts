// Proves the peer-socket guard binds to the real webtorrent internals and that
// an error event that used to be unhandled is now absorbed.
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";

const { patchWebTorrentConnErrors, absorbedConnErrors, guardConn } =
  await import("../src/lib/clients/webtorrent-conn-errors.js");

const found = await patchWebTorrentConnErrors();
console.log("patched:", found);
assert.equal(found.outgoing, true, "Torrent.prototype._drain not found");
assert.equal(found.incoming, true, "ConnPool.prototype._onConnection not found");

// The shape webtorrent produces: one `once` listener, then a second error.
const sock = new EventEmitter();
sock.once("error", () => {});
guardConn(sock);

const before = absorbedConnErrors();
sock.emit("error", Object.assign(new Error("UTP_ECONNRESET"), { code: "UTP_ECONNRESET" }));
sock.emit("error", Object.assign(new Error("UTP_ECONNRESET"), { code: "UTP_ECONNRESET" }));
assert.equal(absorbedConnErrors() - before, 2, "guard did not absorb");

// Without the guard this same sequence throws out of `emit`.
const bare = new EventEmitter();
bare.once("error", () => {});
bare.emit("error", new Error("first"));
assert.throws(() => bare.emit("error", new Error("second")), /second/);

// The incoming patch must not swallow the original's behaviour.
const ConnPool = (await import("webtorrent/lib/conn-pool.js")).default as {
  prototype: { _onConnection: (conn: unknown, type: string) => unknown };
};
let reached = false;
const dead = new EventEmitter() as EventEmitter & { destroy: () => void };
dead.destroy = () => {
  reached = true;
};
ConnPool.prototype._onConnection.call({}, dead, "utp");
assert.equal(reached, true, "original _onConnection did not run");
dead.emit("error", new Error("after destroy"));

console.log("webtorrent-conn-errors: all assertions passed");
