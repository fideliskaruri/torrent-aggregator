import { prisma as db } from "@/lib/prisma";

const rules = await db.autoRule.findMany({
  select: { id: true, name: true, category: true, enabled: true },
});
console.log(`autoRule total=${rules.length}`);
const byCat = new Map<string, number>();
for (const r of rules) byCat.set(r.category ?? "(null)", (byCat.get(r.category ?? "(null)") ?? 0) + 1);
console.log("by category:", JSON.stringify(Object.fromEntries(byCat)));
const orphaned = rules.filter((r) => !["all", "anime", "movies", "tv"].includes(r.category ?? ""));
console.log(`rules whose category is no longer offered: ${orphaned.length}`);
for (const r of orphaned) console.log(`  ${r.name} -> ${r.category} (enabled=${r.enabled})`);

await db.$disconnect();
