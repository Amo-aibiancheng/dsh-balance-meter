/**
 * dsh-balance-meter — Host half.
 *
 * Owns the one thing only the Host can do: read the account wallet through the
 * official `deepseekAccount` service, keep a cheap observation timeline of it,
 * and difference that timeline per Session. The browser half renders the result
 * in the composer footer; it never sees a credential and never calls DeepSeek.
 *
 * The measurement algorithm lives in `./core/ledger.ts` (pure, no Node and no
 * DOM), so it can be reasoned about and tested on its own.
 *
 * @module dsh-balance-meter
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AccountClientMetadata, AccountWallet } from '@deepseek-ai/dsh-deepseek-account'
// Type-only edges: each module's `declare module '@deepseek-ai/cordis'` block is
// what puts `ctx.webServer` and `ctx.deepseekAccount` on the Context type, so
// both are imported even though nothing of theirs is used at runtime.
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createLedger, type Ledger, type PriceTable, type RawWallet } from './core/ledger.ts'

/**
 * Plugin config schema.
 *
 * This MUST be a schemastery schema rather than a plain object of defaults: the
 * loader validates a row's `Config` export by calling `.validate()` on it, so a
 * hand-written default object makes the entry fail to import. The volatile
 * fields are the ones a Settings edit must reach without remounting the row.
 */
export const Config = z.object({
  /** How long a reading is reused before the account is asked again (ms). */
  pollIntervalMs: z.natural().min(5_000).max(1_800_000).default(45_000).volatile(),
  /** Provider read timeout (ms). */
  requestTimeoutMs: z.natural().min(3_000).max(120_000).default(20_000).volatile(),
  /** A single drop above this fraction of the wallet is an account event, not Session spend. */
  anomalyRatio: z.number().min(0.05).max(1).default(0.5).volatile(),
  /** Publish the token cross-check beside the measured delta. */
  showTokenCrossCheck: z.boolean().default(true).volatile(),
  /** Rates used ONLY by the cross-check, per million tokens. */
  price: z
    .object({
      currency: z.string().default('CNY').volatile(),
      cacheHit: z.natural().default(1).volatile(),
      cacheMiss: z.natural().default(30).volatile(),
      output: z.natural().default(90).volatile(),
    })
    .default({ currency: 'CNY', cacheHit: 1, cacheMiss: 30, output: 90 }),
})

/**
 * The row's config as the loader resolves it.
 *
 * `ReturnType` of the schema, not a hand-written interface: a volatile field is a
 * live handle with a `.get()`, and deriving the type from the schema is what
 * keeps the two from drifting. {@link fieldValue} is the reader for it.
 */
export type BalanceMeterConfig = ReturnType<typeof Config>

/** The value behind one config field: a volatile handle, or an already-plain value. */
export type FieldValue<F> = F extends { get: () => infer V } ? V : F

/** Required services: the route registry and the official account provider. */
export const inject = ['webServer', 'deepseekAccount']

/** Route family root. The browser calls it DOCUMENT-RELATIVE (see the client half). */
const ROUTE_STATUS = '/dsh-balance-meter/status'
const ROUTE_REFRESH = '/dsh-balance-meter/refresh'

/** Backoff ceiling for a failing provider read. */
const MAX_BACKOFF_MS = 30 * 60_000

/** Cache-entry ceiling for the session-birth memo; disposal is the normal path. */
const CREATED_CACHE_MAX = 512

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** One provider read outcome. */
type BalanceOutcome =
  | { readonly ok: true; readonly wallets: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** The payload the footer renders. */
interface StatusPayload {
  readonly ok: true
  readonly config: { readonly pollIntervalMs: number; readonly showTokenCrossCheck: boolean }
  readonly balance: {
    /** 充值余额: the headline money. */
    readonly paid: number | null
    /** 赠金余额: reported beside it, never summed in. */
    readonly bonus: number | null
    readonly currency: string
    readonly wallets: Readonly<Record<string, { paid: number; bonus: number }>>
    readonly updatedAt: number | null
    readonly ageMs: number | null
    readonly error: {
      readonly code: string
      readonly message: string
      readonly stale: { readonly time: number; readonly paid: number; readonly currency: string } | null
    } | null
  }
  readonly session: ReturnType<Ledger['measureSession']> | null
  readonly crossCheck: ReturnType<Ledger['estimateCost']>
  readonly ledger: { readonly readingCount: number; readonly sessionCount: number }
  readonly serverTime: number
}

/**
 * Read one config field's live value.
 *
 * A volatile field arrives as a handle whose `.get()` returns the value the
 * settings subsystem last committed — that indirection is what lets a Settings
 * edit reach this running row. A plain field (a patch that set the value
 * directly) is returned as-is, so both shapes work.
 *
 * @param field - the schema field, or the value the loader already resolved.
 * @param fallback - value used when the field is absent.
 * @returns the effective value.
 */
function fieldValue<F>(field: F | undefined, fallback: FieldValue<F>): FieldValue<F> {
  if (field === undefined) return fallback
  if (
    field !== null &&
    typeof field === 'object' &&
    'get' in field &&
    typeof (field as { get: unknown }).get === 'function'
  ) {
    const value = (field as { get: () => FieldValue<F> | undefined }).get()
    return value === undefined ? fallback : value
  }
  return field as unknown as FieldValue<F>
}

/**
 * Resolve the live price table for the cross-check.
 *
 * @param config - the row config.
 * @returns rates per million tokens.
 */
function priceTable(config: BalanceMeterConfig | undefined): PriceTable {
  const price = config?.price
  const currency = fieldValue(price?.currency, 'CNY')
  const rate = (value: unknown, fallback: number): number => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  return {
    currency: typeof currency === 'string' && currency !== '' ? currency.toUpperCase() : 'CNY',
    hit: rate(fieldValue(price?.cacheHit, 1), 1),
    miss: rate(fieldValue(price?.cacheMiss, 30), 30),
    out: rate(fieldValue(price?.output, 90), 90),
  }
}

/**
 * Race one promise against a timeout, always clearing the timer.
 *
 * @param promise - the work to bound.
 * @param ms - the budget in milliseconds.
 * @param onTimeout - value produced when the budget runs out.
 * @returns the winner.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Copy a wallet map, so a response never aliases the ledger's live objects.
 *
 * @param wallets - wallet map.
 * @returns a detached copy.
 */
function copyWallets(
  wallets: Readonly<Record<string, { paid: number; bonus: number }>> | undefined,
): Record<string, { paid: number; bonus: number }> {
  const out: Record<string, { paid: number; bonus: number }> = {}
  for (const [currency, wallet] of Object.entries(wallets ?? {})) {
    out[currency] = { paid: wallet.paid, bonus: wallet.bonus }
  }
  return out
}

/** The minimum a response object must offer to carry JSON out of a route. */
interface JsonResponse {
  writeHead: (status: number, headers?: Record<string, string>) => void
  end: (body: string) => void
}

/**
 * Mount the observation loop and the route family.
 *
 * @param ctx - host context carrying `webServer` and `deepseekAccount`.
 * @param config - the row's config as the loader resolved it.
 */
export function apply(ctx: Context, config?: BalanceMeterConfig): void {
  const ledger: Ledger = createLedger({
    // A live getter: editing anomalyRatio applies to the next observation
    // without remounting the row or losing the timeline.
    anomalyRatio: () => fieldValue(config?.anomalyRatio, 0.5),
  })

  /** sessionId -> creation time, memoized for event ingestion. */
  const createdCache = new Map<string, number>()

  /** In-flight provider read, shared by every caller. */
  let inFlight: Promise<BalanceOutcome> | null = null
  /** Last provider outcome. */
  let lastOutcome: BalanceOutcome | null = null
  /** Epoch ms of the last read that reached the account. */
  let lastReadAt = 0

  const pollIntervalMs = (): number => fieldValue(config?.pollIntervalMs, 45_000)
  const requestTimeoutMs = (): number => fieldValue(config?.requestTimeoutMs, 20_000)

  /**
   * Read the durable creation time of one Session.
   *
   * The wallet delta is measured from a Session's birth, so the Host needs that
   * instant. The session store is the authority; an Agent that is still live is
   * the fallback; a composition with neither falls back to now, which the ledger
   * records as a late baseline rather than pretending to know.
   *
   * @param sessionId - the Session id.
   * @returns creation time in epoch milliseconds.
   */
  function sessionCreatedMs(sessionId: string): number {
    const id = SessionId(sessionId)
    try {
      const header = ctx.get('sessions')?.get(id)?.header
      if (header !== undefined && Number.isFinite(header.createdAt)) return Number(header.createdAt)
    } catch {
      // A store lookup must never break a balance read.
    }
    try {
      const created = ctx.get('agents')?.get(id)?.session?.header?.createdAt
      if (Number.isFinite(created)) return Number(created)
    } catch {
      // Same.
    }
    return Date.now()
  }

  /**
   * Ask the official account provider for the wallet balance.
   *
   * @returns the outcome; never throws.
   */
  async function readBalance(): Promise<BalanceOutcome> {
    const client: AccountClientMetadata = {
      version: 'dsh-balance-meter/0.2.0',
      locale: process.env['LANG'] ?? 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
    let details: Awaited<ReturnType<Context['deepseekAccount']['getBalance']>>
    try {
      details = await ctx.deepseekAccount.getBalance(client)
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 160)
      return { ok: false, code: 'PROVIDER', message: `账号服务读取失败: ${message}` }
    }
    if (details === null) return { ok: false, code: 'SIGNED_OUT', message: '未登录 DeepSeek 账号' }
    if (details.status !== 'ready') {
      return { ok: false, code: 'BALANCE_FAILED', message: '余额查询失败（账号授权可能已失效）' }
    }
    return { ok: true, wallets: details.value, bonusWallets: details.bonusWallets }
  }

  /**
   * Read the account unless the newest observation is still inside the TTL.
   * Concurrent callers share one provider request.
   *
   * @param force - bypass the TTL (an explicit user refresh).
   * @returns the latest outcome.
   */
  async function ensureReading(force: boolean): Promise<BalanceOutcome> {
    const fresh = lastReadAt > 0 && Date.now() - lastReadAt < pollIntervalMs()
    if (!force && fresh && lastOutcome !== null) return lastOutcome
    if (inFlight !== null) return inFlight
    inFlight = (async (): Promise<BalanceOutcome> => {
      try {
        const outcome = await withTimeout(readBalance(), requestTimeoutMs(), () => ({
          ok: false as const,
          code: 'TIMEOUT',
          message: '余额查询超时',
        }))
        lastOutcome = outcome
        if (outcome.ok) {
          lastReadAt = Date.now()
          ledger.recordReading({
            time: lastReadAt,
            balance: outcome.wallets as readonly RawWallet[],
            bonusWallets: outcome.bonusWallets as readonly RawWallet[],
          })
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
   * @param sessionId - the Session asking, or `''` for a global read.
   * @param outcome - the last provider outcome.
   * @returns the status payload.
   */
  function buildPayload(sessionId: string, outcome: BalanceOutcome | null): StatusPayload {
    const now = Date.now()
    const latest = ledger.latest()
    const measurement = sessionId === '' ? null : ledger.measureSession(sessionId, sessionCreatedMs(sessionId), now)
    const crossCheck =
      fieldValue(config?.showTokenCrossCheck, true) && sessionId !== ''
        ? ledger.estimateCost(sessionId, priceTable(config))
        : null
    const balanceError =
      outcome === null || !outcome.ok
        ? {
            code: outcome?.code ?? 'PENDING',
            message: outcome?.message ?? '尚未取得余额',
            stale: latest === null ? null : { time: latest.time, paid: latest.paid, currency: latest.currency },
          }
        : null
    return {
      ok: true,
      config: {
        pollIntervalMs: pollIntervalMs(),
        showTokenCrossCheck: fieldValue(config?.showTokenCrossCheck, true),
      },
      balance: {
        // 充值余额 (the recharge wallet) headlines, exactly as the shipped account
        // card reports it. 赠金 rides beside it and is never summed in: bonus
        // funds are granted and expire, so adding them misreports both.
        paid: latest === null || !Number.isFinite(latest.paid) ? null : latest.paid,
        bonus: latest?.bonus ?? null,
        currency: latest?.currency ?? '',
        wallets: copyWallets(latest?.wallets),
        updatedAt: latest?.time ?? null,
        ageMs: latest === null ? null : now - latest.time,
        error: balanceError,
      },
      session: measurement,
      crossCheck,
      ledger: { readingCount: latest?.seq ?? 0, sessionCount: ledger.sessionIds().length },
      serverTime: now,
    }
  }

  /**
   * Write one JSON response.
   *
   * @param res - the server response.
   * @param status - HTTP status.
   * @param body - JSON-serializable body.
   */
  function sendJson(res: JsonResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...JSON_HEADERS })
    res.end(JSON.stringify(body))
  }

  /**
   * Drive one route from its request URL.
   *
   * @param url - the request URL (path plus query).
   * @param res - the server response.
   * @param force - whether this route forces a provider read.
   */
  async function handle(url: string | undefined, res: JsonResponse, force: boolean): Promise<void> {
    try {
      const parsed = new URL(url ?? '/', 'http://localhost')
      const sessionId = parsed.searchParams.get('session') ?? ''
      const outcome = await ensureReading(force)
      sendJson(res, 200, buildPayload(sessionId, outcome))
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 200)
      sendJson(res, 500, { ok: false, code: 'INTERNAL', message })
    }
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_STATUS,
        handler: (req, res) => handle(req.url, res, false),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_REFRESH,
        handler: (req, res) => handle(req.url, res, true),
      }),
    ]
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

  // Token accounting for the cross-check. The durable event feed is process-wide
  // and fire-and-forget, so this listener is cheap: no provider call, no I/O.
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          const sessionId = session.id as string
          let created = createdCache.get(sessionId)
          if (created === undefined) {
            const header = Number(session.header?.createdAt)
            created = Number.isFinite(header) ? header : Date.now()
            createdCache.set(sessionId, created)
            // A memo, not a registry: `session/disposed` normally clears an
            // entry, and eviction keeps a long-lived process bounded.
            if (createdCache.size > CREATED_CACHE_MAX) {
              const oldest = createdCache.keys().next()
              if (oldest.done !== true) createdCache.delete(oldest.value)
            }
          }
          ledger.ingestSessionEvent(sessionId, created, event as { type?: string; data?: unknown })
        } catch {
          // One malformed event must not disturb the feed.
        }
      }),
    'dsh-balance-meter: token accounting',
  )

  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        const sessionId = session.id as string
        createdCache.delete(sessionId)
        ledger.forgetSession(sessionId)
      }),
    'dsh-balance-meter: session cleanup',
  )

  // The observation loop. It keeps the wallet timeline moving even while no
  // browser is watching, so a Session's reference is never older than one poll
  // interval when its first spend lands. A failing read backs off instead of
  // hammering the provider.
  ctx.effect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const schedule = (): void => {
      if (stopped) return
      const delay =
        failures === 0 ? pollIntervalMs() : Math.min(MAX_BACKOFF_MS, pollIntervalMs() * 2 ** Math.min(failures, 3))
      timer = setTimeout(() => {
        void tick()
      }, delay)
    }
    const tick = async (): Promise<void> => {
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
    timer = setTimeout(() => {
      void tick()
    }, 1200)
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, 'dsh-balance-meter: balance poll')
}
