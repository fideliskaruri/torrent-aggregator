import { memo } from "react";
import { PosterImage } from "@/components/browse/poster-image";

export const EpisodeStillImage = memo(function EpisodeStillImage({
  src,
  title,
}: {
  src: string;
  title: string;
}) {
  return (
    <PosterImage
      src={src}
      title={title}
      sizes="(min-width: 640px) 300px, 64px"
      variant="plain"
      className="object-cover"
    />
  );
});
