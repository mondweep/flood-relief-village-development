import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Additive: teaches Vite/Vitest the one thing the production build already
 * knows. `npm run build` passes `--loader:.html=text` to esbuild so the API can
 * `import indexHtml from "…/index.html"` and ship the dashboard inside
 * `dist/server.js`; without an equivalent here, Vite would treat that import as
 * an HTML *entry point* and the API tests could not load the module at all.
 *
 * Scoped to `.html` and nothing else, so no other package's tests change
 * behaviour: none of them import HTML, and for them this plugin never fires.
 * `enforce: "pre"` puts it ahead of Vite's built-in HTML handling.
 */
const htmlAsText: Plugin = {
  name: "afrip:html-as-text",
  enforce: "pre",
  // Vite's own resolver leaves an unknown extension as a bare relative
  // specifier, so we resolve it against the importing module ourselves —
  // otherwise `load` below would be handed "../../../web/src/index.html" with
  // nothing to resolve it against.
  resolveId(source, importer) {
    if (!source.endsWith(".html") || importer === undefined) return null;
    if (!source.startsWith(".")) return null;
    return resolve(dirname(importer), source);
  },
  async load(id) {
    const file = id.split("?")[0] ?? id;
    if (!file.endsWith(".html")) return null;
    return `export default ${JSON.stringify(await readFile(file, "utf8"))};`;
  },
};

export default defineConfig({
  plugins: [htmlAsText],
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
