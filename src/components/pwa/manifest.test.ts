/**
 * The manifest is the difference between "has a web app manifest" and
 * "installable". Chromium silently refuses to fire `beforeinstallprompt`
 * when an icon 404s or is not actually the size it claims — a failure mode
 * with no console error, which is how the previous SVG-only manifest looked
 * correct while never producing an install prompt.
 *
 * So these checks read the real files and the real PNG headers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

const publicDir = path.join(process.cwd(), "public");

type ManifestIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
};
type Manifest = {
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: ManifestIcon[];
};

const manifest: Manifest = JSON.parse(
  fs.readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8"),
);

/** Read width/height straight out of the PNG IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(path.join(publicDir, file));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(buf.subarray(0, 8).equals(signature), `${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

console.log("pwa manifest: identity…");

check("declares a stable id, scope and start_url", () => {
  assert.equal(manifest.id, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.start_url, "/");
});

check("declares name, display and app colors", () => {
  assert.equal(manifest.name, "TorrentFlow");
  assert.equal(manifest.short_name, "TorrentFlow");
  assert.equal(manifest.display, "standalone");
  // Must match globals.css --bg so the splash and app window don't flash white.
  assert.equal(manifest.background_color, "#0c0c0e");
  assert.equal(manifest.theme_color, "#0c0c0e");
});

console.log("pwa manifest: icons…");

check("every declared icon file exists", () => {
  assert.ok(manifest.icons && manifest.icons.length > 0, "icons declared");
  for (const icon of manifest.icons) {
    const file = path.join(publicDir, icon.src.replace(/^\//, ""));
    assert.ok(fs.existsSync(file), `missing ${icon.src}`);
  }
});

check("raster icons are genuinely 192x192 and 512x512", () => {
  const png = (manifest.icons ?? []).filter((i) => i.type === "image/png");
  assert.ok(png.length >= 2, "at least two raster icons");
  for (const icon of png) {
    const [w, h] = icon.sizes.split("x").map(Number);
    const actual = pngSize(icon.src.replace(/^\//, ""));
    assert.deepEqual(
      actual,
      { width: w, height: h },
      `${icon.src} is ${actual.width}x${actual.height}, declared ${icon.sizes}`,
    );
  }
});

check("includes the 192 and 512 sizes Chromium requires", () => {
  const sizes = new Set(
    (manifest.icons ?? [])
      .filter((i) => i.type === "image/png")
      .map((i) => i.sizes),
  );
  assert.ok(sizes.has("192x192"), "192x192 present");
  assert.ok(sizes.has("512x512"), "512x512 present");
});

check("declares a dedicated maskable icon", () => {
  const maskable = (manifest.icons ?? []).filter((i) =>
    (i.purpose ?? "").split(/\s+/).includes("maskable"),
  );
  assert.ok(maskable.length > 0, "a maskable icon exists");
  // "any maskable" on a full-bleed square is how icons end up cropped into
  // the launcher circle; the maskable entry must be its own padded file.
  for (const icon of maskable) {
    assert.equal(icon.purpose, "maskable", `${icon.src} is maskable-only`);
  }
});

check("ships an apple-touch-icon at 180x180 for iOS", () => {
  const actual = pngSize("apple-touch-icon.png");
  assert.deepEqual(actual, { width: 180, height: 180 });
});

console.log("pwa: offline shell…");

check("offline.html exists and states the server requirement", () => {
  const html = fs.readFileSync(path.join(publicDir, "offline.html"), "utf8");
  assert.match(html, /data-offline-shell/);
  assert.match(html, /can't reach your torrentflow server/i);
  // It must be self-contained: it is served when the network is gone.
  assert.ok(
    !/<script\s+src=|<link[^>]+stylesheet/i.test(html),
    "offline shell must not depend on external assets",
  );
});

if (failures > 0) {
  console.error(`\n${failures} pwa manifest check(s) failed`);
  process.exit(1);
}
console.log("\npwa manifest: all checks passed");
