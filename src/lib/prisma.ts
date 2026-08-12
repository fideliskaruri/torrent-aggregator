import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaSchemaSignature: string | undefined;
};

type PrismaSchemaRuntime = {
  dmmf?: { datamodel?: unknown };
  ModelName?: Record<string, string>;
  [key: string]: unknown;
};

export function prismaSchemaSignatureFrom(runtime: PrismaSchemaRuntime): string {
  if (runtime.dmmf?.datamodel) {
    return JSON.stringify(runtime.dmmf.datamodel);
  }

  const models = Object.values(runtime.ModelName ?? {})
    .sort()
    .map((name) => {
      const fieldEnum = runtime[`${name}ScalarFieldEnum`];
      const fields =
        fieldEnum && typeof fieldEnum === "object"
          ? Object.values(fieldEnum as Record<string, string>)
              .sort()
              .map((fieldName) => ({ name: fieldName }))
          : [];
      return { name, fields };
    });

  return JSON.stringify({ models });
}

export function generatedPrismaSchemaSignature(): string {
  return prismaSchemaSignatureFrom(Prisma as unknown as PrismaSchemaRuntime);
}

function resolveSqliteUrl(): string {
  const raw = process.env.DATABASE_URL ?? "file:./dev.db";
  // libSQL expects absolute file: URLs; resolve relative paths against project root
  if (raw.startsWith("file:")) {
    const filePath = raw.slice("file:".length);
    if (
      filePath.startsWith("./") ||
      filePath.startsWith(".\\") ||
      !path.isAbsolute(filePath)
    ) {
      const absolute = path.resolve(process.cwd(), filePath.replace(/^\.\//, ""));
      // libSQL on Windows prefers forward slashes in file URLs
      return `file:${absolute.replace(/\\/g, "/")}`;
    }
  }
  return raw;
}

function createPrismaClient() {
  const adapter = new PrismaLibSql({
    url: resolveSqliteUrl(),
  });
  return new PrismaClient({ adapter });
}

const schemaSignature =
  process.env.NODE_ENV === "production"
    ? undefined
    : generatedPrismaSchemaSignature();
const cachedPrisma =
  schemaSignature != null &&
  globalForPrisma.prismaSchemaSignature === schemaSignature
    ? globalForPrisma.prisma
    : undefined;

export const prisma = cachedPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaSchemaSignature = schemaSignature;
}

export default prisma;
