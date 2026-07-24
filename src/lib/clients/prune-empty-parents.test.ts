/**
 * Empty parent prune after torrent file delete.
 * Run: npx tsx --test src/lib/clients/prune-empty-parents.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";
import {
  isPathInsideOrEqual,
  pruneEmptyParents,
} from "./prune-empty-parents";

const tmpRoots: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-prune-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpRoots.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("isPathInsideOrEqual", () => {
  it("accepts descendants and equal", () => {
    const root = path.join("D:", "Torrents");
    assert.equal(isPathInsideOrEqual(root, root), true);
    assert.equal(
      isPathInsideOrEqual(path.join(root, "TV", "Show"), root),
      true,
    );
  });

  it("rejects siblings and parents", () => {
    const root = path.join("D:", "Torrents");
    assert.equal(
      isPathInsideOrEqual(path.join("D:", "Other"), root),
      false,
    );
  });
});

describe("pruneEmptyParents", () => {
  it("removes empty Season then empty Show, keeps TV and base", () => {
    const base = mkTmp();
    const season = path.join(base, "TV", "Family Guy", "Season 09");
    fs.mkdirSync(season, { recursive: true });
    // Simulate files already deleted — season empty
    const result = pruneEmptyParents(season, base);
    assert.ok(
      result.removed.some((p) => p.endsWith("Season 09")),
      `expected Season 09 removed, got ${result.removed.join(", ")}`,
    );
    assert.ok(
      result.removed.some((p) => p.endsWith("Family Guy")),
      `expected Family Guy removed, got ${result.removed.join(", ")}`,
    );
    // TV may be empty → also removed
    assert.ok(
      result.removed.some((p) => p.endsWith("TV") || path.basename(p) === "TV"),
      `expected empty TV removed, got ${result.removed.join(", ")}`,
    );
    assert.ok(fs.existsSync(base), "base must remain");
    assert.equal(fs.existsSync(season), false);
    assert.equal(fs.existsSync(path.join(base, "TV", "Family Guy")), false);
  });

  it("keeps Show when another Season still has files", () => {
    const base = mkTmp();
    const s09 = path.join(base, "TV", "Family Guy", "Season 09");
    const s24 = path.join(base, "TV", "Family Guy", "Season 24");
    fs.mkdirSync(s09, { recursive: true });
    fs.mkdirSync(s24, { recursive: true });
    fs.writeFileSync(path.join(s24, "ep.mkv"), "x");

    const result = pruneEmptyParents(s09, base);
    assert.ok(result.removed.some((p) => p.endsWith("Season 09")));
    assert.ok(
      !result.removed.some((p) => p.endsWith("Family Guy")),
      "must not remove show with other season",
    );
    assert.ok(fs.existsSync(s24));
    assert.ok(fs.existsSync(path.join(base, "TV", "Family Guy")));
  });

  it("never deletes the download base even if empty of children", () => {
    const base = mkTmp();
    const only = path.join(base, "orphan");
    fs.mkdirSync(only, { recursive: true });
    pruneEmptyParents(only, base);
    assert.ok(fs.existsSync(base));
  });

  it("refuses paths outside the base", () => {
    const base = mkTmp();
    const other = mkTmp();
    const leaf = path.join(other, "nope");
    fs.mkdirSync(leaf, { recursive: true });
    const result = pruneEmptyParents(leaf, base);
    assert.equal(result.removed.length, 0);
    assert.match(result.reason || "", /outside/i);
    assert.ok(fs.existsSync(leaf));
  });

  it("starts from a file path (uses parent dir)", () => {
    const base = mkTmp();
    const season = path.join(base, "TV", "Show", "Season 01");
    fs.mkdirSync(season, { recursive: true });
    const file = path.join(season, "ep.mkv");
    fs.writeFileSync(file, "x");
    fs.unlinkSync(file); // deleted by torrent client; path still known
    const result = pruneEmptyParents(file, base);
    assert.ok(result.removed.some((p) => p.endsWith("Season 01")));
    assert.ok(result.removed.some((p) => p.endsWith("Show")));
  });

  it("no-ops when directory still has content", () => {
    const base = mkTmp();
    const season = path.join(base, "TV", "Show", "Season 01");
    fs.mkdirSync(season, { recursive: true });
    fs.writeFileSync(path.join(season, "keep.mkv"), "x");
    const result = pruneEmptyParents(season, base);
    assert.equal(result.removed.length, 0);
    assert.ok(fs.existsSync(path.join(season, "keep.mkv")));
  });
});
