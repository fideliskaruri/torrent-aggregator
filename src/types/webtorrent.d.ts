declare module "webtorrent" {
  const WebTorrent: new (opts?: object) => import("webtorrent").Instance;
  export default WebTorrent;
  export interface Instance {
    torrents: Torrent[];
    /** Port the torrent TCP server listens on, once the client is listening. */
    torrentPort: number;
    add(
      uri: string | Uint8Array,
      opts?: { announce?: string[]; path?: string; strategy?: string },
      cb?: (torrent: Torrent) => void,
    ): Torrent;
    seed(
      input: string | Uint8Array | Array<string | Uint8Array>,
      opts?: { announce?: string[]; path?: string },
      cb?: (torrent: Torrent) => void,
    ): Torrent;
    get(id: string): Torrent | void;
    destroy(cb?: (err?: Error) => void): void;
    on(ev: string, fn: (...args: unknown[]) => void): void;
    throttleUpload(rate: number): void | boolean;
    throttleDownload(rate: number): void | boolean;
  }
  export interface TorrentFile {
    name: string;
    path: string;
    length: number;
    offset?: number;
    stream(opts?: { start?: number; end?: number }): ReadableStream<Uint8Array>;
    select(priority?: number): void;
    deselect(): void;
  }
  export interface Torrent {
    infoHash: string;
    name: string;
    progress: number;
    length: number;
    downloadSpeed: number;
    uploadSpeed: number;
    done: boolean;
    paused: boolean;
    /** False until existing data has been hash-checked. */
    ready: boolean;
    numPeers: number;
    timeRemaining: number;
    path: string;
    magnetURI?: string;
    /** Piece list; empty until metadata arrives, entries nulled as they verify. */
    pieces?: Array<unknown>;
    /** The .torrent file itself, available once metadata is known. */
    torrentFile: Uint8Array;
    files?: TorrentFile[];
    select(
      start: number,
      end: number,
      priority?: number,
      notify?: () => void,
    ): void;
    deselect(start: number, end: number): void;
    critical(start: number, end: number): void;
    pause(): void;
    resume(): void;
    /** `host:port`. Only valid after the `infoHash` event. */
    addPeer(peer: string): boolean;
    destroy(
      opts?: { destroyStore?: boolean },
      cb?: (err?: Error) => void,
    ): void;
    on(ev: string, fn: (...args: unknown[]) => void): void;
    once(ev: string, fn: (...args: unknown[]) => void): void;
  }
}

/**
 * The Torrent class itself, reachable only by deep import (webtorrent ships no
 * `exports` map). Typed as the bare constructor because the only thing we do
 * with it is patch two methods on its prototype — see
 * `src/lib/clients/webtorrent-piece-race.ts`.
 */
declare module "webtorrent/lib/torrent.js" {
  const Torrent: new (...args: never[]) => unknown;
  export default Torrent;
}

/** Same deep-import reason; see `src/lib/clients/webtorrent-conn-errors.ts`. */
declare module "webtorrent/lib/conn-pool.js" {
  const ConnPool: new (...args: never[]) => unknown;
  export default ConnPool;
}

/**
 * The peer wire, whose outgoing-message path encrypts in place; see
 * src/lib/clients/webtorrent-wire-encrypt.ts. Untyped upstream.
 */
declare module "bittorrent-protocol" {
  const Wire: new (...args: never[]) => unknown;
  export default Wire;
}
