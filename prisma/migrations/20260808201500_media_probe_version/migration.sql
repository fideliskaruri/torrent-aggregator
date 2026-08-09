-- Generation marker for the probe cache. Existing rows default to 0, which is
-- older than the current cache version, so they are treated as a single cache
-- miss and re-probed once (recovering the container bitrate they never stored).
-- Rows written from now on carry the current version, so a file whose ffprobe
-- legitimately reports no bitrate is not re-probed forever.
ALTER TABLE "MediaProbe" ADD COLUMN "probeVersion" INTEGER NOT NULL DEFAULT 0;
