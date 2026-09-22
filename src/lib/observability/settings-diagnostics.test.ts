import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { preparePrivateDb, cleanupPrivateDb } from "../../../scripts/lib/private-db.mjs";

async function main() {
  const db = preparePrivateDb("settings-diagnostics");
  process.env.DATABASE_URL = db.url;
  const { default: prisma } = await import("@/lib/prisma");
  try {
    const { LOCAL_USER_ID, ensureLocalUser } = await import("@/lib/auth");
    await ensureLocalUser();
    await prisma.clientSettings.deleteMany({ where: { userId: LOCAL_USER_ID } });
    const { GET, PUT } = await import("@/app/api/settings/client/route");
    const { getUserClientConfig } = await import("@/lib/clients");
    const save = (body: unknown) => PUT(new NextRequest(
      "http://127.0.0.1:3000/api/settings/client",
      {
        method: "PUT",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
        body: JSON.stringify(body),
      },
    ));

    const initial = await GET();
    assert.equal(initial.status, 200);
    assert.equal((await initial.json()).settings.verboseDiagnostics, false);
    assert.equal((await getUserClientConfig(LOCAL_USER_ID))?.verboseDiagnostics, false);

    for (const enabled of [true, false, true]) {
      const response = await save({ verboseDiagnostics: enabled });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).settings.verboseDiagnostics, enabled);
      const loaded = await GET();
      assert.equal((await loaded.json()).settings.verboseDiagnostics, enabled);
      assert.equal((await getUserClientConfig(LOCAL_USER_ID))?.verboseDiagnostics, enabled);
    }

    assert.equal((await save({ verboseDiagnostics: "false" })).status, 400);
    assert.equal((await getUserClientConfig(LOCAL_USER_ID))?.verboseDiagnostics, true);
    assert.equal((await save({ category: "Movies" })).status, 200);
    assert.equal((await getUserClientConfig(LOCAL_USER_ID))?.verboseDiagnostics, true);
    console.log("PASS diagnostics settings roundtrip, config propagation and invalid-input preservation");
  } finally {
    await prisma.$disconnect();
    cleanupPrivateDb(db);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("FAIL settings diagnostics", error);
  process.exit(1);
});
