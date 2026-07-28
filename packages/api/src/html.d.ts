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
