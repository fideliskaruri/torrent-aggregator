import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

/**
 * `next/font/google` for the SPA. The fonts are self-hosted by @fontsource and
 * the CSS variables Next would set are defined in `src/app/fonts.css`, so the
 * returned class names are empty.
 */
interface FontResult {
  className: string;
  variable: string;
  style: { fontFamily: string };
}

function font(family: string) {
  return (_options?: Record<string, unknown>): FontResult => ({
    className: "",
    variable: "",
    style: { fontFamily: family },
  });
}

export const Geist = font("'Geist Variable'");
export const Geist_Mono = font("'Geist Mono Variable'");
