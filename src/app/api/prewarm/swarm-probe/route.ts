/**
 * Swarm-probe settings + visibility — the seam the settings UI reads and writes.
 *
 * The user asked to be able to control "testing torrents in an automation… so
 * that we have a default list of the best torrents for shows I want to track",
 * and in the same breath talked themselves out of probing everything. This
 * route exposes exactly that control and the visibility that makes it
 * trustworthy:
 *
 *   GET  → the current scope, the choices to offer, and the most recently
 *          measured swarms (verdict + freshness) for the "what has been
 *          measured" list.
 *   PUT  → set the scope (off | watching | monitored).
 *
 * Read-only GET resolves nothing and searches nothing — a settings page must
 * never become a reason to hit an indexer or attach to a swarm.
 *
 * A measurement is a *prediction, not a guarantee* — swarms change. The payload
 * carries `expired` and `expiresAt` per row so the UI can present a cached
 * verdict as stale rather than as current fact; an expired row already reads
 * `unknown` (see swarm-probe `toStored`).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  DEFAULT_PREPROBE_SCOPE,
  normalizePreProbeScope,
  resolvePreProbeScope,
  type PreProbeScope,
} from "@/lib/prewarm/preprobe";
import {
  listRecentSwarmMeasurements,
  RECENT_MEASUREMENTS_LIMIT,
} from "@/lib/torrents/swarm-probe";

export const dynamic = "force-dynamic";

/**
 * The scope choices offered to the UI. "everything" is deliberately absent:
 * the user reasoned their way out of probing the whole catalogue, and offering
 * it would just be a trap.
 */
const SCOPE_CHOICES: ReadonlyArray<{ value: PreProbeScope; label: string }> = [
  { value: "off", label: "Off" },
  { value: "watching", label: "Only what I'm watching" },
  { value: "monitored", label: "Everything I monitor" },
];

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  try {
    const [scope, measurements] = await Promise.all([
      resolvePreProbeScope(userId, prisma),
      listRecentSwarmMeasurements({
        db: prisma,
        limit: RECENT_MEASUREMENTS_LIMIT,
      }),
    ]);

    return NextResponse.json({
      scope,
      defaultScope: DEFAULT_PREPROBE_SCOPE,
      choices: SCOPE_CHOICES,
      // A measurement is a prediction, not a guarantee. Each row carries its
      // freshness so the UI can say "checked 2h ago" and mark expired rows as
      // stale rather than current.
      measurements: measurements.map((m) => ({
        infoHash: m.infoHash,
        name: m.name,
        verdict: m.verdict,
        peersConnected: m.peersConnected,
        peersUnchoked: m.peersUnchoked,
        effectiveBps: m.effectiveBps,
        requiredBps: m.requiredBps,
        measuredAt: m.measuredAt.toISOString(),
        expiresAt: m.expiresAt.toISOString(),
        expired: m.expired,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message, scope: DEFAULT_PREPROBE_SCOPE, measurements: [] },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: { scope?: string };
  try {
    body = (await request.json()) as { scope?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // An unrecognised scope clamps to the default rather than being rejected —
  // the same "clamp, don't invent" posture the client-settings route takes.
  const scope = normalizePreProbeScope(body.scope ?? null);

  try {
    // ClientSettings is created lazily elsewhere; write onto the existing row
    // when there is one, otherwise create a minimal row (schema defaults fill
    // the rest).
    const existing = await prisma.clientSettings.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (existing) {
      await prisma.clientSettings.update({
        where: { userId },
        data: { preProbeScope: scope },
      });
    } else {
      await prisma.clientSettings.create({
        data: { userId, preProbeScope: scope },
      });
    }
    return NextResponse.json({ ok: true, scope });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
