import { useSyncExternalStore } from "react";
import { useSessionInfo, type SessionRole } from "@/lib/session";

/**
 * What the signed-in person may do, derived from one role. Every screen asks
 * this instead of comparing roles, so "some people just don't see the download
 * button" stays one decision in one place. The server enforces the real
 * boundary; this only decides what to render and which endpoints to call.
 */
export interface Capabilities {
  /** Start, pause or pick torrents; quality choices; season/episode Download. */
  canDownload: boolean;
  /** Settings, rules, automation, delete, Add to library. */
  canManage: boolean;
  /** Play in the browser, stream URLs, playback progress. */
  canStream: boolean;
  /** File paths, open folder, raw release names. */
  canSeePaths: boolean;
  /** Live transfers: speed, peers, per-episode progress. */
  canSeeTransfers: boolean;
  /** Ask the owner for a title (Request button). */
  canRequest: boolean;
  /** The owner's inbox: approve, decline, auto-approve. */
  canReviewRequests: boolean;
  /** Upcoming releases (reads the owner's timeline). */
  canSeeUpcoming: boolean;
}

export type Capability = keyof Capabilities;

export function capabilitiesFor(role: SessionRole): Capabilities {
  const owner = role === "owner";
  return {
    canDownload: owner,
    canManage: owner,
    canStream: owner,
    canSeePaths: owner,
    canSeeTransfers: owner,
    canRequest: !owner,
    canReviewRequests: owner,
    canSeeUpcoming: owner,
  };
}

/** Session storage key for the owner's "View as requester" preview. */
export const PREVIEW_ROLE_KEY = "tf_preview_role";

/** The role the UI renders as. Only a real owner can preview; nothing else can raise or lower it. */
export function effectiveRole(realRole: SessionRole, stored: string | null): SessionRole {
  return realRole === "owner" && stored === "requester" ? "requester" : realRole;
}

const listeners = new Set<() => void>();

function readPreview(): string | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage.getItem(PREVIEW_ROLE_KEY);
  } catch {
    return null;
  }
}

function subscribePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Turns the owner's requester preview on or off for this tab. Client-side only. */
export function setPreviewAsRequester(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(PREVIEW_ROLE_KEY, "requester");
    else window.sessionStorage.removeItem(PREVIEW_ROLE_KEY);
  } catch {
    // Storage blocked: the preview simply doesn't stick.
  }
  for (const listener of listeners) listener();
}

export interface CapabilityInfo extends Capabilities {
  /** The role the UI renders as. */
  role: SessionRole;
  /** The role `/api/me` reported. */
  realRole: SessionRole;
  /** The owner is viewing the app as a requester would. */
  previewing: boolean;
  /** The owner may turn on the requester preview (real owner, not already previewing). */
  canPreview: boolean;
  /**
   * The server session is the owner's, so owner endpoints answer. Stays true in
   * preview: the preview changes what renders, never which session is asking.
   * `/api/requester/*` answers only when this is false.
   */
  ownerSession: boolean;
}

export function useCapabilities(): CapabilityInfo {
  const realRole = useSessionInfo().role;
  const stored = useSyncExternalStore(subscribePreview, readPreview, () => null);
  const role = effectiveRole(realRole, stored);
  const previewing = role !== realRole;
  const ownerSession = realRole === "owner";
  return { ...capabilitiesFor(role), role, realRole, previewing, canPreview: ownerSession && !previewing, ownerSession };
}
