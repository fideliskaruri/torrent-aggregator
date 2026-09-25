"use client";

/**
 * Local session for client components.
 *
 * Replaces next-auth's SessionProvider/useSession: this app is single-user and
 * local, so the session is a constant. Keeping the same `useSession()` shape
 * means call sites (`status`, `session.user.id`) did not have to change, and
 * real auth can be reintroduced by changing only this file and `@/lib/auth`.
 */
import { LOCAL_USER_ID, LOCAL_USER_NAME } from "@/lib/auth-constants";

export type ClientSession = {
  user: { id: string; name: string; email: string | null; image: string | null };
};

const SESSION: ClientSession = {
  user: {
    id: LOCAL_USER_ID,
    name: LOCAL_USER_NAME,
    email: null,
    image: null,
  },
};

export function AuthSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

/**
 * Status is always "authenticated" locally, but the type stays a union so the
 * existing loading/unauthenticated branches in pages keep compiling (and keep
 * working if real auth is reintroduced here later).
 */
export function useSession(): {
  data: ClientSession;
  status: "authenticated" | "loading" | "unauthenticated";
} {
  return { data: SESSION, status: "authenticated" };
}
