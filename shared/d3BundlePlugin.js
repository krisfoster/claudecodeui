import { createRequire } from 'node:module'
import path from 'node:path'

const VIRTUAL_ID = 'd3-bundle-source'

// D3Sandbox inlines d3's browser bundle as text into a sandboxed iframe. Its
// package.json "exports" map only defines the bare "." specifier (and even
// rejects "./package.json" as a subpath), so nothing under `d3/dist/...` can
// be imported directly. A plain `resolve.alias` doesn't help either: Vite's
// alias matching compares the specifier including its query string, so an
// alias for `d3-bundle-source` never matches `d3-bundle-source?raw`.
//
// This plugin resolves that one virtual id (with or without a query) to the
// real file path instead, letting Vite's own `?raw`/`?url` handling take
// over from there since the id is now a normal absolute path.
export function d3BundlePlugin() {
  const require = createRequire(import.meta.url)
  // The only specifier the exports map allows is "d3" itself, which
  // `require` resolves to .../d3/src/index.js — walk back up to the
  // package root and join the dist bundle from there.
  const packageRoot = path.dirname(path.dirname(require.resolve('d3')))
  const bundlePath = path.join(packageRoot, 'dist', 'd3.min.js')

  return {
    name: 'd3-bundle-source',
    resolveId(id) {
      if (id === VIRTUAL_ID) {
        return bundlePath
      }
      if (id.startsWith(`${VIRTUAL_ID}?`)) {
        return bundlePath + id.slice(VIRTUAL_ID.length)
      }
      return null
    },
  }
}
