-- Minutes between automatic automation runs. NULL = disabled, which is the
-- deliberate default: existing installs must not start grabbing on a timer
-- just because the feature shipped.
ALTER TABLE "ClientSettings" ADD COLUMN "automationIntervalMinutes" INTEGER;
