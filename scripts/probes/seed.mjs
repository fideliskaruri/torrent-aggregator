import prisma from "../../src/lib/prisma.ts";
const rows = await prisma.playbackProgress.findMany();
console.log("Rows where createdAt===updatedAt (never re-touched => seeded, not played):");
for (const r of rows) {
  if (+r.createdAt === +r.updatedAt) console.log(JSON.stringify({title:r.title,season:r.season,episode:r.episode,pos:r.positionSec,createdAt:r.createdAt}));
}
console.log("--- .e2e-instant-play dir ---");
