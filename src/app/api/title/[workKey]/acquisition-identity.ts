/**
 * Server-side re-verification of the provider identity an acquisition claims.
 *
 * `GET` verifies the identity a link carries before the page renders. `POST`
 * used to inherit none of that: it re-derived a title from the local database
 * and took the client's word for everything else, so an anime work reached
 * through search lost its AniList aliases at exactly the moment it needed them
 * — and a hand-written POST could name any provider id it liked.
 *
 * This module closes both halves with one rule: **nothing the client sends
 * about the work is trusted, only used to name a lookup.** The provider id is
 * re-fetched from the provider and put through the identical agreement
 * contract the GET path uses (`resolveTitleProviderIdentity` — exact title,
 * year, media type, format and work-key checks). Only the *provider's own*
 * answer, with the provider's own aliases, is returned.
 *
 * Shape hints (`type`, `series`) are derived here rather than read from the
 * body, so a forged hint cannot be used to slip past a shape check; the real
 * check is that the derived shape matches what the provider reports.
 *
 * Three outcomes:
 *   - `absent`   — no identity was claimed; ordinary detail resolution runs.
 *   - `invalid`  — an identity was claimed and it does not hold up. The caller
 *                  must refuse the acquisition; this is the forged/mismatched
 *                  case, and continuing would download the wrong show.
 *   - `verified` — the provider confirmed it. Its metadata and aliases win.
 */
import {
  resolveTitleProviderIdentity,
  type VerifiedTitleProviderIdentity,
} from "./provider-identity";

/** The identity-bearing fields an acquisition request may carry. */
export interface AcquisitionIdentityRequest {
  provider?: unknown;
  providerId?: unknown;
  sourceType?: unknown;
  format?: unknown;
  title?: unknown;
  year?: unknown;
}

export type AcquisitionIdentityResult =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "verified"; identity: VerifiedTitleProviderIdentity };

type IdentityResolver = typeof resolveTitleProviderIdentity;

/**
 * Query parameters equivalent to the verified title link, built from a POST
 * body — or null when the body claims no provider identity at all.
 *
 * Aliases are deliberately *not* forwarded. A client-named alias is a search
 * term the client chose; the verified lookup supplies the real ones.
 */
export function acquisitionIdentityParams(
  body: AcquisitionIdentityRequest,
): URLSearchParams | null {
  const provider = stringField(body.provider)?.toLowerCase();
  const providerId = stringField(body.providerId);
  const sourceType = stringField(body.sourceType)?.toLowerCase();
  const title = stringField(body.title);
  if (!provider || !providerId || !sourceType || !title) return null;

  const format = stringField(body.format)?.toUpperCase() ?? null;
  const isSeries =
    provider === "anilist" ? format !== "MOVIE" : sourceType === "tv";
  const routeType =
    provider === "anilist" ? (isSeries ? "anime" : "movie") : sourceType;

  const params = new URLSearchParams();
  params.set("provider", provider);
  params.set("providerId", providerId);
  params.set("sourceType", sourceType);
  params.set("t", title);
  params.set("type", routeType);
  params.set("series", isSeries ? "1" : "0");
  if (format) params.set("format", format);
  const year = intField(body.year);
  if (year != null) params.set("y", String(year));
  return params;
}

export async function resolveAcquisitionIdentity(
  body: AcquisitionIdentityRequest,
  workKey: string,
  resolve: IdentityResolver = resolveTitleProviderIdentity,
): Promise<AcquisitionIdentityResult> {
  const params = acquisitionIdentityParams(body);
  if (!params) return { kind: "absent" };

  const result = await resolve(params, workKey);
  if (result.kind === "verified") {
    return { kind: "verified", identity: result.identity };
  }
  if (result.kind === "invalid") {
    return { kind: "invalid", reason: result.reason };
  }
  // `carried` means the provider could not be reached, not that the claim was
  // wrong — but an unreachable provider has verified nothing, so its metadata
  // (which came from the client) may not steer a download. The acquisition
  // continues from locally-resolved detail instead.
  return { kind: "absent" };
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : null;
}

function intField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1800 && value <= 2200 ? value : null;
}
