/**
 * Build recipe — two targets, two very different contracts.
 *
 * HOST (`lib/index.js`, ESM). The catalogue loads this in Node, so it is a
 * normal ES module with the package's real dependency (`@deepseek-ai/schemastery`)
 * left external for Node to resolve. Its `dependencies`/`peerDependencies` are
 * the whole runtime surface.
 *
 * CLIENT (`lib/client.js`, CommonJS inside a wrapper). The harness does not load
 * a client bundle as a module: it evaluates the file and expects exactly one
 * `window.__ModuleLoader__.load({ id, factory })` call, whose factory is a
 * CommonJS-style function receiving the shell's module table as `require`. So
 * this target emits CommonJS and wraps it. The wrapper has to live in
 * `outputOptions.banner`/`footer`, not the top-level options: rendering happens
 * in two layers, and only the output layer's banner REPLACES rolldown's own
 * CommonJS prelude — the top-level one lands after it, leaving a duplicate
 * `toStringTag` line and an `exports` that was never created.
 *
 * `deps.neverBundle` is the other half of the client contract: `react`,
 * `react/jsx-runtime` and the `@deepseek-ai/*` packages must stay bare
 * `require()` calls for the shell to resolve from its own static module table.
 * Bundling a second copy of React into the plugin would break hooks across that
 * boundary.
 */
import { defineConfig } from 'tsdown'

/** The package name the loader and the shell's module table key on. */
const PACKAGE_ID = 'dsh-balance-meter'

/** The host half: a plain Node ES module. */
const host = defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  fixedExtension: false,
  outputOptions: { entryFileNames: 'index.js' },
})

/** The browser half: CommonJS wrapped in the module-loader closure. */
const client = defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: [/^react($|\/)/, /^react-dom($|\/)/, /^@deepseek-ai\//] },
  // The loader fetches `/plugins/<id>/client.js` per the manifest.
  fixedExtension: false,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: [
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(PACKAGE_ID)},`,
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
    ].join('\n'),
    footer: '\t\treturn module.exports;\n\t}\n});',
  },
})

export default [host, client]
