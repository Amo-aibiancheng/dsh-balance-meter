/**
 * Host-half activation, pinned against a real cordis application.
 *
 * The interesting failures in a DSH plugin are not in its logic — they are in
 * its contract with the loader, and this file is about exactly that:
 *   - the module must export a `Config` the loader can RESOLVE (it calls the
 *     schema; a plain object of defaults makes the entry fail to import, which is
 *     how the first version of this plugin died);
 *   - `inject` must name services that exist in the shipped Host;
 *   - both routes must register through the injected face and be released with
 *     the fiber;
 *   - a signed-out or failing account must come back as a reported error, never
 *     as a thrown exception out of a route handler.
 *
 * It drives the BUILT module (`lib/index.js`), so a broken build fails here
 * rather than in the browser.
 *
 * @module dsh-balance-meter/test/host.test
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * Leave once every test has settled.
 *
 * Mounting a real cordis app installs fiber-scoped machinery (services, effects,
 * the timer plugin's internals) that can keep a handle open past teardown, and a
 * test runner waiting on the loop would hang even though every assertion passed.
 * Teardown is asserted explicitly inside the tests; this only ends the process.
 */
after(() => {
  setImmediate(() => {
    process.exit(0)
  })
})

const require = createRequire(import.meta.url)

/** The built host module under test. */
const host = await import(pathToFileURL(require.resolve('../lib/index.js')).href)

/** The SDK's cordis, resolved from this package's own devDependencies. */
const { Context, Service } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)

/**
 * Build a real cordis app with the two services this plugin injects.
 *
 * `Service` subclasses, not plain objects: cordis rejects a bare property write,
 * which is what makes this an activation test rather than a stub.
 *
 * The plugin arms a real observation loop (a `setTimeout` chain), so every mount
 * is registered for teardown through the test context — otherwise the loop keeps
 * the process alive after the assertions finish.
 *
 * @param {object} t - the node:test context.
 * @param {object} [options] - harness knobs.
 * @param {object | null} [options.balance] - the `getBalance` result.
 * @param {Error} [options.throws] - make `getBalance` reject instead.
 * @returns {Promise<object>} the harness.
 */
async function mount(t, options = {}) {
  const app = new Context()
  /** @type {Array<object>} */
  const routes = []

  let currentBalance = options.balance
  let currentThrows = options.throws

  class WebServer extends Service {
    constructor(ctx) {
      super(ctx, 'webServer')
    }

    register(route) {
      assert.equal(
        routes.some((other) => other.kind === route.kind && other.path === route.path),
        false,
        `duplicate route ${route.path}`,
      )
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    }
  }

  class DeepSeekAccount extends Service {
    constructor(ctx) {
      super(ctx, 'deepseekAccount')
    }

    async getBalance() {
      if (currentThrows !== undefined) throw currentThrows
      return currentBalance === undefined
        ? { status: 'ready', value: [{ currency: 'CNY', balance: '10' }], bonusWallets: [] }
        : currentBalance
    }
  }

  app.plugin(WebServer)
  app.plugin(DeepSeekAccount)

  // Exactly how the catalogue mounts a row: apply + inject + Config.
  const fiber = app.plugin({ apply: host.apply, inject: host.inject, Config: host.Config, name: 'dsh-balance-meter' })
  await fiber

  /**
   * Tear the fiber down (which disposes the routes and the poll loop).
   *
   * @returns {Promise<void>} resolution after the fiber settled.
   */
  const dispose = async () => {
    await fiber.dispose()
  }
  t.after(dispose)

  return {
    app,
    fiber,
    routes,
    /** Replace what the provider reports on the NEXT read. */
    setBalance(balance) {
      currentBalance = balance
      currentThrows = undefined
    },
    dispose,
  }
}

/**
 * Drive one registered route.
 *
 * @param {object} harness - the harness from {@link mount}.
 * @param {string} path - the exact route path.
 * @param {string} [search] - query string including the leading `?`.
 * @returns {Promise<{ status: number, body: any }>} the response.
 */
async function call(harness, path, search = '') {
  const route = harness.routes.find((candidate) => candidate.path === path)
  assert.notEqual(route, undefined, `route ${path} must be registered`)
  let status = 0
  let payload = ''
  await route.handler(
    { url: `${path}${search}`, method: 'GET' },
    {
      writeHead(code) {
        status = code
      },
      end(body) {
        payload = body
      },
    },
  )
  return { status, body: JSON.parse(payload) }
}

test('the module exports the shape the catalogue requires', () => {
  assert.deepEqual(Object.keys(host).sort(), ['Config', 'apply', 'inject'])
  assert.equal(typeof host.apply, 'function')
  assert.deepEqual([...host.inject].sort(), ['deepseekAccount', 'webServer'])
  // The loader RESOLVES the schema (it calls it); a plain object would throw here.
  const resolved = host.Config({})
  assert.equal(typeof resolved, 'object')
})

test('the Config schema validates and defaults every field', () => {
  const resolved = host.Config({})
  // Volatile fields are live handles, so the value is read through `.get()`.
  assert.equal(resolved.pollIntervalMs.get(), 45_000)
  assert.equal(resolved.requestTimeoutMs.get(), 20_000)
  assert.equal(resolved.anomalyRatio.get(), 0.5)
  assert.equal(resolved.showTokenCrossCheck.get(), true)
  assert.equal(resolved.price.currency.get(), 'CNY')

  const overridden = host.Config({ pollIntervalMs: 60_000, anomalyRatio: 0.9 })
  assert.equal(overridden.pollIntervalMs.get(), 60_000)
  assert.equal(overridden.anomalyRatio.get(), 0.9)
})

test('the Config schema rejects out-of-range values instead of passing them on', () => {
  assert.throws(() => host.Config({ pollIntervalMs: 1 }))
  assert.throws(() => host.Config({ anomalyRatio: 9 }))
})

test('activation registers both routes and releases them with the fiber', async (t) => {
  const harness = await mount(t)
  assert.equal(harness.routes.length, 2)
  assert.deepEqual(
    harness.routes.map((route) => route.path).sort(),
    ['/dsh-balance-meter/refresh', '/dsh-balance-meter/status'],
  )
  assert.ok(harness.routes.every((route) => route.kind === 'exact'))
  await harness.dispose()
  assert.equal(harness.routes.length, 0, 'routes belong to the fiber')
})

test('a provider read becomes a session measurement', async (t) => {
  const harness = await mount(t)

  const first = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.balance.currency, 'CNY')
  assert.equal(first.body.balance.paid, 10, 'the first read is the mocked starting balance')
  assert.equal(first.body.balance.error, null)
  assert.equal(first.body.session.spend, 0)
  assert.equal(first.body.config.pollIntervalMs, 45_000)

  harness.setBalance({ status: 'ready', value: [{ currency: 'CNY', balance: '9.7870' }], bonusWallets: [] })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const refreshed = await call(harness, '/dsh-balance-meter/refresh', '?session=known')
  assert.equal(refreshed.body.balance.error, null, 'the provider read succeeded')
  assert.ok(
    Math.abs(refreshed.body.session.spend - 0.213) < 1e-9,
    `the delta becomes the session spend (got ${String(refreshed.body.session.spend)})`,
  )
  assert.ok(Math.abs(refreshed.body.balance.paid - 9.787) < 1e-9)
  assert.equal(refreshed.body.ledger.readingCount, 2, 'both observations are in the timeline')
})

test('a session id the session store does not know still measures', async (t) => {
  const harness = await mount(t)
  const response = await call(harness, '/dsh-balance-meter/status', '?session=stranger')
  assert.equal(response.status, 200)
  assert.equal(response.body.session.sessionId, 'stranger')
  assert.equal(response.body.session.spend, 0)
})

test('a missing session id yields the global balance and no session block', async (t) => {
  const harness = await mount(t)
  const response = await call(harness, '/dsh-balance-meter/status')
  assert.equal(response.body.session, null)
  assert.equal(response.body.balance.paid, 10)
})

test('a signed-out account is reported, not thrown', async (t) => {
  const harness = await mount(t, { balance: null })
  const response = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.equal(response.status, 200)
  assert.equal(response.body.balance.paid, null)
  assert.equal(response.body.balance.error.code, 'SIGNED_OUT')
  assert.equal(response.body.session.spend, 0)
})

test('a provider failure is reported with its code', async (t) => {
  const harness = await mount(t, { throws: new Error('boom') })
  const response = await call(harness, '/dsh-balance-meter/status')
  assert.equal(response.status, 200)
  assert.equal(response.body.balance.error.code, 'PROVIDER')
  assert.match(response.body.balance.error.message, /boom/)
})

test('a withdrawn balance read keeps the last known numbers as stale data', async (t) => {
  const harness = await mount(t)
  await call(harness, '/dsh-balance-meter/status', '?session=known')
  harness.setBalance({ status: 'failed' })
  const response = await call(harness, '/dsh-balance-meter/refresh', '?session=known')
  assert.equal(response.body.balance.error.code, 'BALANCE_FAILED')
  assert.equal(response.body.balance.error.stale.paid, 10, 'the panel can still show what was last known')
})

test('the recharge wallet headlines and the bonus is never summed into it', async (t) => {
  // The shipped account card shows 充值余额 and 赠金余额 on separate lines, so the
  // footer must not add them up: the delta arithmetic runs on the recharge wallet
  // alone, and the two stay distinct in the payload.
  const harness = await mount(t, {
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

test('the account-event guard is applied by default', async (t) => {
  const harness = await mount(t)
  await call(harness, '/dsh-balance-meter/status', '?session=known')
  harness.setBalance({ status: 'ready', value: [{ currency: 'CNY', balance: '0.5' }], bonusWallets: [] })
  const response = await call(harness, '/dsh-balance-meter/refresh', '?session=known')
  assert.equal(response.body.session.spend, 0, '95% of the wallet is not one turn')
})

test('token accounting feeds the cross-check and dies with the session', async (t) => {
  const harness = await mount(t)
  // The durable feed is process-wide; drive it through the same event the Host
  // emits. `session/event` is a real cordis event, so emit it on the app.
  const session = { id: 'known', header: { createdAt: 1_000_000 } }
  harness.app.emit('session/event', session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 } },
  })

  const priced = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.notEqual(priced.body.crossCheck, null, 'the token cross-check is published')
  assert.ok(Math.abs(priced.body.crossCheck.cost - 30) < 1e-9, '1M miss at the default 30 CNY/M')
  assert.equal(priced.body.crossCheck.tokens.total, 1_000_000)

  harness.app.emit('session/disposed', session)
  const afterDisposal = await call(harness, '/dsh-balance-meter/status', '?session=known')
  assert.equal(afterDisposal.body.crossCheck, null, 'a disposed session keeps no accounting')
})

test('a patch-shaped config (plain values) is honoured too', async (t) => {
  // Two config shapes reach `apply`: the resolved schema handles a mounted row
  // gets, and the plain values a `cordis.patch.yml` row carries before the schema
  // wraps them. Both must work, so this drives the plain one over a minimal
  // context — mounting through cordis re-resolves the override back to the schema
  // default, which is why the handles are read live in the first place.
  const routes = []
  const listeners = new Map()
  const ctx = {
    effect(callback) {
      const cleanup = callback()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    get: () => undefined,
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    deepseekAccount: {
      async getBalance() {
        return { status: 'ready', value: [{ currency: 'CNY', balance: '10' }], bonusWallets: [] }
      },
    },
  }
  t.after(() => {
    for (const handler of listeners.get('session/disposed') ?? []) handler({ id: 'known' })
  })

  host.apply(ctx, { showTokenCrossCheck: false, pollIntervalMs: 90_000, price: { currency: 'CNY', cacheHit: 1, cacheMiss: 30, output: 90 } })
  for (const handler of listeners.get('session/event') ?? []) {
    handler({ id: 'known', header: { createdAt: 1_000_000 } }, { type: 'assistant/message', data: { usage: { inputTokens: 1_000 } } })
  }

  const response = await call({ routes }, '/dsh-balance-meter/status', '?session=known')
  assert.equal(response.body.crossCheck, null, 'the plain flag turns the cross-check off')
  assert.equal(response.body.config.showTokenCrossCheck, false)
  assert.equal(response.body.config.pollIntervalMs, 90_000, 'the plain poll interval is honoured')
})
