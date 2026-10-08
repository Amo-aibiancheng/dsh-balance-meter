/**
 * Smoke test for the Host half.
 *
 * The host plugin is a Cordis row: `apply(ctx, config)` consumes `webServer` and
 * `deepseekAccount`. This harness supplies exactly those two services plus the
 * `ctx.get` lookups the plugin makes, then drives the registered routes the way
 * the browser would. It proves the wiring the algorithm tests cannot: that the
 * routes exist, that a provider read becomes a Session measurement, and that a
 * signed-out or broken account degrades to a reported error instead of a throw.
 *
 * @module dsh-balance-meter/test/host.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject } from '../src/index.js'
import * as hostModule from '../src/index.js'

/**
 * Build a fake host context, apply the plugin, and return the wire surface.
 *
 * @param {object} [options] - harness knobs.
 * @param {object | null} [options.balance] - the `getBalance` result (`null` = signed out).
 * @param {Error} [options.throws] - make `getBalance` reject with this error instead.
 * @param {object} [options.config] - config override for the row.
 * @returns {{ routes: Map<string, Function>, ctx: object, listeners: Map<string, Function[]>, feed: Function, dispose: Function }} the harness.
 */
function mountHost(options = {}) {
  /** @type {Map<string, Function>} */
  const routes = new Map()
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  const effects = []
  let disposed = false
  // One stable account face whose behavior each test can replace. Swapping the
  // whole object would not work: the plugin resolves the service ONCE per read
  // and holds the reference for that call only, exactly like the real shell.
  let currentBalance = options.balance
  let currentThrows = options.throws
  const account = {
    async getBalance() {
      if (currentThrows !== undefined) throw currentThrows
      return currentBalance === undefined
        ? { status: 'ready', value: [{ currency: 'CNY', balance: '10' }], bonusWallets: [] }
        : currentBalance
    },
  }

  const ctx = {
    effect(callback) {
      const cleanup = callback()
      effects.push(cleanup)
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    get(name) {
      if (name === 'deepseekAccount') return account
      if (name === 'sessions') {
        return { get: (id) => (id === 'known' ? { header: { createdAt: 1_000_000 } } : undefined) }
      }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
    webServer: {
      register(route) {
        assert.equal(routes.has(`${route.kind}:${route.path}`), false, `duplicate route ${route.path}`)
        routes.set(`${route.kind}:${route.path}`, route.handler)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    },
  }

  apply(ctx, options.config ?? {})

  return {
    routes,
    ctx,
    listeners,
    /** Replace what the provider reports on the NEXT read. */
    setBalance(balance) {
      currentBalance = balance
      currentThrows = undefined
    },
    /** Make the next provider read reject. */
    setFailure(error) {
      currentThrows = error
    },
    /** Emit one durable Session event into the plugin's listener. */
    feed(session, event) {
      for (const handler of listeners.get('session/event') ?? []) handler(session, event)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const cleanup of effects.splice(0)) {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
}

/**
 * Drive one registered route.
 *
 * @param {object} harness - the harness from {@link mountHost}.
 * @param {string} path - the route path.
 * @param {string} [search] - query string, leading `?` included.
 * @returns {Promise<{ status: number, body: any }>} the response.
 */
async function call(harness, path, search = '') {
  const handler = harness.routes.get(`exact:${path}`)
  assert.equal(typeof handler, 'function', `route ${path} must be registered`)
  let status = 0
  let payload = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(body) {
      payload = body
    },
  }
  await handler({ url: `${path}${search}`, method: 'GET' }, res)
  return { status, body: JSON.parse(payload) }
}

/**
 * Mount the plugin for one test and guarantee its background poll is torn down.
 *
 * The plugin arms a real `setTimeout` chain (the observation loop), which would
 * keep the test process alive after the assertions finish. Registration through
 * the test context is what makes the teardown unconditional.
 *
 * @param {object} t - the node:test context.
 * @param {object} [options] - harness knobs, as {@link mountHost}.
 * @returns {object} the harness.
 */
function mountFor(t, options = {}) {
  const harness = mountHost(options)
  t.after(() => harness.dispose())
  return harness
}

test('the row declares the services it consumes', () => {
  assert.deepEqual(inject, ['webServer', 'deepseekAccount'])
  // The module must not export `Config`: the loader validates that export by
  // calling `.validate()` on it, so a plain object of defaults would crash the
  // row at load time (see the real-cordis test in load.test.mjs).
  assert.equal('Config' in hostModule, false)
})

test('both routes are registered on mount and removed on dispose', (t) => {
  const harness = mountFor(t)
  assert.equal(harness.routes.size, 2)
  assert.ok(harness.routes.has('exact:/dsh-balance-meter/status'))
  assert.ok(harness.routes.has('exact:/dsh-balance-meter/refresh'))
  harness.dispose()
  assert.equal(harness.routes.size, 0)
})

test('status turns a provider read into a session measurement', async (t) => {
  // anomalyRatio 1 keeps the account-event guard out of the way: this case is
  // about the delta arithmetic, and the guard has its own cases below.
  const harness = mountFor(t, { config: { anomalyRatio: 1 } })
  // One session event so the cross-check has something to price.
  harness.feed({ id: 'known', header: { createdAt: 1_000_000 } }, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 } },
  })

  const first = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.balance.currency, 'CNY')
  assert.equal(first.body.balance.paid, 10, 'the first read is the mocked starting balance')
  assert.equal(first.body.balance.error, null)
  assert.equal(first.body.session.spend, 0)
  assert.equal(first.body.config.pollIntervalMs, 45000)

  // The provider balance drops; the next forced read must produce a measurement.
  harness.setBalance({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '9.7870' }],
    bonusWallets: [],
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const refreshed = await call(harness, '/dsh-balance-meter/refresh', '?session=known')
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.ok, true)
  assert.equal(refreshed.body.balance.error, null, 'the provider read succeeded')
  assert.ok(Math.abs(refreshed.body.session.spend - 0.213) < 1e-9, `the delta becomes the session spend (got ${String(refreshed.body.session.spend)})`)
  assert.ok(Math.abs(refreshed.body.balance.paid - 9.787) < 1e-9)
  assert.notEqual(refreshed.body.crossCheck, null, 'the token cross-check is published')
  assert.ok(Math.abs(refreshed.body.crossCheck.cost - 3) < 1e-9, '1M miss at 3 CNY/M')
})

test('a session id the store does not know still measures', async (t) => {
  const harness = mountFor(t)
  const response = await call(harness, '/dsh-balance-meter/status', '?session=stranger')
  assert.equal(response.status, 200)
  assert.equal(response.body.session.sessionId, 'stranger')
  assert.equal(response.body.session.spend, 0)
})

test('a signed-out account is reported, not thrown', async (t) => {
  const harness = mountFor(t, { balance: null })
  const response = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.balance.paid, null)
  assert.equal(response.body.balance.error.code, 'SIGNED_OUT')
  assert.equal(response.body.session.spend, 0)
})

test('a provider failure is reported with its code', async (t) => {
  const harness = mountFor(t, { throws: new Error('boom') })
  const response = await call(harness, '/dsh-balance-meter/status')
  assert.equal(response.status, 200)
  assert.equal(response.body.balance.error.code, 'PROVIDER')
  assert.match(response.body.balance.error.message, /boom/)
  assert.equal(response.body.session, null, 'no session id means no session block')
})

test('a withdrawn balance read keeps the last known numbers as stale data', async (t) => {
  const harness = mountFor(t, { config: { anomalyRatio: 1 } })
  await call(harness, '/dsh-balance-meter/status', '?session=known')
  harness.setBalance({ status: 'failed' })
  const response = await call(harness, '/dsh-balance-meter/refresh', '?session=known')
  assert.equal(response.body.balance.error.code, 'BALANCE_FAILED')
  assert.equal(response.body.balance.error.stale.paid, 10, 'the panel can still show what was last known')
})

test('the account-event guard is applied by default', async (t) => {
  // The shipped default is 0.5: a drop of more than half the wallet is treated
  // as an account event rather than one Session's token bill.
  const harness = mountFor(t)
  await call(harness, '/dsh-balance-meter/status', '?session=known')
  harness.setBalance({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '0.5' }],
    bonusWallets: [],
  })
  const response = await call(harness, '/dsh-balance-meter/refresh', '?session=known')
  assert.equal(response.body.session.spend, 0, '95% of the wallet is not one turn')
})

test('the recharge wallet headlines and the bonus is never summed into it', async (t) => {
  // The shipped account card shows 充值余额 and 赠金余额 on separate lines, so the
  // footer must not add them up: the delta arithmetic runs on the recharge
  // wallet alone, and the two remain distinct in the payload.
  const harness = mountFor(t, {
    balance: {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '4.56' }],
      bonusWallets: [{ currency: 'CNY', balance: '1.00' }],
    },
  })
  const response = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.equal(response.body.balance.paid, 4.56)
  assert.equal(response.body.balance.bonus, 1)
  assert.notEqual(response.body.balance.paid, 5.56, 'the headline is the recharge wallet only')
  assert.deepEqual(response.body.balance.wallets.CNY, { paid: 4.56, bonus: 1 })
})

test('token accounting ignores unrelated events and is dropped with the session', async (t) => {
  const harness = mountFor(t)
  harness.feed({ id: 'known', header: { createdAt: 1_000_000 } }, { type: 'turn/start', data: {} })
  harness.feed({ id: 'known', header: { createdAt: 1_000_000 } }, { type: 'assistant/message', data: {} })
  harness.feed({ id: 'known', header: { createdAt: 1_000_000 } }, { type: 'assistant/message', data: { usage: { inputTokens: 10 } } })
  const priced = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.notEqual(priced.body.crossCheck, null)
  assert.equal(priced.body.crossCheck.tokens.total, 10)

  for (const handler of harness.listeners.get('session/disposed') ?? []) handler({ id: 'known' })
  const afterDisposal = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.equal(afterDisposal.body.crossCheck, null, 'a disposed session keeps no accounting')
})

test('a config edit is clamped instead of reaching the provider unchecked', async (t) => {
  const config = { pollIntervalMs: 1, requestTimeoutMs: 'nonsense', anomalyRatio: 9, showTokenCrossCheck: false, price: { currency: 'usd', cacheHit: -1, cacheMiss: 2, output: 4 } }
  const harness = mountFor(t, { config })
  const response = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.equal(response.body.config.pollIntervalMs, 5000, 'clamped up to the floor')
  assert.equal(response.body.config.showTokenCrossCheck, false)
  assert.equal(response.body.crossCheck, null)
})
