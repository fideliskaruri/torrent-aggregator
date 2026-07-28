import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPlaybackFailure,
  isConnectionBlockedError,
  playbackFailure,
  type PlaybackFailureKind,
  type PlaybackFailureSignals,
} from "./errors";

/**
 * The classifier is the single place raw conditions become a machine code, so
 * it is tested as a RULE across diverse inputs — not one happy path. Each row
 * asserts the expected discriminated kind AND its delivery/playability class,
 * because the player agent branches on both.
 */
type Row = {
  name: string;
  signals: PlaybackFailureSignals;
  kind: PlaybackFailureKind;
  retryable: boolean;
};

const ROWS: Row[] = [
  // not-found beats everything, even a thrown error.
  {
    name: "not found dominates",
    signals: { notFound: true, error: new Error("ECONNRESET"), peerCount: 0 },
    kind: "NOT_FOUND",
    retryable: false,
  },
  // undecodable is a playability verdict regardless of delivery health.
  {
    name: "undecodable is playability",
    signals: { undecodable: true, peerCount: 20 },
    kind: "UNPLAYABLE",
    retryable: false,
  },
  {
    name: "undecodable beats a stall",
    signals: { undecodable: true, stallReason: "stalled", peerCount: 5 },
    kind: "UNPLAYABLE",
    retryable: false,
  },
  // connection blocked (VPN off / firewall) — retryable on the SAME release.
  {
    name: "econnreset is blocked",
    signals: { error: new Error("read ECONNRESET") },
    kind: "CONNECTION_BLOCKED",
    retryable: true,
  },
  {
    name: "network unreachable is blocked",
    signals: { error: new Error("connect ENETUNREACH 1.2.3.4:6881"), peerCount: 3 },
    kind: "CONNECTION_BLOCKED",
    retryable: true,
  },
  {
    name: "proxy failure is blocked",
    signals: { error: new Error("proxy connection failed") },
    kind: "CONNECTION_BLOCKED",
    retryable: true,
  },
  // zero peers → NO_PEERS (delivery, retryable).
  {
    name: "no peers, no error",
    signals: { peerCount: 0 },
    kind: "NO_PEERS",
    retryable: true,
  },
  {
    name: "null peers is treated as none",
    signals: { peerCount: null },
    kind: "NO_PEERS",
    retryable: true,
  },
  {
    name: "stall with zero peers is really no-peers",
    signals: { stallReason: "stalled", peerCount: 0 },
    kind: "NO_PEERS",
    retryable: true,
  },
  // a real stall: peers present but bytes frozen.
  {
    name: "stall with peers is STALLED",
    signals: { stallReason: "stalled", peerCount: 8 },
    kind: "STALLED",
    retryable: true,
  },
  // an offline-style error with peers present is an engine fault, not no-peers.
  {
    name: "offline error with peers is engine error",
    signals: { error: new Error("etimedout"), peerCount: 9 },
    kind: "ENGINE_ERROR",
    retryable: false,
  },
  {
    name: "disk error is engine error",
    signals: { error: new Error("ENOSPC: no space left on device"), peerCount: 12 },
    kind: "ENGINE_ERROR",
    retryable: false,
  },
  // healthy-looking but with peers and no other signal → engine error fallback.
  {
    name: "peers present, no signal",
    signals: { peerCount: 15 },
    kind: "ENGINE_ERROR",
    retryable: false,
  },
];

test("classifyPlaybackFailure maps signals to the right kind", () => {
  for (const row of ROWS) {
    const out = classifyPlaybackFailure(row.signals);
    assert.equal(out.kind, row.kind, `kind for: ${row.name}`);
    assert.equal(out.retryable, row.retryable, `retryable for: ${row.name}`);
    assert.ok(out.defaultMessage.length > 0, `default message for: ${row.name}`);
  }
});

test("delivery failures are retryable, playability is not", () => {
  const delivery: PlaybackFailureKind[] = ["NO_PEERS", "CONNECTION_BLOCKED", "STALLED"];
  for (const kind of delivery) {
    const f = playbackFailure(kind);
    assert.equal(f.failureClass, "delivery", kind);
    assert.equal(f.retryable, true, kind);
  }
  assert.equal(playbackFailure("UNPLAYABLE").failureClass, "playability");
  assert.equal(playbackFailure("UNPLAYABLE").retryable, false);
  assert.equal(playbackFailure("NOT_FOUND").retryable, false);
});

test("isConnectionBlockedError distinguishes blocked from plain no-peer", () => {
  assert.equal(isConnectionBlockedError(new Error("ECONNRESET")), true);
  assert.equal(isConnectionBlockedError(new Error("ENETUNREACH")), true);
  assert.equal(isConnectionBlockedError(new Error("proxy died")), true);
  // A plain "no peers" condition is not itself a blocked-connection error.
  assert.equal(isConnectionBlockedError(new Error("no peers available")), false);
  assert.equal(isConnectionBlockedError(undefined), false);
});
