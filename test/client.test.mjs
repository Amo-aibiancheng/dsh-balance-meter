/**
 * Smoke test for the browser half.
 *
 * The client bundle is not a module the test runner can import: it is a
 * `window.__ModuleLoader__.load({ id, factory })` closure that expects the
 * shell's module table. This harness provides exactly that much of the shell —
 * a loader, a tiny React stand-in, the router's renderToString, and a DOM
 * Element API — and then asserts the package registers ONE additive entry into
 * the composer footer and renders the two numbers it exists for.
 *
 * It cannot prove the entry looks right on screen; it proves the bundle is
 * well-formed, registers through the documented seam, disposes cleanly, and
 * puts the right text in the right elements.
 *
 * @module dsh-balance-meter/test/client.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/* ------------------------------------------------------------------ *
 * A minimal React stand-in: enough for createElement + hooks.         *
 * ------------------------------------------------------------------ */

let hookCursor = 0
const hookState = []

function getSlot(index) {
  if (hookState[index] === undefined) hookState[index] = { value: undefined, cleanup: null }
  return hookState[index]
}

/** Set when a state update happens, so the harness can re-render like React would. */
let onStateChange = null

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = hookCursor++
    const slot = getSlot(index)
    if (slot.value === undefined) slot.value = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (value === slot.value) return
      slot.value = value
      onStateChange?.()
    }
    return [slot.value, set]
  },
  useRef(initial) {
    const index = hookCursor++
    const slot = getSlot(index)
    if (slot.value === undefined) slot.value = { current: initial }
    return slot.value
  },
  useEffect(effect) {
    const index = hookCursor++
    const slot = getSlot(index)
    slot.value = effect
  },
  useCallback(fn) {
    return fn
  },
}

/**
 * Render one slot component the way the shell does — hooks, then effects — and
 * let its pending state settle before returning the markup.
 *
 * @param {Function} component - the slot component.
 * @param {object} props - the slot's standard props.
 * @returns {Promise<string>} the settled markup.
 */
async function renderSettled(component, props) {
  hookCursor = 0
  hookState.length = 0
  let html = ''
  const render = () => {
    hookCursor = 0
    const tree = component(props)
    html = renderToString(tree)
  }
  onStateChange = render
  render()
  // Effects: run every one this render registered, in order.
  for (const slot of hookState) {
    if (typeof slot?.value === 'function') {
      const cleanup = slot.value()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }
  // Let the fetch promises and their state updates land, re-rendering each time.
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  onStateChange = null
  for (const slot of hookState) {
    if (typeof slot?.cleanup === 'function') slot.cleanup()
  }
  return html
}

/** Render a React-shaped tree to a plain string, attributes included. */
function renderToString(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderToString).join('')
  if (typeof node.type === 'function') return renderToString(node.type(node.props))
  if (node.type === React.Fragment) return node.children.map(renderToString).join('')
  if (typeof node.type !== 'string') return ''
  const attrs = Object.entries(node.props ?? {})
    .filter(([key]) => key !== 'children' && /^[a-z-]+$/.test(key))
    .map(([key, value]) => ` ${key}="${String(value)}"`)
    .join('')
  return `<${node.type}${attrs}>${node.children.map(renderToString).join('')}</${node.type}>`
}

/** Walk the tree and return every element matching one predicate. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}

/* ------------------------------------------------------------------ *
 * A minimal DOM, enough for the style tag and the placement effect.   *
 * ------------------------------------------------------------------ */

function createDom() {
  const head = []
  const listeners = new Map()
  const element = () => ({
    dataset: {},
    style: {},
    children: [],
    textContent: '',
    appendChild(child) {
      this.children.push(child)
    },
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, right: 120, top: 0, bottom: 20, width: 120, height: 20 }),
  })
  globalThis.document = {
    head: { appendChild: (tag) => head.push(tag) },
    body: element(),
    createElement: () => element(),
    // The plugin tags its stylesheet so a hot reload can tell whether it is
    // already installed; the harness answers that question against `head`.
    querySelector: (selector) => {
      const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
      if (match === null) return null
      return head.find((tag) => tag.dataset?.pluginCss === match[1]) ?? null
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    visibilityState: 'visible',
  }
  globalThis.window = {
    innerWidth: 1400,
    innerHeight: 900,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.Intl = Intl
  return { head, listeners }
}

/* ------------------------------------------------------------------ *
 * The shell's module table + loader.                                  *
 * ------------------------------------------------------------------ */

/** Records what the client half asked the shell for. */
const required = []

/**
 * Install the loader facade and evaluate the client bundle in this realm.
 *
 * @returns {Promise<{ exports: object, registered: object[], head: object[], listeners: Map<string, Function>, footer: object }>} the harness state.
 */
async function loadClientBundle() {
  const dom = createDom()
  /** @type {object[]} */
  const registered = []
  /** @type {object[]} */
  const slotsWaits = []
  /** @type {object[]} */
  const effects = []

  const slots = {
    inject(key, callback) {
      slotsWaits.push({ key, callback })
      const effect = callback()
      return typeof effect === 'function' ? effect : () => {}
    },
    register(descriptor, component) {
      registered.push({ descriptor, component })
      return () => {
        registered.pop()
      }
    },
  }

  const ctx = {
    slots,
    inject(services, callback) {
      for (const service of services) assert.equal(service, 'slots')
      callback(ctx)
    },
    effect(callback) {
      const disposer = callback()
      effects.push(disposer)
      return () => {}
    },
    locale: { register: () => () => {} },
    get: () => undefined,
  }
  ctx.slots = slots

  const source = await readFile(CLIENT_PATH, 'utf8')
  let captured = null
  globalThis.window.__ModuleLoader__ = {
    load(spec) {
      captured = spec
    },
  }
  // Evaluate in this realm: the bundle touches `window`, `document` and the
  // module table, all of which the harness above provides.
  // eslint-disable-next-line no-new-func
  new Function(source)()
  assert.notEqual(captured, null, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-balance-meter')

  const exports = captured.factory((name) => {
    required.push(name)
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconGaugeOutline16: (props) => React.createElement('svg', props) }
    throw new Error(`unexpected require("${name}")`)
  })

  exports.apply(ctx)
  return { exports, registered, head: dom.head, listeners: dom.listeners, effects }
}

/* ------------------------------------------------------------------ *
 * The cases.                                                          *
 * ------------------------------------------------------------------ */

test('the bundle is a well-formed module-loader closure', async () => {
  const { exports, registered, head } = await loadClientBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(exports.name, 'dsh-balance-meter')
  assert.equal(typeof exports.BalanceChip, 'function')
  assert.deepEqual(required, ['react', '@deepseek-ai/dsh-client-ui-primitives'])
  // The stylesheet is installed by the first render, exactly like the shipped
  // entries do it: one tagged <style>, never a second copy.
  await renderSettled(registered[0].component, { sessionId: 's1' })
  assert.equal(head.length, 1, 'exactly one stylesheet is installed')
  assert.match(head[0].textContent, /\.dshbm_pill/)
})

test('it registers one additive entry in the composer footer', async () => {
  const { registered } = await loadClientBundle()
  assert.equal(registered.length, 1)
  const { descriptor, component } = registered[0]
  assert.equal(descriptor.name, 'conversation.composer.dock')
  assert.equal(descriptor.id, 'balance-meter')
  assert.equal(descriptor.order, 20, 'the shipped stats entry keeps order 0')
  assert.equal(typeof component, 'function')
})

test('the entry renders the two numbers it exists for', async () => {
  const { registered } = await loadClientBundle()
  const { component } = registered[0]

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      config: { pollIntervalMs: 45000, showTokenCrossCheck: true },
      balance: { paid: 4.56, bonus: 0, currency: 'CNY', wallets: { CNY: { paid: 4.56, bonus: 0 } }, updatedAt: Date.now(), ageMs: 900, error: null },
      session: { sessionId: 's1', createdMs: Date.now() - 60_000, baseline: { time: Date.now() - 60_000, currency: 'CNY', paid: 4.773 }, baselineSource: 'session-start', partial: false, observed: true, spend: 0.213, topUp: 0, sampleCount: 3, windowMs: 60_000, readingCount: 4 },
      crossCheck: { cost: 0.198, currency: 'CNY', tokens: { total: 12345 } },
      ledger: { readingCount: 4, sessionCount: 1 },
      serverTime: Date.now(),
    }),
  })

  const html = await renderSettled(component, { sessionId: 's1' })
  assert.match(html, /余额 /)
  assert.match(html, /本次 /)
  assert.match(html, /¥4\.56/, 'the wallet balance is formatted as CNY')
  assert.match(html, /¥0\.213/, 'the measured session spend is formatted')
  assert.match(html, /data-balance-meter="true"/)
  assert.match(html, /aria-haspopup="dialog"/)
  assert.doesNotMatch(html, /NaN/)
})

test('a session with no sample yet says so instead of claiming zero', async () => {
  const { registered } = await loadClientBundle()
  const { component } = registered[0]
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      config: { pollIntervalMs: 45000, showTokenCrossCheck: true },
      balance: { paid: 4.56, bonus: 0, currency: 'CNY', wallets: {}, updatedAt: Date.now(), ageMs: 1, error: null },
      session: { sessionId: 's1', createdMs: Date.now(), baseline: null, baselineSource: 'none', partial: false, observed: false, spend: 0, topUp: 0, sampleCount: 0, windowMs: 0, readingCount: 0 },
      crossCheck: null,
      ledger: { readingCount: 0, sessionCount: 1 },
      serverTime: Date.now(),
    }),
  })
  const html = await renderSettled(component, { sessionId: 's1' })
  assert.match(html, /待采样/)
})

test('a failing host route degrades to placeholders, not a crash', async () => {
  const { registered } = await loadClientBundle()
  const { component } = registered[0]
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  const html = await renderSettled(component, { sessionId: 's1' })
  assert.match(html, /--/, 'unreadable money renders as a placeholder')
  assert.doesNotMatch(html, /NaN/)
})
