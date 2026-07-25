/**
 * Stops outgoing message encryption from corrupting the buffers it is handed.
 *
 * `Wire.prototype._push` encrypts in place:
 *
 *   _push (data) {
 *     if (this._encryptor) data = this._encryptor.encrypt(data)   // mutates
 *     return this.push(data)
 *   }
 *
 * and the RC4 stream cipher behind it XORs straight into the caller's array
 * (`buf[i] ^= s[...]`, mse.js:41). That is fine for the message headers
 * `_message` allocates itself, but `_message(id, numbers, data)` forwards the
 * trailing `data` — which the *caller* still owns — to the same `_push`. Two
 * callers hand over live, long-lived buffers:
 *
 *   this._message(5, [], bitfield)                // index.js:433, from
 *                                                 // wire.bitfield(this.bitfield)
 *   this._message(7, [index, offset], buffer)     // index.js:468, a chunk
 *                                                 // straight out of the store
 *
 * So every encrypted peer we announce to overwrites the torrent's own bitfield
 * with ciphertext. Random bytes mean roughly half the bits come back set, which
 * is why freshly added torrents jumped to ~50% within seconds, why the number
 * then drifted up and down as more peers connected, and why pieces ended up
 * marked present that had never been downloaded. Captured live, the write is
 * unambiguous:
 *
 *   byte 0 = 214
 *     at MessageStreamEncryptor.encryptCipher (mse.js:45)
 *     at Wire._push                           (index.js:608)
 *     at Wire._message                        (index.js:599)
 *     at Wire.bitfield                        (index.js:433)
 *
 * The `piece` path is the same defect applied to cached chunks: seeding to an
 * encrypted peer scribbles over the block still held by the chunk store, so it
 * later fails its hash check and is re-downloaded.
 *
 * Upstream already ships `_pushCopy` for exactly this hazard and uses it for
 * its own constants; `_message` just never adopted it for caller-owned data.
 * The fix is to copy that trailing buffer before it reaches the cipher, and
 * only when a wire is actually encrypted, so unencrypted peers are untouched.
 */

const PATCHED = Symbol.for("torrentflow.wireEncryptAliasing");

let copies = 0;

/** Buffers defended from in-place encryption, for health checks and tests. */
export function encryptCopyCount(): number {
  return copies;
}

/** For tests. */
export function resetEncryptCopyCount(): void {
  copies = 0;
}

type WireHost = { _encryptor?: unknown };

type WireProto = Record<string | symbol, unknown> & { _message?: unknown };

type BufferLike = { length: number } & ArrayLike<number>;

export function patchWireEncryptAliasing(wirePrototype: object): boolean {
  const proto = wirePrototype as WireProto;
  if (proto[PATCHED]) return true;

  const original = proto._message;
  if (typeof original !== "function") return false;
  const fn = original as (this: unknown, ...args: unknown[]) => unknown;

  Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });

  proto._message = function patchedMessage(
    this: WireHost,
    id: unknown,
    numbers: unknown,
    data: unknown,
  ) {
    if (data && this._encryptor) {
      const buf = data as BufferLike;
      if (typeof buf.length === "number") {
        copies += 1;
        data = Uint8Array.from(buf);
      }
    }
    return fn.call(this, id, numbers, data);
  };
  return true;
}

/**
 * Resolves the Wire prototype from the installed package and patches it.
 * Returns whether the patch landed so the caller can log a miss if the
 * internals move.
 */
export async function patchWebTorrentWireEncrypt(): Promise<boolean> {
  try {
    const mod: unknown = await import(
      /* webpackIgnore: true */ "bittorrent-protocol"
    );
    const Ctor = (mod as { default?: unknown }).default ?? mod;
    const proto = (Ctor as { prototype?: object })?.prototype;
    if (!proto) return false;
    return patchWireEncryptAliasing(proto);
  } catch {
    return false;
  }
}
