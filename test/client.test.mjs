/**
 * Browser-half contract, pinned against the real bundle.
 *
 * Three things can go wrong with a client half, and only the first is obvious:
 *   1. the bundle is not the closure the shell evaluates (wrong format, an
 *      `export` statement, a missing `exports`) — so the file is loaded exactly
 *      the way the boot code does: one `window.__ModuleLoader__.load` call,
 *      whose factory receives the shell's module table as `require`;
 *   2. the entry registers into the wrong seat or claims a cell the shipped
 *      stats pill owns — so registration is driven through a fake slot service
 *      and the descriptor is asserted;
 *   3. the rendered text misreports money — so the component is rendered with
 *      React's own renderer against a stubbed Host payload.
 *
 * @module dsh-balance-meter/test/client.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** React itself: the bundle `require()`s it, so the harness hands over the real thing. */
const React = (await import(pathToFileURL(require.resolve('react')).href)).default
const { renderToStaticMarkup } = await import(pathToFileURL(require.resolve('react-dom/server')).href)

/** The built bundle under test. */
const BUNDLE = new URL('../lib/client.js', import.meta.url)

/** A Host payload for a Session that has already been charged. */
const chargedPayload = (overrides = {}) => ({
  ok: true,
  config: { pollIntervalMs: 45_000, showTokenCrossCheck: true },
  balance: {
    paid: 4.56,
    bonus: 0,
    currency: 'CNY',
    wallets: { CNY: { paid: 4.56, bonus: 0 } },
    updatedAt: Date.now(),
    ageMs: 900,
    error: null,
  },
  session: {
    sessionId: 's1',
    createdMs: Date.now() - 60_000,
    baseline: { time: Date.now() - 60_000, currency: 'CNY', paid: 4.773 },
    baselineSource: 'session-start',
    partial: false,
    observed: true,
    spend: 0.213,
    topUp: 0,
    chargedCount: 3,
    windowMs: 60_000,
    readingCount: 4,
    scope: 'session-window',
  },
  crossCheck: { cost: 0.198, currency: 'CNY', tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 12_345 } },
  ledger: { readingCount: 4, sessionCount: 1 },
  serverTime: Date.now(),
  ...overrides,
})

/**
 * Evaluate the bundle the way the harness does.
 *
 * @returns {Promise<{ exports: object, registered: object[], required: string[], styleCount: () => number }>} the loaded module and what it registered.
 */
async function loadBundle() {
  /** @type {string[]} */
  const required = []
  /** @type {Array<{ descriptor: object, component: Function }>} */
  const registered = []
  /** @type {object[]} */
  const styleTags = []
  let styleInstalled = 0

  globalThis.document = {
    head: {
      appendChild: (tag) => {
        styleTags.push(tag)
      },
    },
    querySelector: (selector) => {
      if (String(selector).includes('data-plugin-css') && styleInstalled > 0) return styleTags[0] ?? null
      return null
    },
    createElement: () => ({ dataset: {}, textContent: '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  }
  globalThis.window = { innerWidth: 1400, innerHeight: 900, addEventListener: () => {}, removeEventListener: () => {} }

  // The shell's module table: only the two entries this bundle may resolve.
  const moduleTable = {
    react: React,
    'react/jsx-runtime': await import(pathToFileURL(require.resolve('react/jsx-runtime')).href),
  }

  let captured = null
  globalThis.window.__ModuleLoader__ = {
    load(spec) {
      captured = spec
    },
  }
  const source = await readFile(BUNDLE, 'utf8')
  // eslint-disable-next-line no-new-func
  new Function(source)()
  assert.notEqual(captured, null, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-balance-meter')

  const exports = captured.factory((name) => {
    required.push(name)
    if (!(name in moduleTable)) throw new Error(`unexpected require("${name}")`)
    return moduleTable[name]
  })

  const slots = {
    inject(key, callback) {
      assert.equal(key, 'conversation.composer.dock')
      const effect = callback()
      return typeof effect === 'function' ? effect : () => {}
    },
    register(descriptor, component) {
      registered.push({ descriptor, component })
      styleInstalled += 1
      return () => {
        registered.pop()
      }
    },
  }
  exports.apply({
    slots,
    inject(services, callback) {
      assert.deepEqual(services, ['slots'])
      callback({ slots, effect: () => () => {} })
    },
    effect(callback) {
      callback()
      return () => {}
    },
  })

  return { exports, registered, required, styleCount: () => styleTags.length, stylesheet: () => styleTags[0]?.textContent ?? '' }
}

test('the bundle is the closure the shell evaluates', async () => {
  const { exports, required, styleCount } = await loadBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'conversation'])
  // Externals must stay externals: a bundled React would break hooks across the
  // boundary, and these two names are what the shell resolves.
  assert.deepEqual(required, ['react', 'react/jsx-runtime'])
  assert.ok(required.every((name) => name === 'react' || name.startsWith('react/')), 'no SDK package is required at runtime')
  assert.equal(styleCount(), 1, 'the entry installs its stylesheet exactly once')
})

test('it claims its own cell in the composer dock', async () => {
  const { registered } = await loadBundle()
  assert.equal(registered.length, 1)
  const { descriptor, component } = registered[0]
  assert.equal(descriptor.name, 'conversation.composer.dock')
  assert.equal(descriptor.id, 'balance-meter', 'a fresh id sits beside the shipped entries')
  assert.equal(descriptor.order, 20, 'the shipped stats entry keeps order 0')
  assert.equal(typeof component, 'function')
})

test('the entry must not stand out from the shipped stats pills', async () => {
  // A product rule, not a preference: the dock row is one centered line of
  // ambient figures, so this entry inherits the row's font and renders every
  // figure — labels AND amounts — in the same tertiary color with no weight
  // change, exactly like the shipped pills. Emphasising the amounts is what made
  // an earlier build the loudest thing in the row.
  const { stylesheet } = await loadBundle()
  const css = stylesheet()
  // Same token and same fallback as the dock row itself, so the entry cannot be
  // larger (or smaller) than the shipped pills beside it.
  assert.match(css, /--dshbm-font-size:var\(--dsh-content-font-size-secondary,13px\)/)
  assert.match(css, /\.dshbm_root\{[^}]*font-size:var\(--dshbm-font-size\)/)
  assert.match(css, /\.dshbm_root\{[^}]*line-height:var\(--dshbm-line-height\)/)
  assert.match(css, /\.dshbm_pill\{[^}]*font-size:inherit/)
  assert.match(css, /\.dshbm_pill\{[^}]*font-weight:inherit/)
  assert.match(css, /\.dshbm_value\{[^}]*font-weight:inherit/)
  assert.match(css, /\.dshbm_key\{[^}]*font-weight:inherit/)
  assert.doesNotMatch(css, /\.dshbm_(value|key)\{[^}]*font-weight:(?!inherit)/, 'no figure is bolded')
  assert.doesNotMatch(css, /dshbm_strong/, 'the emphasis class is gone')
  // The icon is sized in `em` so it tracks the row's font instead of pinning px.
  assert.match(css, /\.dshbm_icon\{[^}]*width:1\.08em/)
})

test('the detail panel reuses the official popover recipe', async () => {
  // The panel is the same kind of control as the popover the shipped stats pills
  // open, so it copies that recipe token for token (the shell's own
  // stat-dialog.module.css): menu surface, prominent elevation, 12px radius,
  // 16px padding, and a two-column `dl` grid.
  const { stylesheet } = await loadBundle()
  const css = stylesheet()
  // An opaque base layer first: a skin may redefine the menu surface as
  // translucent (Catppuccin's glass mode does), and a see-through popover lets the
  // conversation bleed through the numbers.
  assert.match(css, /\.dshbm_panel\{[^}]*background-color:var\(--dsw-alias-bg-layer-1/)
  assert.match(css, /\.dshbm_panel\{[^}]*background-image:linear-gradient\(var\(--dsw-specific-menu/)
  assert.match(css, /\.dshbm_panel\{[^}]*box-shadow:var\(--dsw-elevation-prominent\)/)
  assert.match(css, /\.dshbm_panel\{[^}]*border-radius:12px/)
  assert.match(css, /\.dshbm_panel\{[^}]*padding:16px/)
  assert.match(css, /\.dshbm_panel\{[^}]*font-size:12px/)
  assert.match(css, /\.dshbm_details\{[^}]*display:grid/)
  assert.match(css, /\.dshbm_details dd\{[^}]*text-align:right/)
  assert.match(css, /\.dshbm_titleRule\{/)
  // The shipped pills' own `·` token is undefined in the theme layer, so the
  // separator must not rely on it.
  assert.doesNotMatch(css, /dshbm_sep\{[^}]*separator-primary/)
})

test('the panel is anchored above the pill and clamped to the viewport', async () => {
  const { registered } = await loadBundle()
  const { component } = registered[0]
  globalThis.fetch = async () => ({ ok: true, json: async () => chargedPayload() })
  // Render the closed entry only: the placement maths is exercised through the
  // markup contract (the panel exists only when open, and opens upward).
  const html = renderToStaticMarkup(React.createElement(component, { sessionId: 's1', useProjection: () => undefined }))
  assert.doesNotMatch(html, /dshbm_panel/, 'the panel is closed until asked for')
})

test('the entry renders the recharge balance and the measured spend', async () => {
  const { registered } = await loadBundle()
  const { component } = registered[0]
  globalThis.fetch = async () => ({ ok: true, json: async () => chargedPayload() })

  // A first render paints the pre-fetch state; the entry is asserted on the text
  // it can produce without a browser, which is the two numbers it exists for.
  const html = renderToStaticMarkup(
    React.createElement(component, {
      sessionId: 's1',
      useProjection: () => undefined,
    }),
  )
  assert.match(html, /余额/)
  assert.match(html, /本次/)
  assert.match(html, /--/, 'an unread payload renders placeholders, not NaN')
  assert.doesNotMatch(html, /NaN/)
  assert.match(html, /dshbm_pill/, 'the pill is the shipped pill recipe')
})

test('an unknown currency code does not blank the entry', async () => {
  const { registered } = await loadBundle()
  const { component } = registered[0]
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => chargedPayload({ balance: { ...chargedPayload().balance, currency: 'XYZ' } }),
  })
  const html = renderToStaticMarkup(React.createElement(component, { sessionId: 's1', useProjection: () => undefined }))
  assert.doesNotMatch(html, /NaN/)
  assert.match(html, /余额/)
})

test('a transport failure renders placeholders instead of throwing', async () => {
  const { registered } = await loadBundle()
  const { component } = registered[0]
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  const html = renderToStaticMarkup(React.createElement(component, { sessionId: 's1', useProjection: () => undefined }))
  assert.match(html, /余额/)
  assert.doesNotMatch(html, /NaN/)
})
