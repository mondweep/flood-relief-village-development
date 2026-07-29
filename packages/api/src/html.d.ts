/**
 * Lets TypeScript accept `import indexHtml from "…/index.html"`.
 *
 * The dashboard is shipped *inside* the server bundle rather than served from
 * disk: `npm run build` passes `--loader:.html=text` to esbuild, which inlines
 * the file's contents as a string default export. That keeps `dist/server.js` a
 * single self-contained artifact — the container image needs no static-file
 * directory, and there is no path traversal surface because there is no
 * filesystem read at request time.
 *
 * `tsc` knows nothing about esbuild loaders, hence this ambient declaration; the
 * matching resolution for Vitest lives in the root `vitest.config.ts`.
 */
declare module "*.html" {
  const content: string;
  export default content;
}

/**
 * The vendored map library (ADR 0012 §4), inlined into the server bundle as text
 * and served from `/map/leaflet.js` and `/map/leaflet.css` — our own origin, so
 * the page's Content-Security-Policy stays closed and no CDN enters the supply
 * chain.
 *
 * The `.txt` suffix is not cosmetic. A `declare module "*.js"` would match every
 * JavaScript import in the project and silently retype them all as strings, and
 * `--loader:.js=text` would stop esbuild bundling the API at all. A distinct
 * extension cannot collide with anything.
 *
 * WHY SERVED RATHER THAN INLINED INTO THE PAGE — a deviation from ADR 0012 §4,
 * recorded in that ADR. It estimated the page growing "from ~151 KB to ~200 KB";
 * the real figures are 147 KB of script and 15 KB of CSS against a 282 KB page,
 * so inlining makes it ~443 KB. That 58% is paid by every visitor to the public
 * transparency view, none of whom open a map. The same ADR says the map "should
 * load only when a capture flow is opened, not on first paint"; two routes are
 * how that happens without reintroducing an external host.
 */
declare module "*.txt" {
  const content: string;
  export default content;
}
