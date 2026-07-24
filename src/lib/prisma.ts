import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

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

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
