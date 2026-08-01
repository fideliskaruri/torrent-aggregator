# Contributing

Use Node.js 22 and install the lockfile exactly with `npm ci`.

Before opening a pull request, run the same required gates as CI:

```bash
npm run audit:prod
npm run lint
npm run typecheck
npm run test:unit
npm run db:migrate:deploy
npm run db:migrate:status
npm run build
```

Run `npm run test:ui` against the built app on `127.0.0.1:3000`. CI installs
Chromium, starts `npm run start`, waits for readiness, runs these probes, and
always stops the server.

Use a disposable `DATABASE_URL` and download directory for migration, build,
and browser checks. The default unit gate is offline, and CI must not run
`test:live` or any script that starts a real download. Run live indexer and
download tests only as explicit manual checks in a controlled environment.

## Prisma changes

Schema changes must be delivered as additive migrations:

1. Update `prisma/schema.prisma`.
2. Run `npm run db:migrate -- --name <short-description>`.
3. Commit the new directory under `prisma/migrations/`.
4. Verify it on a fresh disposable database with `db:migrate:deploy` and
   `db:migrate:status`.

Never edit, reorder, or delete an applied migration. Avoid destructive column
or table changes; use add/backfill/switch/remove across separate releases.

See [Releasing](docs/releasing.md) for version and tag steps.
