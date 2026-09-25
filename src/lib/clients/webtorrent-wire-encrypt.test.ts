/**
 * The wire-encrypt patch defends caller-owned buffers from in-place RC4.
 *
 * The failure it prevents is silent and severe: the torrent's own bitfield
 * comes back as ciphertext, so roughly half its bits read as set and a
 * freshly added download reports ~50%. These tests pin the two things that
 * matter — that an encrypted wire never sees the caller's array, and that an
 * unencrypted wire is left completely alone.
 */
import assert from "node:assert/strict";
import {
  encryptCopyCount,
  patchWireEncryptAliasing,
  patchWireEncryptAliasingFromWire,
  resetEncryptCopyCount,
} from "@/lib/clients/webtorrent-wire-encrypt";

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

type Seen = { id: unknown; numbers: unknown; data: unknown };

/**
 * Mimics the real `Wire`: `_message` hands the trailing buffer to an encryptor
 * that XORs in place, exactly as `_push` -> `MessageStreamEncryptor.encrypt`
 * does upstream.
 */
function makeWire(encrypted: boolean) {
  const seen: Seen[] = [];
  const proto = {
    _message(this: unknown, id: unknown, numbers: unknown, data: unknown) {
      seen.push({ id, numbers, data });
      if (data) {
        const buf = data as Uint8Array;
        for (let i = 0; i < buf.length; i++) buf[i] ^= 0xff; // in-place, as RC4
      }
    },
  };
  const patched = patchWireEncryptAliasing(proto);
  const wire = Object.create(proto) as {
    _encryptor?: unknown;
    _message(id: unknown, numbers: unknown, data: unknown): void;
  };
  if (encrypted) wire._encryptor = {};
  return { wire, seen, patched };
}

console.log("wire encryption must not mutate the caller's buffer…");

check("an encrypted wire leaves the caller's bitfield untouched", () => {
  resetEncryptCopyCount();
  const { wire } = makeWire(true);
  const bitfield = new Uint8Array([0, 0, 0, 0]);
  wire._message(5, [], bitfield);
  assert.deepEqual(
    Array.from(bitfield),
    [0, 0, 0, 0],
    "the torrent's bitfield was encrypted in place",
  );
  assert.equal(encryptCopyCount(), 1);
});

check("the encrypted wire still receives the correct bytes", () => {
  const { wire, seen } = makeWire(true);
  const piece = new Uint8Array([1, 2, 3]);
  wire._message(7, [0, 0], piece);
  // The copy is what got encrypted, and it carried the right payload in.
  assert.deepEqual(Array.from(seen[0].data as Uint8Array), [254, 253, 252]);
  assert.notEqual(seen[0].data, piece, "the caller's array was forwarded");
});

check("id and numbers are forwarded unchanged", () => {
  const { wire, seen } = makeWire(true);
  wire._message(7, [4, 16384], new Uint8Array([9]));
  assert.equal(seen[0].id, 7);
  assert.deepEqual(seen[0].numbers, [4, 16384]);
});

check("an unencrypted wire is not copied", () => {
  resetEncryptCopyCount();
  const { wire, seen } = makeWire(false);
  const buf = new Uint8Array([1, 2, 3]);
  wire._message(5, [], buf);
  assert.equal(seen[0].data, buf, "unencrypted wires should pass through");
  assert.equal(encryptCopyCount(), 0);
});

check("messages with no payload are untouched", () => {
  resetEncryptCopyCount();
  const { wire, seen } = makeWire(true);
  wire._message(4, [7], null);
  assert.equal(seen[0].data, null);
  assert.equal(encryptCopyCount(), 0);
});

check("patching twice does not double-copy", () => {
  const proto = {
    _message(this: unknown) {},
  };
  assert.equal(patchWireEncryptAliasing(proto), true);
  assert.equal(patchWireEncryptAliasing(proto), true);
  const first = proto._message;
  patchWireEncryptAliasing(proto);
  assert.equal(proto._message, first, "the patch was applied more than once");
});

check("a prototype without _message is tolerated", () => {
  assert.equal(patchWireEncryptAliasing({ foo: 1 }), false);
});

console.log("\npatching from a live wire (the path that survives pnpm)…");

check("a wire instance patches the prototype every other wire shares", () => {
  resetEncryptCopyCount();
  // Exactly what WebTorrent hands us on a 'wire' event: an instance whose
  // prototype carries `_message`. `bittorrent-protocol` is a transitive
  // dependency and is not importable from here on a strict pnpm install, so
  // this — not module resolution — is what has to work.
  const proto = {
    _message(this: unknown, _id: unknown, _numbers: unknown, data: unknown) {
      if (data) {
        const buf = data as Uint8Array;
        for (let i = 0; i < buf.length; i++) buf[i] ^= 0xff;
      }
    },
  };
  const first = Object.create(proto) as {
    _encryptor?: unknown;
    _message(id: unknown, numbers: unknown, data: unknown): void;
  };
  first._encryptor = {};

  assert.equal(patchWireEncryptAliasingFromWire(first), true);

  const bitfield = new Uint8Array([0, 0, 0, 0]);
  first._message(5, [], bitfield);
  assert.deepEqual(Array.from(bitfield), [0, 0, 0, 0]);

  // A wire created later shares the prototype, so it is covered too.
  const later = Object.create(proto) as typeof first;
  later._encryptor = {};
  const piece = new Uint8Array([7, 7]);
  later._message(7, [0, 0], piece);
  assert.deepEqual(Array.from(piece), [7, 7], "later wires must be covered too");
  assert.equal(encryptCopyCount(), 2);
});

check("patching from a wire is idempotent across repeated wire events", () => {
  const proto = { _message(this: unknown) {} };
  const wire = Object.create(proto) as object;
  assert.equal(patchWireEncryptAliasingFromWire(wire), true);
  const patchedFn = (proto as { _message: unknown })._message;
  assert.equal(patchWireEncryptAliasingFromWire(wire), true);
  assert.equal(
    (proto as { _message: unknown })._message,
    patchedFn,
    "re-patching on every wire event must be a no-op",
  );
});

check("an object with no prototype chain is reported, not thrown", () => {
  assert.equal(patchWireEncryptAliasingFromWire(Object.create(null)), false);
});

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll wire-encrypt tests passed.");
