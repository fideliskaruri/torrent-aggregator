import { forwardRef, type CSSProperties, type ImgHTMLAttributes } from "react";

export type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> & {
  src: string | { src: string };
  width?: number | `${number}`;
  height?: number | `${number}`;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  unoptimized?: boolean;
  placeholder?: string;
  blurDataURL?: string;
};

const FILL: CSSProperties = {
  position: "absolute",
  height: "100%",
  width: "100%",
  inset: 0,
  color: "transparent",
};

/** `next/image` as a plain `<img>` with the same attributes Next renders (no optimizer in the SPA). */
const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  { src, fill, priority, quality: _q, unoptimized: _u, placeholder: _p, blurDataURL: _b, style, loading, ...rest },
  ref,
) {
  return (
    <img
      ref={ref}
      src={typeof src === "string" ? src : src.src}
      loading={loading ?? (priority ? "eager" : "lazy")}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
      style={{ ...(fill ? FILL : { color: "transparent" }), ...style }}
      {...rest}
    />
  );
});

export default Image;
