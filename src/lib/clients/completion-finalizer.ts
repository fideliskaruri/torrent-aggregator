export async function finalizeCompletedDownload<T>(steps: {
  quiesce: () => void;
  drainSnapshots: () => Promise<void>;
  buildManifest: () => Promise<T | null>;
  persistManifest: (manifest: T) => Promise<void>;
  detachPreservingFiles: () => Promise<void>;
  afterDetach?: () => void | Promise<void>;
}): Promise<boolean> {
  steps.quiesce();
  await steps.drainSnapshots();
  const manifest = await steps.buildManifest();
  if (!manifest) return false;
  await steps.persistManifest(manifest);
  await steps.detachPreservingFiles();
  await steps.afterDetach?.();
  return true;
}
