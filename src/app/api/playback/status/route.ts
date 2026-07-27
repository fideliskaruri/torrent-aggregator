/**
 * GET /api/playback/status
 *
 * The seam by which a server-side recovery reaches the player. The swarm-delivery
 * watchdog runs on the engine's timer with no client involvement; when it fails a
 * stalled source over it switches the engine to a healthy release and carries the
 * viewer's position across. But nothing pushes that to the browser, and a player
 * left pointed at the dead infoHash still shows a black screen.
 *
 * So the player polls this: it returns the source the player should be on now
 * (`infoHash`), where to resume (`positionSec`, already carried to the new
 * source), and the structured state plus its rendered copy. When `infoHash`
 * changes the client re-points and seeks; when `exhausted` is true it shows the
 * honest terminal answer instead of a spinner. This route only READS the last
 * decided state — it never runs a watchdog tick, samples, or probes.
 *
 * The engine emits facts; `describePlayback` writes the words (commit `badaf94`).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { describePlayback } from "@/lib/playback/narration";
import { currentForegroundState } from "@/lib/playback/swarm-delivery-watchdog";
import { latestPlaybackPositionSec } from "@/lib/playback/engine-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const state = currentForegroundState();
  if (!state) {
    // Nothing is being watched (or it has not ticked yet). Not an error — the
    // client simply keeps playing whatever it opened on.
    return NextResponse.json({ active: false });
  }

  let positionSec: number | null = null;
  try {
    positionSec = await latestPlaybackPositionSec(session.user.id, state.currentHash);
  } catch {
    // A position read failure must not hide the switch itself — the client can
    // still re-point and resume from zero.
    positionSec = null;
  }

  return NextResponse.json({
    active: true,
    infoHash: state.currentHash,
    pinned: state.pinnedHash !== null && state.pinnedHash === state.currentHash,
    positionSec,
    exhausted: state.exhausted,
    narration: state.narration,
    copy: describePlayback(state.narration),
  });
}
