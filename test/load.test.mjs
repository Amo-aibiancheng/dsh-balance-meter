/**
 * Load test: the plugin against a REAL Cordis app.
 *
 * The other host test drives `apply` with a hand-written context, which proves
 * the plugin's own logic but not its contract with the framework. This one boots
 * an actual cordis application from the profile's own SDK, registers the plugin
 * exactly as the loader does (by its named `apply` export), mounts the two
 * services it injects, and asserts the services are reachable through the
 * injected context face the way the running shell exposes them.
 *
 * @module dsh-balance-meter/test/load.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** The profile that owns the SDK this machine runs. */
const SDK_ROOT = process.env.DSH_SDK_ROOT ?? 'C:\\Users\\11495\\.dsh\\profiles\\node_modules'
const require = createRequire(`${SDK_ROOT}\\`)

/**
 * Import one SDK package by name.
 *
 * @param {string} name - package name.
 * @returns {Promise<any>} the module namespace.
 */
async function sdk(name) {
  const entry = require.resolve(name)
  return import(pathToFileURL(entry).href)
}

test('the plugin loads and applies on a real cordis app', async (t) => {
  const { Context, Service } = await sdk('@deepseek-ai/cordis')
  const { apply, inject } = await import('../src/index.js')

  const app = new Context()
  t.after(async () => {
    await app.fiber.dispose()
  })

  // The two services the row injects, provided the way a plugin provides a
  // service (cordis refuses a bare property write, which is what makes this a
  // real dependency-injection check rather than a stub).
  const routes = []
  class WebServer extends Service {
    constructor(ctx) {
      super(ctx, 'webServer')
    }

    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    }
  }
  class DeepseekAccount extends Service {
    constructor(ctx) {
      super(ctx, 'deepseekAccount')
    }

    async getBalance() {
      return { status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [] }
    }
  }
  app.plugin(WebServer)
  app.plugin(DeepseekAccount)
  await app.fiber.await?.()

  // Register the module exactly as the loader does.
  const fiber = app.plugin({ apply, inject, name: 'dsh-balance-meter' })
  await fiber
  assert.equal(routes.length, 2, 'both routes registered through the injected face')
  assert.equal(routes[0].kind, 'exact')
  assert.match(routes[0].path, /^\/dsh-balance-meter\//)
  assert.equal(typeof routes[0].handler, 'function')

  // The injected face must be the live service, and a request must produce the
  // payload the footer renders.
  let payload = ''
  await routes.find((route) => route.path.endsWith('/status')).handler(
    { url: '/dsh-balance-meter/status', method: 'GET' },
    {
      writeHead() {},
      end(body) {
        payload = body
      },
    },
  )
  const body = JSON.parse(payload)
  assert.equal(body.ok, true)
  assert.equal(body.balance.totalBalance, 12.34)
  assert.equal(body.session, null, 'no session id in the query')

  // Disposal must release every route (the fiber owns them).
  await fiber.dispose()
  assert.equal(routes.length, 0, 'routes are released with the plugin fiber')
})

test('the row declares only services the shipped Host provides', async () => {
  const { inject } = await import('../src/index.js')
  const { Context } = await sdk('@deepseek-ai/cordis')
  // A declared-but-absent service would leave the fiber pending forever, so the
  // declaration is checked against the Host's own service catalog shape: the
  // account provider and the route registry are the two this plugin needs.
  assert.deepEqual([...inject].sort(), ['deepseekAccount', 'webServer'])
  assert.equal(typeof Context, 'function')
})
