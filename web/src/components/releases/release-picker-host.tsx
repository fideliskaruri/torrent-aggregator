import { useEffect, useState } from "react";
import { ReleasePickerDialog } from "./release-picker-dialog";
import { subscribeReleasePicker, type ReleasePickTarget } from "./release-picker-store";

/** Mounted once in the shell so any toast, row or log entry can open the picker. */
export function ReleasePickerHost() {
  const [target, setTarget] = useState<ReleasePickTarget | null>(null);
  useEffect(() => subscribeReleasePicker(setTarget), []);
  if (!target) return null;
  return (
    <ReleasePickerDialog
      key={`${target.workKey}:${target.season ?? "-"}:${target.episode ?? "-"}:${target.requestId ?? "-"}`}
      target={target}
      onClose={() => setTarget(null)}
    />
  );
}
