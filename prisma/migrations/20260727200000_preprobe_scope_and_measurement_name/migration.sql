-- Speculative pre-probe scope on per-user settings.
-- "off" | "watching" | "monitored"; NULL reads as the "watching" default.
ALTER TABLE "ClientSettings" ADD COLUMN "preProbeScope" TEXT;

-- Human-readable release name for the swarm-probe visibility list.
ALTER TABLE "SwarmMeasurement" ADD COLUMN "name" TEXT;