/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_PROXY?: string;
}

// Shared lib modules copied from the Next.js app pass Next's fetch cache hint;
// browsers ignore the extra field, this only keeps the types compiling unchanged.
interface RequestInit {
  next?: { revalidate?: number | false; tags?: string[] };
}
