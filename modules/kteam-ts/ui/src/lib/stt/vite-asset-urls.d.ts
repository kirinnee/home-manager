// Ambient types for Vite's `?url` asset imports.
//
// This app does not reference `vite/client` anywhere (nothing needed it until
// now), and adding it to `tsconfig.app.json` would pull Vite's whole ambient
// surface — `import.meta.env`, every `?raw`/`?worker`/`?inline` form, the CSS
// module shims — into a codebase that has deliberately never used any of it.
// So the ONE form this feature needs is declared here, in the directory that
// needs it, and nothing else changes.
//
// `?url` resolves at build time to the fingerprinted asset URL; at dev time to
// the served path. Both are strings, and neither is known to `tsc`.

declare module '*?url' {
  const url: string;
  export default url;
}
