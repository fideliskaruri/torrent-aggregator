/**
 * Browse module barrel export.
 *
 * Single import surface for the UI agent:
 *
 *   import { type BrowsePayload, type Rail, ... } from "@/lib/browse";
 */
export type {
  AvailabilityState,
  Availability,
  ProgressUpdateBody,
  ProgressEntry,
  RailItem,
  Rail,
  BrowsePayload,
} from "./types";

export { COMPLETION_THRESHOLD } from "./types";

export type { AvailabilityQuery } from "./availability";

export {
  resolveAvailability,
  resolveAvailabilityBatch,
  resolveLocalAvailabilityBatch,
} from "./availability";

export { buildBrowsePayload } from "./rails";

export {
  buildDiscoveryRails,
  toRailItem,
  DISCOVERY_RAIL_SIZE,
  TRENDING_RAIL_ID,
  POPULAR_RAIL_ID,
  BECAUSE_RAIL_ID,
} from "./discovery";
