import assert from "node:assert/strict";
import { generatedPrismaSchemaSignature } from "./prisma";

const signature = generatedPrismaSchemaSignature();
const datamodel = JSON.parse(signature) as {
  models: Array<{
    name: string;
    fields: Array<{ name: string; type: string }>;
  }>;
};
const acquisitionTarget = datamodel.models.find(
  (model) => model.name === "AcquisitionTarget",
);

assert.ok(
  acquisitionTarget?.fields.some(
    (field) => field.name === "workId" && field.type === "String",
  ),
  "the generated Prisma client must include canonical Work ownership",
);

console.log("PASS generated Prisma schema signature");
