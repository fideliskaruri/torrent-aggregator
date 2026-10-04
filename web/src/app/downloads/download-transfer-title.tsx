import { Link } from "react-router";
import { TfWorkThumb } from "@/components/tf/work-thumb";

const TRANSFER_THUMB_PX = 40;

export function transferTitleParts({
  title,
  href,
  posterUrl,
  heading = false,
}: {
  title: string;
  href: string | null;
  posterUrl?: string | null;
  heading?: boolean;
}) {
  const thumb = <TfWorkThumb title={title} posterUrl={posterUrl ?? undefined} sizePx={TRANSFER_THUMB_PX} />;
  const Text = heading ? "h2" : "p";
  return {
    thumb: href ? (
      <Link to={href} tabIndex={-1} aria-hidden data-dense-ui className="shrink-0">{thumb}</Link>
    ) : thumb,
    text: href ? (
      <Link
        to={href}
        className="flex min-h-[44px] items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring lg:block lg:min-h-0"
        data-dialog-title-link={heading ? "" : undefined}
      >
        <Text className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground hover:text-brand-foreground">
          {title}
        </Text>
      </Link>
    ) : (
      <Text className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">{title}</Text>
    ),
  };
}
