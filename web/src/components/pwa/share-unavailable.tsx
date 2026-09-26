/**
 * Shown when a requester lands on the Web Share Target route. Sharing magnets
 * into the owner's download pipeline is owner-only; the server would refuse the
 * send API anyway, but we never mount that flow for requesters.
 */
export function ShareUnavailable() {
  return (
    <div
      className="surface max-w-lg space-y-2 p-4 sm:p-5"
      data-share-unavailable
      role="status"
    >
      <h1 className="text-[15px] font-medium text-[var(--text)]">Not available</h1>
      <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
        Sharing a magnet into TorrentFlow is only available to the owner on this
        server. Ask them to add it, or request the title from Search instead.
      </p>
    </div>
  );
}
