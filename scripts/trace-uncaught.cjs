// Diagnostic preload: prints raw, un-ignore-listed stacks for escaped errors.
// Next installs its own uncaughtException handler that source-maps the stack and
// collapses framework frames to "at ignore-listed frames", which hides exactly
// the frames we need. `process._rawDebug` bypasses Next's console patching.
Error.stackTraceLimit = 60;

process.on("uncaughtException", (err) => {
  process._rawDebug(
    `RAW-UNCAUGHT ${err && err.stack ? err.stack : String(err)}`,
  );
});

process.on("unhandledRejection", (err) => {
  process._rawDebug(`RAW-REJECT ${err && err.stack ? err.stack : String(err)}`);
});
