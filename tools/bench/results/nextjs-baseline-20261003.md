# Next.js 5824ed5~1 baseline (OPS-647)

- Builds: `pnpm install` 96 s, `pnpm build` 42 s. Ran on 127.0.0.1:3932 with a fresh Prisma DB and a sandboxed media path.
- The bench tool cannot drive it end to end: its `/api/title` route rejects the .NET contract's TMDB parameters
  ("TMDB identity must be a movie or series"). Within the 30 min time box only raw `/api/search` was compared.
- Raw search, first page (both servers return 20 per page), same hour, same queries:

| Query | Next.js ms | main ms |
|---|---:|---:|
| Scorpion S01 | 4060 | 2596 |
| Little Fires Everywhere | 3419 | 1763 |
| Frieren S01 | 5161 | 6969 |
| A Silent Voice 2016 | 5995 | 4764 |
| Prison Break S01 | 3254 | 1701 |
| Money Heist S01 | 4784 | 1695 |
| Rick and Morty S01 | 3801 | 3778 |
| Sintel 2010 | 1000 | 2247 |
| Big Buck Bunny | 2879 | 1257 |

- Verdict: main searches faster on 7 of 9. Next.js's advantage was never search speed; what it had that main lost
  is the swarm probe before picking (see behaviour inventory, "LOST IN PORT"). Download comparison not run.
