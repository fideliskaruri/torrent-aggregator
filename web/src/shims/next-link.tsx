import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Link as RouterLink } from "react-router";

type Url = string | { pathname?: string | null; query?: Record<string, unknown> | string | null; hash?: string | null };

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: Url;
  replace?: boolean;
  scroll?: boolean;
  /** Accepted for source compatibility; the SPA has nothing to prefetch. */
  prefetch?: boolean | "auto" | null;
  shallow?: boolean;
  passHref?: boolean;
  legacyBehavior?: boolean;
  locale?: string | false;
};

const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

function toHref(href: Url): string {
  if (typeof href === "string") return href;
  let out = href.pathname ?? "";
  if (href.query) {
    const qs =
      typeof href.query === "string"
        ? href.query
        : new URLSearchParams(
            Object.entries(href.query).flatMap(([k, v]) =>
              v == null ? [] : Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]],
            ),
          ).toString();
    if (qs) out += `?${qs.replace(/^\?/, "")}`;
  }
  if (href.hash) out += href.hash.startsWith("#") ? href.hash : `#${href.hash}`;
  return out;
}

/** `next/link` on top of react-router: same props, client-side navigation for app routes. */
const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    href,
    replace,
    scroll,
    prefetch: _prefetch,
    shallow: _shallow,
    passHref: _passHref,
    legacyBehavior: _legacyBehavior,
    locale: _locale,
    ...rest
  },
  ref,
) {
  const to = toHref(href);
  if (EXTERNAL.test(to) || to.startsWith("#") || rest.download != null) {
    return <a ref={ref} href={to} {...rest} />;
  }
  return (
    <RouterLink
      ref={ref}
      to={to}
      replace={replace}
      preventScrollReset={scroll === false}
      {...rest}
    />
  );
});

export default Link;
