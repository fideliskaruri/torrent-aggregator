import prisma from "../../src/lib/prisma.ts";
const w = await prisma.watchListItem.findMany();
console.log("--- ALL WatchListItem cursors ---");
for (const x of w) console.log(JSON.stringify({title:x.title,status:x.status,cursorSeason:x.cursorSeason,cursorEpisode:x.cursorEpisode,fromSeason:x.fromSeason,lastEpisode:x.lastEpisode,createdAt:x.lastChecked}));
await prisma.$disconnect();
