import { ExternalLink } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { LoadingGlyph } from "@/components/ui/loading";

/**
 * Open: a finished download in the owner's own player
 * (`POST /api/downloads/{id}/open`, docs/api-open-file.md). The one control
 * for every place that offers it: Downloads film rows, the series dialog's
 * episode cards, the title hero and the title page's episode cards. Callers
 * decide whether it applies (owner, `openFolder`, a finished single file) and
 * run `openDownload`; this only draws it, busy included. The icon takes the
 * button size's own icon size.
 */
export function TfOpenFileButton({
  name,
  busy,
  disabled,
  variant = "secondary",
  size = "sm",
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "aria-label" | "title"> & {
  /** What opens, for the accessible name: "Open S01E02 in your own player". */
  name: string;
  busy: boolean;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      aria-label={`Open ${name} in your own player`}
      title="Open in your own player"
      data-open-file
      {...props}
    >
      {busy ? <LoadingGlyph /> : <ExternalLink aria-hidden />}
      Open
    </Button>
  );
}
