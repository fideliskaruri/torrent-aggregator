/**
 * Render the raster PWA icons from public/icon.svg.
 *
 * Android/Chrome installability requires real raster icons at 192 and 512 —
 * an SVG-only manifest is accepted by some browsers and silently rejected by
 * others, which is why the app was never installable despite declaring a
 * manifest. iOS ignores the manifest entirely and needs apple-touch-icon.png.
 *
 * `sharp` ships inside next's dependency tree already; no new package.
 *
 * Usage: node scripts/generate-pwa-icons.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const svg = await fs.readFile(path.join(publicDir, "icon.svg"));

/**
 * Maskable icons are cropped to a circle by the launcher, so the artwork has
 * to sit inside the safe zone (80% of the canvas). Padding the source rather
 * than redrawing it keeps one source of truth for the mark.
 */
async function render(size, file, { maskable = false } = {}) {
  const inner = maskable ? Math.round(size * 0.8) : size;
  const pad = Math.round((size - inner) / 2);
  const art = await sharp(svg, { density: 512 })
    .resize(inner, inner, { fit: "contain", background: "#0c0c0e" })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: "#0c0c0e",
    },
  })
    .composite([{ input: art, top: pad, left: pad }])
    .png()
    .toFile(path.join(publicDir, file));
  console.log(`wrote public/${file} (${size}x${size})`);
}

await render(192, "icon-192.png");
await render(512, "icon-512.png");
await render(512, "icon-maskable-512.png", { maskable: true });
await render(180, "apple-touch-icon.png");
