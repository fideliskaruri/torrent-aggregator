import { prisma as db } from "@/lib/prisma";



const total = await db.downloadHistory.count();
const harness = await db.downloadHistory.count({
  where: { message: { contains: ".e2e-instant-play" } },
});
const catPath = await db.downloadHistory.count({
  where: { OR: [{ message: { contains: "cat=" } }, { message: { contains: "path=" } }] },
});

console.log(`DownloadHistory total=${total}  harness-origin=${harness}  with cat=/path=  ${catPath}`);

const rows = await db.downloadHistory.findMany({
  where: { message: { contains: ".e2e-instant-play" } },
  select: { id: true, title: true, createdAt: true },
  take: 5,
});
for (const r of rows) console.log(`  ${r.createdAt.toISOString()}  ${r.title?.slice(0, 70)}`);

try {
  const et = await db.engineTorrent.count();
  const etH = await db.engineTorrent.count({
    where: { savePath: { contains: ".e2e-instant-play" } },
  });
  console.log(`EngineTorrent total=${et}  harness-origin=${etH}`);
} catch (e) {
  console.log("EngineTorrent probe failed:", (e as Error).message.slice(0, 120));
}

await db.$disconnect();
