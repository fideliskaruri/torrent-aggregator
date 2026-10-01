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
- Navigation uses react-router 7 directly (`Link`, `useNavigate`, `useLocation`, `useSearchParams`); images
  are plain `<img>` and the Geist faces are self-hosted via `@fontsource-variable/*` (imported in `app/layout.tsx`).
- Page titles use `useDocumentTitle` instead of Next.js `metadata`.
- `pnpm-workspace.yaml` keeps this a standalone pnpm project, separate from the repo root.

## Features and playback

`FeaturesProvider` reads `GET /api/features` once for the app and refreshes every 30 seconds.
There is no in-app playback or streaming. Finished files open in the owner's own player from
Downloads (Open and Show in folder, `POST /api/downloads/{id}/open`), and old `/watch/*` URLs
redirect home.