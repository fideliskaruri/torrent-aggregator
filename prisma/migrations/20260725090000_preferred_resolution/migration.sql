-- Target vertical resolution used by release ranking (480 | 720 | 1080 | 2160).
-- NULL means "use the built-in default" (1080), so existing rows keep working
-- without a backfill and nothing changes for anyone who never opens Settings.
ALTER TABLE "ClientSettings" ADD COLUMN "preferredResolution" INTEGER;
