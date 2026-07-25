/**
 * Local single-user auth.
 *
 * TorrentFlow runs on your own machine, so there is no sign-in: requiring a
 * third party (GitHub OAuth) just to search a torrent on localhost means an
 * outage, an expired OAuth app, or no internet locks you out of your own tool.
 *
 * The `userId` scoping throughout the schema is deliberately kept so real user
 * management can be added later without migrating every table — this module is
 * the single seam where that would change.
 */
import prisma from "@/lib/prisma";
import { LOCAL_USER_ID, LOCAL_USER_NAME } from "@/lib/auth-constants";

export { LOCAL_USER_ID, LOCAL_USER_NAME };

export type LocalSession = {
  user: { id: string; name: string; email: string | null; image: string | null };
};

const localSession: LocalSession = {
  user: {
    id: LOCAL_USER_ID,
    name: LOCAL_USER_NAME,
    email: null,
    image: null,
  },
};

let ensured: Promise<void> | null = null;

/**
 * The local user must exist as a real row: every model relates to User with
 * onDelete: Cascade, so writes would fail the foreign key without it.
 */
export function ensureLocalUser(): Promise<void> {
  if (!ensured) {
    ensured = prisma.user
      .upsert({
        where: { id: LOCAL_USER_ID },
        update: {},
        create: { id: LOCAL_USER_ID, name: LOCAL_USER_NAME },
      })
      .then(() => undefined)
      .catch((err) => {
        // Retry on the next call rather than caching the failure forever.
        ensured = null;
        throw err;
      });
  }
  return ensured;
}

/** Always returns the local session — kept async to match every call site. */
export async function auth(): Promise<LocalSession> {
  await ensureLocalUser();
  return localSession;
}
