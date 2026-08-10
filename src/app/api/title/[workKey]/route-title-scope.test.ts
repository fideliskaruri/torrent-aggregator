import assert from "node:assert/strict";
import { postTitleMutation } from "./route";
import { SERIES_TITLE_SCOPE_MESSAGE } from "./grab";

async function main() {
  let buildTitleDetailCalls = 0;
  let grabForTitleCalls = 0;
  let grabSeasonForTitleCalls = 0;

  const response = await postTitleMutation(
    new Request("http://localhost/api/title/example", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        scope: "title",
        title: "The Bear",
      }),
    }),
    { params: Promise.resolve({ workKey: "example" }) },
    {
      auth: async () => ({ user: { id: "user-1" } }) as never,
      buildTitleDetail: async () => {
        buildTitleDetailCalls += 1;
        return {
          title: "The Bear",
          year: 2022,
          mediaType: "tv",
          aliases: [],
          isSeries: true,
          library: { watchListItemId: null },
        } as never;
      },
      resolveAcquisitionIdentity: async () => ({ kind: "absent" }),
      grabForTitle: async () => {
        grabForTitleCalls += 1;
        throw new Error("grabForTitle should not run for series title scope");
      },
      grabSeasonForTitle: async () => {
        grabSeasonForTitleCalls += 1;
        throw new Error("grabSeasonForTitle should not run for title scope");
      },
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    message: SERIES_TITLE_SCOPE_MESSAGE,
  });
  assert.equal(buildTitleDetailCalls, 1);
  assert.equal(grabForTitleCalls, 0);
  assert.equal(grabSeasonForTitleCalls, 0);
  console.log("PASS title route rejects ambiguous series title-scope grabs");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
