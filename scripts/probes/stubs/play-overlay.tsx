/**
 * Probe-only stub for @/components/browse/play-overlay.
 *
 * The no-shift probe clicks Download and never opens the player, so the real
 * PlayOverlay (and the whole media/streaming stack it imports) is dead weight
 * in the bundle. This stub renders nothing and is aliased in ONLY by
 * scripts/probes/action-button-no-shift.mts — the app never sees it.
 */
export function PlayOverlay() {
  return null;
}
