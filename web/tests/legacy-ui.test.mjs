import { after, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const spaSrc = path.resolve("src").replaceAll("\\", "/");
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  plugins: [{
    name: "spa-unit-tests",
    enforce: "pre",
    transform(code, id) {
      const file = id.replaceAll("\\", "/");
      if (file.endsWith("/web/src/app/downloads/season-selection.ts")) {
        return code.replace("function defaultSeasonKey", "export function defaultSeasonKey");
      }
      return null;
    },
  }],
  server: { middlewareMode: true, watch: null, hmr: false, ws: false, fs: { allow: [process.cwd()] } },
});
after(() => server.close());

for (const file of [
  "components/title/add-to-library-questions.test.ts",
  "app/downloads/season-selection.test.ts",
]) {
  test(`existing UI regressions: ${file}`, async () => {
    await server.ssrLoadModule(`/@fs/${spaSrc}/${file}`);
  });
}
