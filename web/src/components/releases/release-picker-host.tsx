import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ReleasePickerDialog } from "./release-picker-dialog";
import { releasePickFromLink, subscribeReleasePicker, type ReleasePickTarget } from "./release-picker-store";

/**
 * Mounted once in the shell so any toast, row or notification can open the picker.
 * A notification's link opens it too: `/title/{workKey}?pick=1&…` (see `releasePickFromLink`).
 */
export function ReleasePickerHost() {
  const [target, setTarget] = useState<ReleasePickTarget | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => subscribeReleasePicker(setTarget), []);
  useEffect(() => {
    const fromLink = releasePickFromLink(location.pathname, location.search);
    if (!fromLink) return;
    setTarget(fromLink);
    // Drop the pick parameters so a reload or Back does not reopen the dialog.
    const params = new URLSearchParams(location.search);
    for (const name of [...params.keys()]) if (name.startsWith("pick")) params.delete(name);
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true });
  }, [location.pathname, location.search, navigate]);
  if (!target) return null;
  return (
    <ReleasePickerDialog
      key={`${target.workKey}:${target.season ?? "-"}:${target.episode ?? "-"}:${target.requestId ?? "-"}`}
      target={target}
      onClose={() => setTarget(null)}
    />
  );
}
