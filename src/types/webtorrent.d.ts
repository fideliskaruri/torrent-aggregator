declare module "webtorrent" {
  const WebTorrent: new (opts?: object) => import("webtorrent").Instance;
  export default WebTorrent;
  export interface Instance {
    torrents: Torrent[];
    add(
      uri: string,
      opts?: { path?: string },
      cb?: (torrent: Torrent) => void,
    ): Torrent;
    get(id: string): Torrent | void;
    destroy(cb?: (err?: Error) => void): void;
    on(ev: string, fn: (...args: unknown[]) => void): void;
  }
  export interface TorrentFile {
    name: string;
    path: string;
    length: number;
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
    numPeers: number;
    timeRemaining: number;
    path: string;
    magnetURI?: string;
    files?: TorrentFile[];
    pause(): void;
    resume(): void;
    destroy(
      opts?: { destroyStore?: boolean },
      cb?: (err?: Error) => void,
    ): void;
    on(ev: string, fn: (...args: unknown[]) => void): void;
  }
}
