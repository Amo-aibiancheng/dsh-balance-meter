/**
 * The balance-delta measurement algorithm — the pure, dependency-free core of
 * the plugin.
 *
 * THE IDEA
 * --------
 * DeepSeek exposes exactly one exact number about money: the account wallet
 * balance (surfaced by the Host's `deepseekAccount` service). It exposes no
 * per-session cost query. One Session's exact cost is therefore recovered by
 * differencing what the account owed before and after that Session's work:
 *
 *     sessionSpend = Σ max(0, walletAt(i-1) - walletAt(i))
 *
 * summed over the observations recorded while the Session was alive, skipping any
 * observation where the balance went UP (a top-up or a grant is not money
 * spent). Because the provider charges the account as requests settle, this
 * difference converges on the official bill without re-pricing a token locally.
 *
 * WHAT IT CANNOT SEE
 * ------------------
 * The wallet belongs to the ACCOUNT, not to the Session. Concurrent spending from
 * another window or another machine lands in the same delta, and the plugin says
 * so rather than hiding it (see `sessionShare` in the payload). The delta is
 * still the honest number for the common single-client case, and the token
 * cross-check is reported beside it as an independent second opinion.
 *
 * GUARDS
 * ------
 * The provider's reported balance lags real activity, so a single sample can
 * still move later: the measurement is a lower bound that converges, never an
 * over-count. Four rules keep that convergence honest:
 *   - the timeline is ordered by `time`, so a late arrival cannot invent a
 *     drop-then-rise pair, and "the balance now" is always the newest one;
 *   - re-reading the same money is collapsed into the observation already
 *     stored, which is what makes a retry or a double poll free;
 *   - a drop larger than `anomalyRatio` of the wallet is an account event
 *     (grant expiry, wallet switch) and rebases instead of being charged;
 *   - an unreadable amount is never treated as zero.
 *
 * @module dsh-balance-meter/ledger
 */

/** Tombstone for an amount that could not be read as a finite number. */
const UNREADABLE = Number.NaN

/** One currency's money, split the way the provider reports it. */
export interface WalletAmounts {
  /** 充值余额: the recharge wallet. This is the money spend is measured against. */
  readonly paid: number
  /** 赠金余额: granted funds. Reported beside `paid`, never summed with it. */
  readonly bonus: number
}

/** Wallet amounts keyed by currency code. */
export type WalletMap = Readonly<Record<string, WalletAmounts>>

/** One raw wallet record as the account provider returns it. */
export interface RawWallet {
  readonly currency?: string
  readonly balance?: string | number
  /** Present only when a composition already folded bonus into the entry. */
  readonly bonusBalance?: string | number
}

/** One frozen observation of the account. */
export interface Reading {
  /** Non-decreasing epoch milliseconds; the timeline's ordering key. */
  readonly time: number
  readonly wallets: WalletMap
  /** The headline money: `paid` of the primary currency. */
  readonly paid: number
  /** Grant money beside it, never added to `paid`. */
  readonly bonus: number
  /** Currency `paid`/`bonus` are denominated in. */
  readonly currency: string
  /** Monotonic publication sequence, for callers that must detect a new one. */
  seq: number
}

/** Per-Session accumulator state. */
export interface SessionState {
  readonly sessionId: string
  /** Durable Session creation time in epoch milliseconds. */
  createdMs: number
  /** The observation the Session's spend is measured from. */
  baseline: Reading | null
  /** Why the baseline is what it is; surfaced in the detail panel. */
  baselineSource: BaselineSource
  /** Growth observed while this Session was alive (top-ups, refunds). */
  topUp: number
  /** Money this Session is charged with, in `currency`. */
  spend: number
  /** Settlements charged so far. */
  chargedCount: number
  /** Whether anything has been charged yet (the panel's "待采样" state). */
  observed: boolean
  /** The measurement is a lower bound, not a complete window. */
  partial: boolean
  /** The last observation this Session's reference moved to. */
  lastMoveMs: number
}

/** How a Session's baseline was chosen. */
export type BaselineSource = 'none' | 'session-start' | 'first-observation' | 'rebased'

/** The measurement one Session reports. */
export interface SessionMeasurement {
  readonly sessionId: string
  readonly createdMs: number
  readonly baseline: { readonly time: number; readonly currency: string; readonly paid: number | null } | null
  readonly baselineSource: BaselineSource
  readonly partial: boolean
  readonly observed: boolean
  readonly spend: number
  readonly topUp: number
  readonly chargedCount: number
  readonly windowMs: number
  readonly readingCount: number
  /** How much of the account's movement this Session could be responsible for. */
  readonly scope: 'session-window'
}

/** Token usage accumulated for the cross-check. */
export interface TokenBuckets {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** The token-derived estimate, priced at configured rates. */
export interface CrossCheck {
  readonly tokens: TokenBuckets & { total: number }
  readonly cost: number
  readonly currency: string
}

/** Rates the cross-check prices with, per million tokens. */
export interface PriceTable {
  readonly currency: string
  readonly hit: number
  readonly miss: number
  readonly out: number
}

/** Guard knobs; the Host resolves them from plugin config. */
export interface LedgerLimits {
  /** A single drop above this fraction of the wallet is an account event. */
  anomalyRatio?: number | (() => number)
}

/** Input accepted by {@link Ledger.recordReading}. */
export interface ReadingInput {
  time?: number
  wallets?: WalletMap
  balance?: readonly RawWallet[]
  bonusWallets?: readonly RawWallet[]
}

/** The ledger handle. */
export interface Ledger {
  recordReading(input: ReadingInput): Reading
  measureSession(sessionId: string, createdMs: number, nowMs?: number): SessionMeasurement
  ingestSessionEvent(sessionId: string, createdMs: number, event: { type?: string; data?: unknown }): void
  estimateCost(sessionId: string, price: PriceTable): CrossCheck | null
  latest(): Reading | null
  readingAtOrAfter(time: number): Reading | null
  sessionIds(): string[]
  forgetSession(sessionId: string): void
}

/** A single allowance: a number, or a live getter so a settings edit applies at once. */
type Limit = number | (() => number)

/**
 * Coerce one amount to a finite number.
 *
 * @param value - number, or the decimal string the API returns.
 * @returns the finite amount, or `NaN` when unreadable.
 */
export function toAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : UNREADABLE
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : UNREADABLE
  }
  return UNREADABLE
}

/**
 * Normalize one raw paid-wallet record.
 *
 * The provider's wallet entries carry the amount in `balance`; a pre-summed
 * `bonusBalance` is honored only when a composition already folded them.
 *
 * @param raw - a `{ currency, balance }` record from any source.
 * @returns the normalized amounts, or `null` when the record has no currency.
 */
export function normalizeWallet(raw: unknown): { currency: string; paid: number; bonus: number } | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as RawWallet
  const currency = typeof record.currency === 'string' ? record.currency.toUpperCase() : ''
  if (currency === '') return null
  return {
    currency,
    paid: toAmount(record.balance),
    bonus: record.bonusBalance === undefined ? 0 : toAmount(record.bonusBalance),
  }
}

/**
 * Build the wallet map keyed by currency.
 *
 * The bonus list uses the same `{ currency, balance }` shape, so its `balance`
 * IS the bonus amount. An unreadable amount is never added: it would poison the
 * total, and one bad field must not hide a good wallet.
 *
 * @param wallets - paid wallet records.
 * @param bonusWallets - bonus wallet records.
 * @returns currency → amounts.
 */
export function buildWallets(
  wallets: readonly RawWallet[] | undefined,
  bonusWallets: readonly RawWallet[] | undefined = [],
): WalletMap {
  const out: Record<string, WalletAmounts> = {}
  for (const raw of wallets ?? []) {
    const normalized = normalizeWallet(raw)
    if (normalized === null) continue
    out[normalized.currency] = { paid: normalized.paid, bonus: 0 }
  }
  for (const raw of bonusWallets ?? []) {
    const normalized = normalizeWallet(raw)
    if (normalized === null) continue
    const existing = out[normalized.currency] ?? { paid: 0, bonus: 0 }
    const bonus = Number.isFinite(normalized.paid) ? existing.bonus + normalized.paid : existing.bonus
    out[normalized.currency] = { paid: existing.paid, bonus }
  }
  return out
}

/**
 * Pick the currency to headline: the paid currency with the largest balance,
 * falling back to the first readable one.
 *
 * @param wallets - wallet map.
 * @returns currency code, or `''` when nothing is readable.
 */
export function primaryCurrency(wallets: WalletMap | undefined): string {
  let best = ''
  let bestAmount = -Infinity
  for (const [currency, wallet] of Object.entries(wallets ?? {})) {
    if (!Number.isFinite(wallet.paid)) continue
    if (wallet.paid > bestAmount) {
      bestAmount = wallet.paid
      best = currency
    }
  }
  if (best !== '') return best
  return Object.keys(wallets ?? {})[0] ?? ''
}

/**
 * Freeze one observation into the immutable record the timeline stores.
 *
 * @param time - epoch milliseconds when the provider was read.
 * @param wallets - wallet map.
 * @returns the reading.
 */
export function createReading(time: number, wallets: WalletMap): Reading {
  const currency = primaryCurrency(wallets)
  const wallet = wallets[currency]
  return {
    time: Number.isFinite(time) ? time : Date.now(),
    wallets,
    paid: wallet !== undefined && Number.isFinite(wallet.paid) ? wallet.paid : UNREADABLE,
    bonus: wallet !== undefined && Number.isFinite(wallet.bonus) ? wallet.bonus : 0,
    currency,
    seq: 0,
  }
}

/**
 * Compare two readings for identity (same moment, same money).
 *
 * @param a - earlier reading.
 * @param b - later reading.
 * @returns `true` when both describe one observation.
 */
export function sameObservation(a: Reading | null, b: Reading | null): boolean {
  if (a === null || b === null) return a === b
  if (a.time !== b.time) return false
  const keys = new Set([...Object.keys(a.wallets), ...Object.keys(b.wallets)])
  for (const key of keys) {
    const left = a.wallets[key] ?? { paid: 0, bonus: 0 }
    const right = b.wallets[key] ?? { paid: 0, bonus: 0 }
    if (left.paid !== right.paid || left.bonus !== right.bonus) return false
  }
  return true
}

/**
 * A comparable identity string for one wallet map.
 *
 * @param wallets - wallet map.
 * @returns stable, currency-sorted key.
 */
function walletKey(wallets: WalletMap): string {
  return Object.keys(wallets)
    .sort()
    .map((currency) => {
      const wallet = wallets[currency] as WalletAmounts
      return `${currency}:${String(wallet.paid)}:${String(wallet.bonus)}`
    })
    .join('|')
}

/** What one observation means for one Session, before any state is written. */
type Decision =
  | { readonly kind: 'charged'; readonly amount: number }
  | { readonly kind: 'rebased'; readonly topUp: number }
  | { readonly kind: 'jumped' }
  | null

/**
 * Create an empty ledger. One ledger owns one account's observation timeline
 * plus one spend accumulator per Session.
 *
 * @param limits - guard overrides from plugin config.
 * @returns the ledger.
 */
export function createLedger(limits: LedgerLimits = {}): Ledger {
  const anomalyRatio = (limits.anomalyRatio ?? 0.5) as Limit
  const ratio = (): number => (typeof anomalyRatio === 'function' ? Number(anomalyRatio()) : Number(anomalyRatio))

  /** Ascending-by-time observation timeline (newest last). */
  let readings: Reading[] = []
  /** Newest observation BY TIME — what the wallet is now. */
  let latest: Reading | null = null
  /** The observation the previous push stored; deduplication compares to this. */
  let cursor: Reading | null = null
  /** Wallet identity of {@link cursor}. */
  let cursorKey = ''
  /** Session accumulators keyed by Session id. */
  const sessions = new Map<string, SessionState>()
  /** Token accounting keyed by Session id. */
  const tokens = new Map<string, TokenBuckets>()
  let sequence = 0

  /**
   * Insert chronologically, collapsing duplicate moments, and trim the tail.
   *
   * @param reading - the observation to store.
   * @returns the stored (canonical) reading.
   */
  function pushReading(reading: Reading): Reading {
    const last = readings.length === 0 ? null : (readings[readings.length - 1] as Reading)
    if (last !== null && sameObservation(last, reading)) return last
    reading.seq = ++sequence
    if (last !== null && reading.time < last.time) {
      let at = readings.length - 1
      while (at > 0 && (readings[at - 1] as Reading).time > reading.time) at -= 1
      readings.splice(at, 0, reading)
      return reading
    }
    readings.push(reading)
    // 600 samples at the shipped cadence is many hours of history: far more than
    // any Session needs, and a hard bound on memory.
    if (readings.length > 600) readings.splice(0, readings.length - 600)
    return reading
  }

  /**
   * The newest observation by time. A late arrival can be inserted anywhere, so
   * "what the wallet is now" is a scan, not the array tail.
   *
   * @returns the newest reading.
   */
  function maxReading(): Reading | null {
    if (readings.length === 0) return null
    let newest = readings[0] as Reading
    for (const reading of readings) {
      if (reading.time > newest.time) newest = reading
    }
    return newest
  }

  /**
   * Find the first stored observation at or after one instant.
   *
   * @param time - epoch milliseconds.
   * @returns the seed observation, or `null` when none is new enough.
   */
  function seedAt(time: number): Reading | null {
    for (const reading of readings) {
      if (reading.time >= time) return reading
    }
    return null
  }

  /**
   * Get or create one Session's accumulator, keeping the earliest known birth.
   *
   * @param sessionId - the Session id.
   * @param createdMs - Session creation time in epoch milliseconds.
   * @returns the accumulator.
   */
  function accumulator(sessionId: string, createdMs: number): SessionState {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        createdMs: Number.isFinite(createdMs) ? createdMs : Date.now(),
        baseline: null,
        baselineSource: 'none',
        topUp: 0,
        spend: 0,
        chargedCount: 0,
        observed: false,
        partial: false,
        lastMoveMs: 0,
      }
      sessions.set(sessionId, state)
    } else if (Number.isFinite(createdMs) && createdMs < state.createdMs) {
      // A resumed Session reports its durable creation time, which can precede
      // the first sighting; keep the earliest known instant as the timeline.
      state.createdMs = createdMs
    }
    return state
  }

  /**
   * Adopt the baseline observation of one Session if it has none yet.
   *
   * @param state - the Session accumulator.
   * @returns `true` when a baseline was adopted on this call.
   */
  function seedBaseline(state: SessionState): boolean {
    if (state.baseline !== null) return false
    let seed = seedAt(state.createdMs)
    if (seed === null) {
      // No observation is old enough to represent the Session's birth (it
      // predates this process). The OLDEST known observation is still the best
      // available reference: using it measures everything since then, while
      // using the newest would hide spending that already happened.
      const oldest = readings[0]
      if (oldest === undefined) return false
      seed = oldest
    }
    state.baseline = seed
    state.baselineSource = seed.time - state.createdMs <= 60_000 ? 'session-start' : 'first-observation'
    state.partial = state.baselineSource !== 'session-start'
    return true
  }

  /**
   * Decide what one newer observation means for one Session, without touching
   * any state. The caller is the single writer of the reference, which keeps
   * "charge this drop" and "move past this drop" from fighting over one field.
   *
   * @param state - the Session accumulator.
   * @param reading - the newer observation.
   * @returns the decision, or `null` when the observation changes nothing.
   */
  function classify(state: SessionState, reading: Reading): Decision {
    const baseline = state.baseline
    if (baseline === null || reading.time <= baseline.time) return null
    const currency = baseline.currency
    const before = baseline.wallets[currency]?.paid
    const after = reading.wallets[currency]?.paid
    if (before === undefined || after === undefined || !Number.isFinite(before) || !Number.isFinite(after)) {
      // The paid wallet of the baseline currency vanished (currency switch, or a
      // failed read): rebase on the new money rather than inventing a delta.
      return { kind: 'rebased', topUp: 0 }
    }
    const delta = before - after
    if (delta > 0) {
      // No minimum-spacing guard belongs here, and adding one would only lose
      // money: a drop is charged once per DISTINCT balance moved past, because
      // the reference advances to the observed amount. Re-reading the same money
      // is collapsed before this point, so a settlement cannot be counted twice,
      // while two genuinely different balances are two real settlements however
      // close together they arrive.
      if (before > 0 && delta > before * ratio()) return { kind: 'jumped' }
      return { kind: 'charged', amount: delta }
    }
    if (delta < 0) {
      // The account grew (top-up, refund, grant): not spending, and the growth
      // becomes the reference so later spend stays exact.
      return { kind: 'rebased', topUp: -delta }
    }
    return { kind: 'jumped' }
  }

  /**
   * Record one wallet observation and move every live Session's accumulator.
   *
   * @param input - the observation.
   * @returns the stored reading.
   */
  function recordReading(input: ReadingInput): Reading {
    const time = Number.isFinite(input.time) ? Number(input.time) : Date.now()
    const wallets = input.wallets ?? buildWallets(input.balance, input.bonusWallets)
    const key = walletKey(wallets)
    if (cursor !== null && key === cursorKey && Math.abs(time - cursor.time) <= SAME_MONEY_WINDOW_MS) {
      // The same money read again a moment later is one observation sampled
      // twice — a retry, a reconnect, a double poll — and must never become a
      // second settlement. The window is small on purpose: the same balance much
      // later is a REAL observation, and dropping it would cost a baseline.
      return cursor
    }
    const reading = pushReading(createReading(time, wallets))
    cursor = reading
    cursorKey = key
    latest = maxReading()
    for (const state of sessions.values()) {
      if (state.baseline === null) seedBaseline(state)
      // One writer owns the reference, so the rules cannot fight over it:
      // `classify` only decides, and this loop is the only place that moves it.
      const outcome = classify(state, reading)
      if (outcome === null) continue
      state.baseline = reading
      state.lastMoveMs = reading.time
      if (outcome.kind === 'charged') {
        state.spend += outcome.amount
        state.chargedCount += 1
        state.observed = true
      } else if (outcome.kind === 'rebased') {
        state.topUp += outcome.topUp
        state.baselineSource = 'rebased'
      }
    }
    return reading
  }

  /**
   * Read one Session's current measurement.
   *
   * @param sessionId - the Session id.
   * @param createdMs - Session creation time in epoch milliseconds.
   * @param nowMs - current epoch milliseconds.
   * @returns the measurement.
   */
  function measureSession(sessionId: string, createdMs: number, nowMs = Date.now()): SessionMeasurement {
    const state = accumulator(sessionId, createdMs)
    seedBaseline(state)
    const baseline = state.baseline
    const current = latest
    return {
      sessionId,
      createdMs: state.createdMs,
      baseline:
        baseline === null
          ? null
          : {
              time: baseline.time,
              currency: baseline.currency,
              paid: baseline.wallets[baseline.currency]?.paid ?? null,
            },
      baselineSource: state.baselineSource,
      partial: state.partial,
      observed: state.observed,
      spend: state.spend,
      topUp: state.topUp,
      chargedCount: state.chargedCount,
      windowMs: baseline === null ? 0 : Math.max(0, (current?.time ?? nowMs) - baseline.time),
      readingCount: readings.length,
      // The wallet is the account's: this figure covers the Session's window, and
      // anything else spending on the same account lands in it too.
      scope: 'session-window',
    }
  }

  /**
   * Account one durable Session event: the token cross-check's only input.
   *
   * @param sessionId - the Session id.
   * @param createdMs - Session creation time in epoch milliseconds.
   * @param event - a durable Session event.
   */
  function ingestSessionEvent(sessionId: string, createdMs: number, event: { type?: string; data?: unknown }): void {
    if (event.type !== 'assistant/message') return
    const data = event.data
    if (data === null || typeof data !== 'object') return
    const usage = (data as { usage?: unknown }).usage
    if (usage === null || typeof usage !== 'object') return
    const record = usage as Record<string, unknown>
    const buckets = tokens.get(sessionId) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    buckets.input += toCount(record.inputTokens)
    buckets.cacheRead += toCount(record.cacheReadTokens)
    buckets.cacheWrite += toCount(record.cacheWriteTokens)
    // Reasoning tokens bill as output.
    buckets.output += toCount(record.outputTokens) + toCount(record.reasoningTokens)
    tokens.set(sessionId, buckets)
    accumulator(sessionId, createdMs)
  }

  /**
   * The token cross-check: what the Session's tokens would cost at the
   * configured rates. This never drives the headline number.
   *
   * @param sessionId - the Session id.
   * @param price - rates per million tokens.
   * @returns the estimate, or `null` without usage.
   */
  function estimateCost(sessionId: string, price: PriceTable): CrossCheck | null {
    const buckets = tokens.get(sessionId)
    if (buckets === undefined) return null
    const total = buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output
    if (total === 0) return null
    const perMillion = 1e6
    const cost =
      (buckets.input / perMillion) * price.miss +
      (buckets.cacheRead / perMillion) * price.hit +
      (buckets.cacheWrite / perMillion) * price.miss +
      (buckets.output / perMillion) * price.out
    return { tokens: { ...buckets, total }, cost, currency: price.currency }
  }

  return {
    recordReading,
    measureSession,
    ingestSessionEvent,
    estimateCost,
    latest: () => latest,
    readingAtOrAfter: seedAt,
    sessionIds: () => [...sessions.keys()],
    forgetSession: (sessionId: string) => {
      sessions.delete(sessionId)
      tokens.delete(sessionId)
    },
  }
}

/**
 * How close two reads carrying identical money must be to count as one
 * observation. A provider cannot report two different settlements at one balance
 * inside this window, so treating them as one makes a retry or a duplicate poll
 * free; a longer gap keeps its own observation, because a baseline may need it.
 */
const SAME_MONEY_WINDOW_MS = 1000

/**
 * Coerce one usage figure to a non-negative finite count.
 *
 * @param value - raw usage field.
 * @returns the count, or 0.
 */
function toCount(value: unknown): number {
  const amount = toAmount(value)
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}
