# TorrentFlow web (Vite + React SPA)

The UI ported from the Next.js app in `../src`. The ASP.NET Core host serves `web/dist` with SPA fallback;
the SPA calls the same `/api/*` routes.

```powershell
pnpm -C web install
$env:VITE_API_PROXY = "http://127.0.0.1:5100"   # backend for /api (default)
pnpm -C web dev                                  # http://127.0.0.1:5173
pnpm -C web build                                # typecheck + web/dist
```

- `src/` mirrors the Next.js layout (`app/**/page.tsx`, `components/`, `hooks/`, client-safe `lib/`) so the
  two trees diff cleanly. Routes are declared in `src/router.tsx`.
- `src/shims/` implements `next/link`, `next/navigation`, `next/image` and `next/font/google` over
  react-router and plain elements; `vite.config.ts` and `tsconfig.json` alias them.
- Page titles use `useDocumentTitle` instead of Next.js `metadata`.
- `pnpm-workspace.yaml` keeps this a standalone pnpm project, separate from the repo root.
