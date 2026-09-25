import { useCallback, useEffect, useState } from "react";
import { Loader2, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SwarmVerdict } from "@/lib/torrents/swarm-probe";
import {
  verdictDisplay,
  freshnessLabel,
  type VerdictTone,
} from "@/lib/prewarm/swarm-verdict-display";

type Scope = "off" | "watching" | "monitored";

interface ScopeChoice {
  value: Scope;
  label: string;
}

interface Measurement {
  infoHash: string;
  name: string | null;
  verdict: SwarmVerdict;
  peersConnected: number;
  peersUnchoked: number;
  effectiveBps: number;
  requiredBps: number;
  measuredAt: string;
  expiresAt: string;
  expired: boolean;
}

interface ProbeSettings {
  scope: Scope;
  defaultScope: Scope;
  choices: ScopeChoice[];
  measurements: Measurement[];
}

/** Fallback choices if the payload omits them, so the control is never empty. */
const FALLBACK_CHOICES: ScopeChoice[] = [
  { value: "off", label: "Off" },
  { value: "watching", label: "What I'm watching" },
  { value: "monitored", label: "My whole Library" },
];

/** Map a display tone to a Badge look. `neutral` and `bad` are deliberately far apart. */
function toneBadge(tone: VerdictTone): {
  variant: "success" | "danger" | "outline" | "default";
  className?: string;
} {
  switch (tone) {
    case "good":
      return { variant: "success" };
    case "bad":
      return { variant: "danger" };
    case "weak":
      // No dedicated warning variant; borrow the shared warning colour so
      // "slow" sits visibly between healthy and broken.
      return {
        variant: "outline",
        className:
          "border-[rgba(245,181,90,0.28)] bg-[rgba(245,181,90,0.12)] text-[var(--warning)]",
      };
    case "neutral":
    default:
      return { variant: "outline" };
  }
}

export function SwarmProbePanel() {
  const [data, setData] = useState<ProbeSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Scope | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/prewarm/swarm-probe");
      const body = (await res.json()) as Partial<ProbeSettings> & {
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || "Could not load availability checks");
      setData({
        scope: body.scope ?? "monitored",
        defaultScope: body.defaultScope ?? "monitored",
        choices: body.choices?.length ? body.choices : FALLBACK_CHOICES,
        measurements: body.measurements ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The settings endpoint is the external source for this panel.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function setScope(next: Scope) {
    setSaving(next);
    setError(null);
    try {
      const res = await fetch("/api/prewarm/swarm-probe", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: next }),
      });
      const body = (await res.json()) as { scope?: Scope; error?: string };
      if (!res.ok) throw new Error(body.error || "Could not save availability checks");
      setData((prev) => (prev ? { ...prev, scope: body.scope ?? next } : prev));
      // Refresh the measured list — switching scope may change what is relevant.
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  const [renderedAt] = useState(() => Date.now());
  const scope = data?.scope ?? "monitored";
  const choices = data?.choices ?? FALLBACK_CHOICES;
  const measurements = data?.measurements ?? [];

  return (
    <section className="surface rounded-xl p-5 sm:p-6 space-y-5">
      <div className="flex items-start gap-3">
        <Radar className="h-5 w-5 text-[var(--accent-text)] shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-medium text-[var(--text)]">
            Check download availability
          </h2>
          <p className="text-xs text-[var(--text-tertiary)] mt-1 leading-relaxed">
            Check likely next episodes ahead of time so TorrentFlow can avoid
            downloads that are unavailable. Safe to leave on.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading availability checks…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {choices.map((choice) => {
              const active = scope === choice.value;
              const isDefault = data?.defaultScope === choice.value;
              return (
                <Button
                  key={choice.value}
                  type="button"
                  variant={active ? "default" : "secondary"}
                  disabled={saving !== null}
                  onClick={() => void setScope(choice.value)}
                  className="justify-center min-h-[44px] lg:min-h-0"
                >
                  {saving === choice.value ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  <span className="truncate">{choice.label}</span>
                  {isDefault ? (
                    <span className="text-[10px] text-[var(--text-tertiary)]">
                      · default
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-medium text-[var(--text-secondary)]">
                Recent checks
              </h3>
              <span className="text-[11px] text-[var(--text-tertiary)]">
                Results can change over time.
              </span>
            </div>

            {measurements.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)] leading-relaxed">
                {scope === "off"
                  ? "Availability checks are off."
                  : "No checks yet. TorrentFlow checks likely next episodes in the background."}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {measurements.map((m) => {
                  const display = verdictDisplay(m.verdict, m.expired);
                  const badge = toneBadge(display.tone);
                  const measuredAtMs = Date.parse(m.measuredAt);
                  const fresh = freshnessLabel(measuredAtMs, m.expired, renderedAt);
                  return (
                    <li
                      key={m.infoHash}
                      className="rounded-lg border border-[var(--border)] bg-[var(--bg-muted)]/40 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span
                          className="min-w-0 truncate text-xs text-[var(--text-secondary)]"
                          title={m.name ?? m.infoHash}
                        >
                          {m.name ?? m.infoHash}
                        </span>
                        <Badge
                          variant={badge.variant}
                          className={cn("shrink-0", badge.className)}
                          title={display.hint}
                        >
                          {display.label}
                        </Badge>
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                        {fresh}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {error ? <p className="text-xs text-[var(--danger)]">{error}</p> : null}
    </section>
  );
}
