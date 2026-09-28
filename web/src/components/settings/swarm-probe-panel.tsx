import { useCallback, useEffect, useState } from "react";
import { useFeatures } from "@/lib/features";
import { Loader2, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { readJsonBody } from "@/lib/api-json";
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
          "border-brand/30 bg-brand-dim text-brand-foreground",
      };
    case "neutral":
    default:
      return { variant: "outline" };
  }
}

export function SwarmProbePanel() {
  const { streaming } = useFeatures();
  return streaming ? <EnabledSwarmProbePanel /> : null;
}

function EnabledSwarmProbePanel() {
  const [data, setData] = useState<ProbeSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Scope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/prewarm/swarm-probe");
      const body = await readJsonBody<Partial<ProbeSettings> & { error?: string }>(res);
      if (!body) {
        // An older server has no availability checks (404 with an empty body);
        // that is a state to explain, not a JSON error to show.
        setUnavailable(true);
        return;
      }
      if (!res.ok) throw new Error(body.error || "Couldn't load availability checks. Try again.");
      setUnavailable(false);
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
      const body = await readJsonBody<{ scope?: Scope; error?: string }>(res);
      if (!res.ok || !body) {
        throw new Error(body?.error || "Couldn't save availability checks. Try again.");
      }
      setData((prev) => (prev ? { ...prev, scope: body.scope ?? next } : prev));
      // Refresh the measured list: switching scope may change what is relevant.
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
        <Radar className="h-5 w-5 text-brand-foreground shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-medium text-foreground">
            Check download availability
          </h2>
          <p className="text-xs text-subtle-foreground mt-1 leading-relaxed">
            Check likely next episodes ahead of time so TorrentFlow can avoid
            downloads that are unavailable. Safe to leave on.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-subtle-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading availability checks…
        </div>
      ) : unavailable ? (
        <p className="text-xs text-muted-foreground leading-relaxed" data-swarm-probe-unavailable>
          Availability checks aren't available on this version of TorrentFlow. Update TorrentFlow to turn them on.
        </p>
      ) : (
        <>
          <ToggleGroup
            type="single"
            variant="outline"
            value={scope}
            onValueChange={(value) => {
              if (value && value !== scope) void setScope(value as Scope);
            }}
            disabled={saving !== null}
            aria-label="Availability checks scope"
            className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3"
          >
            {choices.map((choice) => {
              const isDefault = data?.defaultScope === choice.value;
              return (
                <ToggleGroupItem
                  key={choice.value}
                  value={choice.value}
                  className="w-full justify-center max-md:min-h-11 pointer-coarse:min-h-11 data-[state=on]:border-brand/40 data-[state=on]:bg-brand-dim data-[state=on]:text-brand-foreground"
                >
                  {saving === choice.value ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  <span className="truncate">{choice.label}</span>
                  {isDefault ? (
                    <span className="text-xs text-subtle-foreground">
                      · default
                    </span>
                  ) : null}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-medium text-muted-foreground">
                Recent checks
              </h3>
              <span className="text-xs text-subtle-foreground">
                Results can change over time.
              </span>
            </div>

            {measurements.length === 0 ? (
              <p className="text-xs text-subtle-foreground leading-relaxed">
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
                      className="rounded-lg border border-border bg-muted/40 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span
                          className="min-w-0 truncate text-xs text-muted-foreground"
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
                      <div className="mt-1 text-xs text-subtle-foreground">
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

      {error ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="text-xs text-destructive">{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}
    </section>
  );
}
