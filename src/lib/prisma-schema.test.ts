import assert from "node:assert/strict";
import {
  generatedPrismaSchemaSignature,
  prismaSchemaSignatureFrom,
} from "./prisma";

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

const browserSafeSignature = prismaSchemaSignatureFrom({
  ModelName: { AcquisitionTarget: "AcquisitionTarget" },
  AcquisitionTargetScalarFieldEnum: {
    id: "id",
    workId: "workId",
  },
});
const browserSafeDatamodel = JSON.parse(browserSafeSignature) as {
  models: Array<{ name: string; fields: Array<{ name: string }> }>;
};
assert.ok(
  browserSafeDatamodel.models
    .find((model) => model.name === "AcquisitionTarget")
    ?.fields.some((field) => field.name === "workId"),
  "the schema signature must remain available when Prisma.dmmf is absent",
);
assert.equal(
  prismaSchemaSignatureFrom({
    ModelName: { AcquisitionTarget: "AcquisitionTarget" },
    AcquisitionTargetScalarFieldEnum: { id: "id", workId: "workId" },
  }),
  browserSafeSignature,
  "the browser-safe schema signature must be stable",
);

console.log("PASS generated Prisma schema signature");
