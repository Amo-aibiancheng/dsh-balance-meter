/**
 * The install contract, pinned by test.
 *
 * The first version of this plugin shipped a `main` pointing at a file that did
 * not exist, so the catalogue reported `failed to import` and the entry never
 * activated. Nothing in the test suite could see that, because every test
 * imported the source directly.
 *
 * This file closes that hole: it resolves the package BY NAME out of a real
 * profile's node_modules (the way the loader does), imports exactly the entries
 * the manifest declares, activates the host half on a real cordis app with the
 * two services it injects, and drives a route end to end. A manifest that points
 * at the wrong file, a half that fails to export `apply`, or a route that stops
 * answering all fail here.
 *
 * @module dsh-balance-meter/test/install.test
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * The profile whose node_modules resolves this plugin by name.
 *
 * Overridable so the test works on another machine: set `DSH_PROFILE_DIR` to the
 * profile that has the plugin installed.
 */
const PROFILE = process.env['DSH_PROFILE_DIR'] ?? 'C:\\Users\\11495\\.dsh\\profiles\\desktop'

/** Resolution happens from inside the profile, exactly like the loader's. */
const fromProfile = createRequire(`${PROFILE}\\`)

/** Leave as soon as the assertions have settled (see test/host.test.mjs). */
after(() => {
  setImmediate(() => {
    process.exit(0)
  })
})

/** The package name the profile must resolve, as the manifest declares it. */
const PACKAGE = '@amo-aibiancheng/dsh-balance-meter'

test('the installed package resolves by name to its manifest entry', () => {
  const entry = fromProfile.resolve(PACKAGE)
  assert.match(entry, /lib[\\/]index\.js$/, 'main must point at a file that exists')
  const manifest = fromProfile(`${PACKAGE}/package.json`)
  assert.equal(manifest.name, PACKAGE)
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['.'].default, './lib/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
})

test('the client bundle the manifest declares exists and is the loader closure', async () => {
  const clientPath = fromProfile.resolve(`${PACKAGE}/client`)
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(clientPath, 'utf8')
  // The shell evaluates this file; the first statement must be the only load call.
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id: "@amo-aibiancheng\/dsh-balance-meter"/)
  assert.match(source, /factory: \(require\) => \{/)
  assert.doesNotMatch(source, /^\s*export /m, 'an ES export would be a syntax error in the shell')
})

test('the installed host half activates and answers a route', async () => {
  const host = await import(pathToFileURL(fromProfile.resolve(PACKAGE)).href)
  assert.equal(typeof host.apply, 'function')
  assert.deepEqual([...host.inject].sort(), ['deepseekAccount', 'webServer'])
  assert.equal(typeof host.Config, 'function', 'the schema the loader resolves')

  const { Context, Service } = await import(pathToFileURL(fromProfile.resolve('@deepseek-ai/cordis')).href)
  const app = new Context()
  const routes = []
  class WebServer extends Service {
    constructor(ctx) {
      super(ctx, 'webServer')
    }

    register(route) {
      routes.push(route)
      return () => {}
    }
  }
  class DeepSeekAccount extends Service {
    constructor(ctx) {
      super(ctx, 'deepseekAccount')
    }

    async getBalance() {
      return { status: 'ready', value: [{ currency: 'CNY', balance: '4.56' }], bonusWallets: [] }
    }
  }
  app.plugin(WebServer)
  app.plugin(DeepSeekAccount)

  const fiber = app.plugin({ apply: host.apply, inject: host.inject, Config: host.Config, name: 'dsh-balance-meter' })
  await fiber
  assert.equal(routes.length, 2, 'both routes registered on the installed build')

  let payload = ''
  await routes
    .find((route) => route.path.endsWith('/status'))
    .handler({ url: '/dsh-balance-meter/status?session=s1', method: 'GET' }, {
      writeHead() {},
      end(body) {
        payload = body
      },
    })
  const body = JSON.parse(payload)
  assert.equal(body.ok, true)
  assert.equal(body.balance.paid, 4.56, 'the installed build reads the provider through the injected service')
  assert.equal(body.session.sessionId, 's1')

  await fiber.dispose()
})
