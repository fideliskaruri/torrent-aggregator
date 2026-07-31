-- Additive settings provenance and diagnostics flags. Existing guessed 100 GB
-- values remain untouched but are unconfigured until the owner explicitly
-- saves a cap.
ALTER TABLE "ClientSettings" ADD COLUMN "storageCapConfigured" BOOLEAN;
ALTER TABLE "ClientSettings" ADD COLUMN "verboseDiagnostics" BOOLEAN;
