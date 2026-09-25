import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const shim = (file: string) => path.join(root, "src", "shims", file);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "VITE_");
  const apiTarget =
    process.env.VITE_API_PROXY || env.VITE_API_PROXY || "http://127.0.0.1:5100";

  return {
    plugins: [react(), tailwindcss()],
    // Tailwind runs through its Vite plugin. An inline config stops Vite from walking up to the
    // Next app's postcss.config.mjs, which needs the root node_modules.
    css: { postcss: {} },
    resolve: {
      alias: [
        { find: /^next\/link$/, replacement: shim("next-link.tsx") },
        { find: /^next\/navigation$/, replacement: shim("next-navigation.ts") },
        { find: /^next\/image$/, replacement: shim("next-image.tsx") },
        { find: /^next\/font\/google$/, replacement: shim("next-font-google.ts") },
        { find: /^@\//, replacement: `${path.join(root, "src")}/` },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, ws: true },
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, ws: true },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: true,
      chunkSizeWarningLimit: 1500,
    },
  };
});
