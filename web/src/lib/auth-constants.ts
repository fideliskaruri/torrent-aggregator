/**
 * Shared between server (`@/lib/auth`) and client (`session-provider`).
 * Kept separate so importing the identity does not pull Prisma into a client
 * bundle.
 */
export const LOCAL_USER_ID = "local";
export const LOCAL_USER_NAME = "You";
