-- Cache the measured source bitrate so cache hits keep bitrate-aware buffer
-- sizing. Nullable: existing rows stay valid and simply report an unknown
-- bitrate until they are re-probed.
ALTER TABLE "MediaProbe" ADD COLUMN "bitRateBps" INTEGER;
