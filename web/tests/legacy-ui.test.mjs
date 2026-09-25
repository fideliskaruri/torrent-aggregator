import { after, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const legacyRoot = path.resolve("..", "src").replaceAll("\\", "/");
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  plugins: [{
    name: "legacy-tests-against-spa",
    enforce: "pre",
    transform(code, id) {
      const file = id.replaceAll("\\", "/");
      if (file.endsWith("/web/src/app/downloads/season-selection.ts")) {
        return code.replace("function defaultSeasonKey", "export function defaultSeasonKey");
      }
      if (!file.startsWith(`${legacyRoot}/`) || !file.endsWith(".test.ts")) return;
      const directory = path.posix.dirname(file.slice(legacyRoot.length + 1));
      // Reuse existing behavioral tests against the SPA modules, not the old app.
      return code.replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_match, quote, source) =>
        `from ${quote}@/${path.posix.normalize(`${directory}/${source}`)}${quote}`);
    },
  }],
  server: { middlewareMode: true, watch: null, hmr: false, ws: false, fs: { allow: [path.resolve("..")] } },
});
after(() => server.close());

for (const file of [
  "components/title/add-to-library-questions.test.ts",
  "app/downloads/season-selection.test.ts",
]) {
  test(`existing UI regressions: ${file}`, async () => {
    await server.ssrLoadModule(`/@fs/${legacyRoot}/${file}`);
  });
}
