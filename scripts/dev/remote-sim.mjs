#!/usr/bin/env node
/**
 * Local Cloudflare Access stand-in for TorrentFlow remote access.
 *
 * Generates an RSA keypair + JWKS, writes/merges <dataDir>/remote-access.json for the
 * sim team, and runs HTTP proxies that inject Cf-Access-Jwt-Assertion toward the
 * tunnel listener (default 127.0.0.1:3940).
 *
 * Ports (loopback only):
 *   3938  → owner@sim.test
 *   3939  → requester@sim.test   (open this in the browser)
 *
 * Optional:
 *   --as <email>           single proxy on --port (default 3939) for that email
 *   --data-dir <path>      required for JWKS + remote-access.json (also printed for server env)
 *   --target host:port     tunnel listener (default 127.0.0.1:3940)
 *   --owner-port N         default 3938
 *   --requester-port N     default 3939
 *   --port N               with --as only
 *
 * Example:
 *   node scripts/dev/remote-sim.mjs --data-dir D:\code\memtest\sim-data
 *   open http://127.0.0.1:3939
 */

import { createServer, request as httpRequest } from "node:http";
import {
  generateKeyPairSync,
  createSign,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const TEAM = "sim";
const AUDIENCE = "sim-audience"; // must match RemoteAccessRules (8+ chars)
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const OWNER_EMAIL = "owner@sim.test";
const REQUESTER_EMAIL = "requester@sim.test";
const KID = "sim-key-1";
const JWKS_NAME = "dev-jwks.json";
const PRIVATE_NAME = "dev-jwks.pem";
const SETTINGS_NAME = "remote-access.json";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    target: { type: "string", default: "127.0.0.1:3940" },
    "owner-port": { type: "string", default: "3938" },
    "requester-port": { type: "string", default: "3939" },
    port: { type: "string", default: "3939" },
    as: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`Usage: node scripts/dev/remote-sim.mjs --data-dir <path> [options]

  --data-dir PATH       Directory for JWKS + remote-access.json (required)
  --target HOST:PORT    Tunnel listener (default 127.0.0.1:3940)
  --owner-port N        Owner proxy port (default 3938) → ${OWNER_EMAIL}
  --requester-port N    Requester proxy port (default 3939) → ${REQUESTER_EMAIL}
  --as EMAIL            Single-role mode on --port (default 3939)
  --port N              Listen port when using --as

Server must run with ASPNETCORE_ENVIRONMENT=Development and
TorrentFlow__RemoteAccess__DevJwksPath=<data-dir>\\${JWKS_NAME}
`);
  process.exit(0);
}

if (!values["data-dir"]) {
  console.error("error: --data-dir is required");
  process.exit(1);
}

const dataDir = resolve(values["data-dir"]);
const [targetHost, targetPortRaw] = String(values.target).split(":");
const targetPort = Number(targetPortRaw);
if (!targetHost || !Number.isFinite(targetPort)) {
  console.error("error: --target must be host:port");
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });

const jwksPath = join(dataDir, JWKS_NAME);
const pemPath = join(dataDir, PRIVATE_NAME);
const settingsPath = join(dataDir, SETTINGS_NAME);

const privateKey = loadOrCreateKeypair(pemPath, jwksPath);
writeRemoteAccess(settingsPath);

const mint = (email) => mintJwt(privateKey, email);

if (values.as) {
  const port = Number(values.port);
  startProxy(port, values.as, mint);
  banner([{ port, email: values.as }]);
} else {
  const ownerPort = Number(values["owner-port"]);
  const requesterPort = Number(values["requester-port"]);
  startProxy(ownerPort, OWNER_EMAIL, mint);
  startProxy(requesterPort, REQUESTER_EMAIL, mint);
  banner([
    { port: ownerPort, email: OWNER_EMAIL },
    { port: requesterPort, email: REQUESTER_EMAIL },
  ]);
}

function banner(roles) {
  console.log(`remote-sim ready`);
  console.log(`  data-dir : ${dataDir}`);
  console.log(`  jwks     : ${jwksPath}`);
  console.log(`  target   : http://${targetHost}:${targetPort}`);
  console.log(`  iss/aud  : ${ISSUER} / ${AUDIENCE}`);
  for (const r of roles) {
    console.log(`  http://127.0.0.1:${r.port}  →  ${r.email}`);
  }
  console.log(`\nServer env (example):`);
  console.log(`  ASPNETCORE_ENVIRONMENT=Development`);
  console.log(`  TorrentFlow__DataDirectory=${dataDir}`);
  console.log(`  TorrentFlow__RemoteAccess__DevJwksPath=${jwksPath}`);
  console.log(`  ASPNETCORE_URLS=http://127.0.0.1:3921`);
}

function loadOrCreateKeypair(pemFile, jwksFile) {
  if (existsSync(pemFile) && existsSync(jwksFile)) {
    return createPrivateKey(readFileSync(pemFile));
  }
  const { publicKey, privateKey: priv } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  writeFileSync(pemFile, priv.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = KID;
  jwk.use = "sig";
  jwk.alg = "RS256";
  writeFileSync(jwksFile, JSON.stringify({ keys: [jwk] }, null, 2) + "\n");
  // Keep public-only export consistent if caller re-reads.
  createPublicKey(priv);
  return priv;
}

function writeRemoteAccess(path) {
  let existing = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
      if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
        existing = {};
      }
    } catch {
      existing = {};
    }
  }
  const next = {
    ...existing,
    enabled: true,
    tunnelPort: targetPort,
    tunnelBindAddress: targetHost === "localhost" ? "127.0.0.1" : targetHost,
    teamDomain: TEAM,
    audience: AUDIENCE,
    ownerEmails: [OWNER_EMAIL],
    allowRequesters: true,
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

function mintJwt(priv, email) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }),
  );
  const payload = b64url(
    JSON.stringify({
      iss: ISSUER,
      aud: [AUDIENCE],
      email,
      sub: email,
      iat: now - 30,
      nbf: now - 30,
      exp: now + 60 * 60,
    }),
  );
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const sig = signer.sign(priv).toString("base64url");
  return `${data}.${sig}`;
}

function startProxy(listenPort, email, mintFn) {
  const server = createServer((req, res) => {
    forward(req, res, email, mintFn);
  });

  server.on("upgrade", (req, socket, head) => {
    forwardUpgrade(req, socket, head, email, mintFn);
  });

  server.on("error", (err) => {
    console.error(`proxy :${listenPort} error:`, err.message);
    process.exit(1);
  });

  server.listen(listenPort, "127.0.0.1", () => {
    console.log(`listening 127.0.0.1:${listenPort} as ${email}`);
  });
}

function injectHeaders(reqHeaders, email, mintFn) {
  const headers = { ...reqHeaders };
  headers.host = `${targetHost}:${targetPort}`;
  headers["cf-access-jwt-assertion"] = mintFn(email);
  // Drop hop-by-hop headers that confuse the upstream.
  delete headers.connection;
  delete headers["keep-alive"];
  delete headers["proxy-connection"];
  delete headers["transfer-encoding"];
  delete headers.upgrade;
  return headers;
}

function forward(req, res, email, mintFn) {
  const headers = injectHeaders(req.headers, email, mintFn);
  const upstream = httpRequest(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`remote-sim bad gateway: ${err.message}`);
  });
  req.pipe(upstream);
}

function forwardUpgrade(req, socket, head, email, mintFn) {
  const headers = injectHeaders(req.headers, email, mintFn);
  // Re-add upgrade hop headers for WebSocket.
  if (req.headers.upgrade) headers.upgrade = req.headers.upgrade;
  if (req.headers.connection) headers.connection = req.headers.connection;
  if (req.headers["sec-websocket-key"]) {
    headers["sec-websocket-key"] = req.headers["sec-websocket-key"];
  }
  if (req.headers["sec-websocket-version"]) {
    headers["sec-websocket-version"] = req.headers["sec-websocket-version"];
  }
  if (req.headers["sec-websocket-protocol"]) {
    headers["sec-websocket-protocol"] = req.headers["sec-websocket-protocol"];
  }
  if (req.headers["sec-websocket-extensions"]) {
    headers["sec-websocket-extensions"] = req.headers["sec-websocket-extensions"];
  }

  const upstream = httpRequest({
    hostname: targetHost,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers,
  });

  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} Switching Protocols`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) lines.push(`${k}: ${item}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
  });

  upstream.on("error", (err) => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy(err);
  });

  upstream.on("response", (upRes) => {
    // Non-upgrade response to an upgrade request.
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ""}`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) lines.push(`${k}: ${item}`);
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    upRes.pipe(socket);
  });

  if (head?.length) upstream.write(head);
  upstream.end();
}
