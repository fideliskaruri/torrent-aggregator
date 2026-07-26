# Automation scheduling

## The gap this closed

`runUserAutomation` used to be reachable from exactly one place:
`POST /api/automation/run`, which only fires when someone presses **Run
automation** on the Library page. There was no cron, no `instrumentation.ts`,
no `setInterval` anywhere in the tree.

Meanwhile every watchlist card rendered `· monitoring`. Nothing was monitoring
anything. Adding a show and picking a start episode did not cause a single byte
to be downloaded until the user came back and clicked a button.

`src/lib/automation/scheduler.ts` closes that, and the Library copy now states
what actually happens instead of implying it.

## How it runs

`src/instrumentation.ts` exports `register()`, which Next calls once per server
process before the first request. It is gated on
`process.env.NEXT_RUNTIME === "nodejs"` — the edge bundle has no Prisma and no
long-lived process, so importing the scheduler there would break the build
without buying anything.

`startAutomationScheduler()` is idempotent and arms a self-scheduling
`setTimeout`. Each tick:

1. reads `ClientSettings.automationIntervalMinutes` from the database,
2. runs `runUserAutomation` if it is greater than zero,
3. schedules the next tick.

## Design decisions, and why

**Opt-in, default off.** `automationIntervalMinutes` is `NULL` in the schema and
`0` for every existing install. A timer that downloads files while nobody is
watching is something the user should switch on, not something they discover
afterwards from a full disk. The migration deliberately does not backfill.

**`setTimeout`, not `setInterval`.** A run that takes longer than the interval
would stack under `setInterval` — two automation passes racing each other over
the same watchlist. The next tick is scheduled *after* the previous one
settles, so the gap is measured between runs rather than between starts.

**A `globalThis` singleton, not a module-level flag.** Next re-evaluates modules
on HMR and `register()` can fire more than once. A module-scoped `started`
boolean is reset by re-evaluation; a `Symbol.for`-keyed slot on `globalThis`
survives it. Two schedulers means two concurrent runs means duplicate grabs.

**Settings are re-read every tick.** Turning the schedule on, off, or changing
its period takes effect on the next tick with no restart. While it is off the
scheduler polls settings every five minutes rather than exiting, so switching it
on in the UI does not require bouncing the server.

**Errors never stop the timer.** A dead download client or an indexer outage
logs and reschedules. An unhandled rejection inside a `setTimeout` callback
would otherwise take the whole server down.

**Nothing under 15 minutes.** `MIN_INTERVAL_MINUTES` floors whatever is in the
database. Episodes do not appear faster than that, and a tighter loop only buys
extra requests against indexers that ban IPs.

**No new dependency.** `node-cron`, `bree`, `agenda` and friends all solve
multi-job scheduling, persistence and distribution. This is one job, in one
process, for one user. A `setTimeout` is the whole feature.

## Overlap safety

`runUserAutomation` takes a per-user, per-scope row lock (`src/lib/automation/run-lock.ts`)
with a 15-minute stale window. So even if a scheduled tick and a manual **Run
automation** click land at the same moment, only one run proceeds — the
scheduler does not need its own mutual exclusion, and a crashed run cannot wedge
automation permanently.

## Where the user controls it

Settings → **Downloads** → *Check watchlist automatically*: Off / 30m / 2h / 6h.
The hint under the control spells out the consequence in both states rather than
just naming a number.
