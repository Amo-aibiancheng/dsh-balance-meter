/**
 * dsh-balance-meter — Host half.
 *
 * Owns the one thing only the Host can do: read the account wallet through the
 * official `deepseekAccount` service, keep a cheap observation timeline of it,
 * and difference that timeline per Session. The browser half renders the result
 * in the composer footer; it never sees a credential and never calls DeepSeek.
 *
 * The measurement algorithm itself lives in `src/core/ledger.js` (pure, no
 * Node and no DOM), so it can be reasoned about and tested on its own.
 *
 * @module dsh-balance-meter
 */

import { createLedger } from './core/ledger.js'

/**
 * Config defaults, as the profile patch supplies them.
 *
 * Deliberately NOT exported as the row's `Config`: the loader validates that
 * export by calling `.validate()` on it, so a plain object of defaults crashes
 * the row at load time (verified against the running cordis). The values below
 * are re-validated and clamped in {@link effectiveConfig} before any of them
 * reaches the provider, so a bad patch entry degrades to the default instead.
 * A patch row sets them under `config:`, and the key names are these.
 */
const CONFIG_DEFAULTS = {
  /** How long a reading is reused before the account is asked again (ms). */
  pollIntervalMs: 45000,
  /** Provider read timeout (ms). */
  requestTimeoutMs: 20000,
  /** A single drop above this fraction of the wallet is an account event, not Session spend. */
  anomalyRatio: 0.5,
  /** Publish the token cross-check beside the measured delta. */
  showTokenCrossCheck: true,
  /** Rates used ONLY by the cross-check, per million tokens. */
  price: {
    currency: 'CNY',
    cacheHit: 0.1,
    cacheMiss: 3,
    output: 9,
  },
}

/** Required services: the route registry and the official account provider. */
export const inject = ['webServer', 'deepseekAccount']

/** Route family root; DOCUMENT-RELATIVE on the browser side (see the client half). */
const ROUTE_PREFIX = '/dsh-balance-meter'

/** Upper bound of one settings edit, so a typo cannot pin the provider. */
const MAX_POLL_INTERVAL_MS = 30 * 60000
/** Lower bound of one settings edit, out of respect for the provider's rate limits. */
const MIN_POLL_INTERVAL_MS = 5000

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/**
 * Clamp a numeric setting into its safe range.
 *
 * @param {unknown} value - raw setting.
 * @param {number} fallback - value used when the setting is unreadable.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the clamped setting.
 */
function clampNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * Resolve the effective config from the row's config handle.
 *
 * A plain-object row config arrives as-is (only `{ type, default }` descriptors,
 * no live references), while a schemastery row config exposes `.get()`; both are
 * accepted so the plugin works before and after the settings page wraps it.
 *
 * @param {object} config - the row's config handle.
 * @returns {{ pollIntervalMs: number, requestTimeoutMs: number, anomalyRatio: number, showTokenCrossCheck: boolean, price: object }} resolved settings.
 */
function effectiveConfig(config) {
  const read = (field, fallback) => {
    const holder = config?.[field]
    if (holder !== null && typeof holder === 'object' && typeof holder.get === 'function') {
      const value = holder.get()
      return value === undefined ? fallback : value
    }
    return holder === undefined ? fallback : holder
  }
  const price = read('price', {}) ?? {}
  const currency = typeof price.currency === 'string' && price.currency !== '' ? price.currency.toUpperCase() : 'CNY'
  const rate = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  return {
    pollIntervalMs: clampNumber(read('pollIntervalMs', CONFIG_DEFAULTS.pollIntervalMs), CONFIG_DEFAULTS.pollIntervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS),
    requestTimeoutMs: clampNumber(read('requestTimeoutMs', CONFIG_DEFAULTS.requestTimeoutMs), CONFIG_DEFAULTS.requestTimeoutMs, 3000, 120000),
    anomalyRatio: Math.min(1, Math.max(0.05, Number(read('anomalyRatio', CONFIG_DEFAULTS.anomalyRatio)) || CONFIG_DEFAULTS.anomalyRatio)),
    showTokenCrossCheck: read('showTokenCrossCheck', CONFIG_DEFAULTS.showTokenCrossCheck) !== false,
    price: {
      currency,
      hit: rate(price.cacheHit, CONFIG_DEFAULTS.price.cacheHit),
      miss: rate(price.cacheMiss, CONFIG_DEFAULTS.price.cacheMiss),
      out: rate(price.output, CONFIG_DEFAULTS.price.output),
    },
  }
}

/**
 * Race one promise against a timeout, always clearing the timer.
 *
 * @template T
 * @param {Promise<T>} promise - the work to bound.
 * @param {number} ms - the budget in milliseconds.
 * @param {() => T} onTimeout - value produced when the budget runs out.
 * @returns {Promise<T>} the winner.
 */
async function withTimeout(promise, ms, onTimeout) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Read the durable creation time of one Session.
 *
 * The wallet delta is measured from a Session's birth, so the Host needs that
 * instant. The session store is the authority; an Agent that is still live is
 * the fallback; a caller with neither (a reset composition) falls back to now,
 * which the ledger records as a late baseline rather than pretending to know.
 *
 * @param {object} ctx - host context.
 * @param {string} sessionId - the Session id.
 * @returns {number} creation time in epoch milliseconds.
 */
function sessionCreatedMs(ctx, sessionId) {
  try {
    const header = ctx.get('sessions')?.get(sessionId)?.header
    if (header !== undefined && Number.isFinite(header.createdAt)) return Number(header.createdAt)
  } catch {
    // A store lookup must never break a balance read.
  }
  try {
    const created = ctx.get('agents')?.get(sessionId)?.session?.header?.createdAt
    if (Number.isFinite(created)) return Number(created)
  } catch {
    // Same.
  }
  return Date.now()
}

/**
 * Coerce a query-string value to one string.
 *
 * @param {unknown} value - raw query value.
 * @returns {string} the value, or `''`.
 */
function queryValue(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

/**
 * Copy a wallet map, so a response never aliases the ledger's live objects.
 *
 * @param {Record<string, { paid: number, bonus: number }> | undefined} wallets - wallet map.
 * @returns {Record<string, { paid: number, bonus: number }>} a detached copy.
 */
function copyWallets(wallets) {
  const out = {}
  for (const [currency, wallet] of Object.entries(wallets ?? {})) {
    out[currency] = { paid: wallet.paid, bonus: wallet.bonus }
  }
  return out
}

/**
 * Write one JSON response.
 *
 * @param {object} res - the server response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/**
 * Mount the observation loop and the route family.
 *
 * @param {object} ctx - host context carrying `webServer` and `deepseekAccount`.
 * @param {object} config - the plugin row's config handle.
 * @returns {void}
 */
export function apply(ctx, config) {
  /** @type {Map<string, number>} sessionId -> creation time, for event ingestion. */
  const createdCache = new Map()

  const ledger = createLedger({
    // A live getter: editing anomalyRatio in Settings applies to the next
    // observation without remounting the row or losing the timeline.
    anomalyRatio: () => effectiveConfig(config).anomalyRatio,
  })

  /** @type {Promise<object> | null} in-flight provider read, shared by every caller. */
  let inFlight = null
  /** @type {object | null} last provider outcome. */
  let lastOutcome = null
  /** @type {number} epoch ms of the last provider read that reached the account. */
  let lastReadAt = 0

  /**
   * The current guard values. Read per use so a Settings edit takes effect on
   * the next observation without a restart.
   *
   * @returns {object} resolved config.
   */
  const settings = () => effectiveConfig(config)

  /**
   * Ask the official account provider for the wallet balance.
   *
   * @returns {Promise<{ ok: true, wallets: object[], bonusWallets: object[] } | { ok: false, code: string, message: string }>} outcome.
   */
  async function readBalance() {
    const active = settings()
    // Resolved per call: a composition without the account provider must report
    // "signed out", not throw out of a route handler.
    const account = ctx.get?.('deepseekAccount')
    if (account === undefined || account === null) {
      return { ok: false, code: 'NO_PROVIDER', message: '账号服务不可用（当前组合未挂载 deepseekAccount）' }
    }
    let details
    try {
      const client = {
        version: 'dsh-balance-meter/0.1.0',
        locale: typeof process !== 'undefined' && process.env?.LANG ? String(process.env.LANG) : 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
      details = await account.getBalance(client)
    } catch (error) {
      return { ok: false, code: 'PROVIDER', message: `账号服务读取失败: ${String(error?.message ?? error).slice(0, 160)}` }
    }
    if (details === null || details === undefined) {
      return { ok: false, code: 'SIGNED_OUT', message: '未登录 DeepSeek 账号' }
    }
    if (details.status !== 'ready') {
      return { ok: false, code: 'BALANCE_FAILED', message: '余额查询失败（账号授权可能已失效）' }
    }
    return {
      ok: true,
      wallets: Array.isArray(details.value) ? details.value : [],
      bonusWallets: Array.isArray(details.bonusWallets) ? details.bonusWallets : [],
    }
  }

  /**
   * Read the account unless the newest observation is still inside the TTL.
   * Concurrent callers share one provider request.
   *
   * @param {boolean} force - bypass the TTL (an explicit user refresh).
   * @returns {Promise<object>} the latest outcome.
   */
  async function ensureReading(force) {
    const active = settings()
    const fresh = lastReadAt > 0 && Date.now() - lastReadAt < active.pollIntervalMs
    if (!force && fresh && lastOutcome !== null) return lastOutcome
    if (inFlight !== null) return inFlight
    inFlight = (async () => {
      try {
        const outcome = await withTimeout(readBalance(), settings().requestTimeoutMs, () => ({
          ok: false,
          code: 'TIMEOUT',
          message: '余额查询超时',
        }))
        lastOutcome = outcome
        if (outcome.ok) {
          lastReadAt = Date.now()
          ledger.recordReading({ time: lastReadAt, balance: outcome.wallets, bonusWallets: outcome.bonusWallets })
        }
        return outcome
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  /**
   * Build the payload the footer renders.
   *
   * @param {string} sessionId - the Session asking.
   * @param {object} outcome - the last provider outcome.
   * @returns {object} the status payload.
   */
  function buildPayload(sessionId, outcome) {
    const active = settings()
    const now = Date.now()
    const latest = ledger.latest()
    const measurement = sessionId === '' ? null : ledger.measureSession(sessionId, sessionCreatedMs(ctx, sessionId), now)
    let crossCheck = null
    if (active.showTokenCrossCheck && sessionId !== '') {
      crossCheck = ledger.estimateCost(sessionId, active.price)
    }
    let balanceError = null
    if (outcome === null || !outcome.ok) {
      const stale = latest === null ? null : { time: latest.time, total: latest.total, currency: latest.currency }
      balanceError = {
        code: outcome?.code ?? 'PENDING',
        message: outcome?.message ?? '尚未取得余额',
        stale,
      }
    }
    return {
      ok: true,
      config: {
        pollIntervalMs: active.pollIntervalMs,
        showTokenCrossCheck: active.showTokenCrossCheck,
      },
      balance: {
        totalBalance: latest?.total ?? null,
        currency: latest?.currency ?? '',
        // Copied per currency: the payload is serialized, and handing out the
        // ledger's own objects would let a later observation mutate a response
        // that is already being written.
        wallets: copyWallets(latest?.wallets),
        updatedAt: latest?.time ?? null,
        ageMs: latest === null ? null : now - latest.time,
        error: balanceError,
      },
      session: measurement,
      crossCheck,
      ledger: {
        readingCount: ledger.latest()?.seq ?? 0,
        sessionCount: ledger.sessionIds().length,
      },
      serverTime: now,
    }
  }

  ctx.effect(() => {
    const disposers = []
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sessionId = queryValue(url.searchParams.get('session'))
            const force = queryValue(url.searchParams.get('refresh')) === '1'
            const outcome = await ensureReading(force)
            sendJson(res, 200, buildPayload(sessionId, outcome))
          } catch (error) {
            sendJson(res, 500, { ok: false, code: 'INTERNAL', message: String(error?.message ?? error).slice(0, 200) })
          }
        },
      }),
    )
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/refresh`,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sessionId = queryValue(url.searchParams.get('session'))
            const outcome = await ensureReading(true)
            sendJson(res, 200, buildPayload(sessionId, outcome))
          } catch (error) {
            sendJson(res, 500, { ok: false, code: 'INTERNAL', message: String(error?.message ?? error).slice(0, 200) })
          }
        },
      }),
    )
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // A route disposer must not break fiber teardown.
        }
      }
    }
  }, 'dsh-balance-meter: routes')

  // Token accounting for the cross-check. The durable event feed is
  // process-wide and fire-and-forget, so this listener is cheap: no provider
  // call, no I/O, only an accumulator update per assistant step.
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          const sessionId = session?.id
          if (typeof sessionId !== 'string' || sessionId === '') return
          let created = createdCache.get(sessionId)
          if (created === undefined) {
            created = Number(session?.header?.createdAt)
            if (!Number.isFinite(created)) created = Date.now()
            createdCache.set(sessionId, created)
            // The cache is a memo, not a registry: `session/disposed` normally
            // clears an entry, but an eviction keeps a long-lived process from
            // growing the map for every child session that ever appended.
            if (createdCache.size > 512) {
              const oldest = createdCache.keys().next()
              if (oldest.done !== true) createdCache.delete(oldest.value)
            }
          }
          ledger.ingestSessionEvent(sessionId, created, event)
        } catch {
          // One malformed event must not disturb the feed.
        }
      }),
    'dsh-balance-meter: token accounting',
  )

  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        const sessionId = session?.id
        if (typeof sessionId !== 'string') return
        createdCache.delete(sessionId)
        ledger.forgetSession(sessionId)
      }),
    'dsh-balance-meter: session cleanup',
  )

  // The observation loop. It keeps the wallet timeline moving even while no
  // browser is watching, so a Session's reference is never older than one poll
  // interval when its first spend lands. A failing read backs off to the poll
  // interval instead of hammering the provider.
  ctx.effect(() => {
    let stopped = false
    let timer = null
    /** @type {number} consecutive failures, for the backoff. */
    let failures = 0
    const schedule = () => {
      if (stopped) return
      const active = settings()
      const delay = failures === 0 ? active.pollIntervalMs : Math.min(MAX_POLL_INTERVAL_MS, active.pollIntervalMs * 2 ** Math.min(failures, 3))
      timer = setTimeout(tick, delay)
    }
    const tick = async () => {
      try {
        const outcome = await ensureReading(false)
        failures = outcome.ok ? 0 : failures + 1
      } catch {
        failures += 1
      }
      schedule()
    }
    // First read shortly after mount: the earlier the first observation, the
    // tighter a Session's baseline can be.
    timer = setTimeout(tick, 1200)
    return () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    }
  }, 'dsh-balance-meter: balance poll')
}
