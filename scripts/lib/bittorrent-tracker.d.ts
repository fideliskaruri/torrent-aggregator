/**
 * Minimal typings for the tracker bundled with WebTorrent.
 *
 * `bittorrent-tracker` ships no types and is only ever used by the local-swarm
 * harness, so this declares exactly the surface that harness touches rather
 * than pulling in an untyped `any` that would defeat strict mode.
 */
declare module "bittorrent-tracker" {
  import type { Server as HttpServer } from "node:http";

  export type TrackerServerOptions = {
    udp?: boolean;
    ws?: boolean;
    http?: boolean;
    stats?: boolean;
  };

  export class Server {
    constructor(opts?: TrackerServerOptions);
    http?: HttpServer;
    listen(port: number, hostname?: string, onlistening?: () => void): void;
    close(cb?: () => void): void;
    on(event: "error" | "warning", listener: (err: Error) => void): this;
  }
}
