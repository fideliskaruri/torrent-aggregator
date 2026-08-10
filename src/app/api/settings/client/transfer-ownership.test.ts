import assert from "node:assert/strict";
import fs from "node:fs";

const route = fs.readFileSync("src/app/api/settings/client/route.ts", "utf8");
const page = fs.readFileSync("src/app/settings/page.tsx", "utf8");

console.log("\nClient preference ownership contract");

assert.doesNotMatch(
  route,
  /shutdownBuiltinEngine/,
  "changing preference must not stop existing built-in transfers",
);
assert.match(
  route,
  /retainedExternalClientType\(/,
  "the saved external connection must survive preference changes",
);
assert.match(
  page,
  /form\.clientType === "builtin"[\s\S]{0,120}: form\.clientType/,
  "the settings form must retain the preferred external as the secondary",
);

console.log("PASS client preference ownership contract");
