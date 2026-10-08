/**
 * The balance-delta measurement algorithm — the pure, dependency-free core of
 * the plugin.
 *
 * THE IDEA
 * --------
 * DeepSeek exposes one exact number about money: the account wallet balance
 * (`/user/balance`, surfaced by the Host's `deepseekAccount` service). It
 * exposes no per-session cost query. The exact cost of one Session is therefore
 * recovered by differencing what the account owes before and after that
 * Session's work:
 *
 *     sessionSpend = Σ  max(0, walletAt(i-1) - walletAt(i))
 *
 * over the observations recorded while the Session was alive, skipping any
 * observation where the balance went UP (a top-up or a bonus grant is not
 * money spent). Because the provider charges the account as requests settle,
 * this difference converges on the official bill without re-pricing a single
 * token locally.
 *
 * WHAT THE MEASUREMENT CANNOT SEE
 * -------------------------------
 * The wallet belongs to the ACCOUNT, not to the Session. Concurrent spending
 * from another window or another machine lands in the same delta, and the
 * plugin states that limitation rather than hiding it. The delta is still the
 * honest number for the common single-client case, and the token cross-check
 * (see `estimateCost`) is reported beside it as an independent second opinion.
 *
 * TIME AND NOISE GUARDS
 * ---------------------
 * The provider's reported balance lags real activity, so a single sample may
 * still move later; the measurement is therefore a lower bound that converges,
 * never an over-count. Guards keep that convergence honest:
 *   - the timeline is ordered by `time`, so out-of-order arrivals cannot produce
 *     a spurious drop-then-rise pair;
 *   - an observation identical to the previous one is collapsed, so re-reading
 *     the same balance can never be charged twice;
 *   - a decrease larger than `anomalyRatio` of the previous balance is treated
 *     as an account event (bonus expiry, wallet switch) and rebases the
 *     baseline instead of being charged to the Session.
 *
 * CURRENCY
 * --------
 * Paid and bonus wallets are tracked per currency and summed for display.
 * Only the PAID wallet feeds the spend delta: bonus funds are granted and expire
 * rather than being spent down, so folding them in would manufacture cost. A
 * currency that disappears and reappears rebases instead of differencing across
 * the gap.
 *
 * @module dsh-balance-meter/core/ledger
 */

/** Tombstone for an amount that could not be read as a finite number. */
const UNREADABLE = Number.NaN

/**
 * Normalize one raw paid-wallet reading into the shape the ledger works with.
 *
 * The provider's wallet entries carry the amount in `balance`; a pre-summed
 * `bonusBalance` is honored only when a composition already folded the wallets
 * together.
 *
 * @param {unknown} raw - a `{ currency, balance }` record from any source.
 * @returns {{ currency: string, paid: number, bonus: number } | null} `null`
 *   when the record carries no usable currency.
 */
export function normalizeWallet(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const currency = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : ''
  if (currency === '') return null
  return {
    currency,
    paid: toAmount(raw.balance),
    bonus: typeof raw.bonusBalance === 'undefined' ? 0 : toAmount(raw.bonusBalance),
  }
}

/**
 * Coerce one amount to a finite number.
 *
 * @param {unknown} value - number, or the decimal string the API returns.
 * @returns {number} the finite amount, or `NaN` when unreadable.
 */
export function toAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : UNREADABLE
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : UNREADABLE
  }
  return UNREADABLE
}

/**
 * Build the wallet map keyed by currency from a list of raw wallets.
 *
 * @param {readonly unknown[]} wallets - paid wallet records.
 * @param {readonly unknown[]} [bonusWallets] - bonus wallet records.
 * @returns {Record<string, { paid: number, bonus: number }>} currency -> amounts.
 */
export function buildWallets(wallets, bonusWallets = []) {
  /** @type {Record<string, { paid: number, bonus: number }>} */
  const out = {}
  for (const raw of Array.isArray(wallets) ? wallets : []) {
    const normalized = normalizeWallet(raw)
    if (normalized === null) continue
    out[normalized.currency] = { paid: normalized.paid, bonus: 0 }
  }
  for (const raw of Array.isArray(bonusWallets) ? bonusWallets : []) {
    const normalized = normalizeWallet(raw)
    if (normalized === null) continue
    const existing = out[normalized.currency] ?? { paid: 0, bonus: 0 }
    // The bonus list uses the same `{ currency, balance }` shape, so its
    // `balance` IS the bonus amount. NaN (an unreadable field) is never added:
    // it would poison the total, and one bad field must not hide a good wallet.
    const bonus = Number.isFinite(normalized.paid) ? existing.bonus + normalized.paid : existing.bonus
    out[normalized.currency] = { paid: existing.paid, bonus }
  }
  return out
}

/**
 * Sum the displayable balance of every wallet (paid plus bonus).
 *
 * @param {Record<string, { paid: number, bonus: number }>} wallets - wallet map.
 * @returns {number} total balance, or `NaN` when nothing is readable.
 */
export function totalBalance(wallets) {
  let total = 0
  let seen = false
  for (const wallet of Object.values(wallets ?? {})) {
    if (Number.isFinite(wallet.paid)) {
      total += wallet.paid
      seen = true
    }
    if (Number.isFinite(wallet.bonus)) total += wallet.bonus
  }
  return seen ? total : UNREADABLE
}

/**
 * Pick the currency to headline: the paid currency with the largest balance,
 * falling back to the first readable one.
 *
 * @param {Record<string, { paid: number, bonus: number }>} wallets - wallet map.
 * @returns {string} currency code, or `''` when nothing is readable.
 */
export function primaryCurrency(wallets) {
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
 * Freeze one observation into the immutable record the ledger stores.
 *
 * @param {number} time - epoch milliseconds when the provider was read.
 * @param {Record<string, { paid: number, bonus: number }>} wallets - wallet map.
 * @returns {{ time: number, wallets: Record<string, { paid: number, bonus: number }>, total: number, currency: string, seq: number }} reading.
 */
export function createReading(time, wallets) {
  return {
    time: Number.isFinite(time) ? time : Date.now(),
    wallets: wallets ?? {},
    total: totalBalance(wallets),
    currency: primaryCurrency(wallets),
    seq: 0,
  }
}

/**
 * Compare two readings for identity (same moment, same money).
 *
 * @param {object | null} a - earlier reading.
 * @param {object | null} b - later reading.
 * @returns {boolean} `true` when both describe the same observation.
 */
export function sameObservation(a, b) {
  if (a === null || b === null) return a === b
  if (a.time !== b.time) return false
  const keys = new Set([...Object.keys(a.wallets ?? {}), ...Object.keys(b.wallets ?? {})])
  for (const key of keys) {
    const left = a.wallets?.[key] ?? { paid: 0, bonus: 0 }
    const right = b.wallets?.[key] ?? { paid: 0, bonus: 0 }
    if (left.paid !== right.paid || left.bonus !== right.bonus) return false
  }
  return true
}

/**
 * A comparable identity string for one wallet map.
 *
 * @param {Record<string, { paid: number, bonus: number }>} wallets - wallet map.
 * @returns {string} a stable key, currency-sorted.
 */
function walletKey(wallets) {
  return Object.keys(wallets ?? {})
    .sort()
    .map((currency) => `${currency}:${String(wallets[currency].paid)}:${String(wallets[currency].bonus)}`)
    .join('|')
}

/** Default guard values; the Host overrides them from plugin config. */
export const DEFAULT_LIMITS = {
  /** A single drop larger than this fraction of the previous balance rebases instead of counting. */
  anomalyRatio: 0.5,
}

/**
 * How close two reads carrying identical money must be to count as one
 * observation. A provider cannot report two different settlements at one balance
 * inside this window, so treating them as one makes a retry or a duplicate poll
 * free; a longer gap keeps its own observation, because a Session's baseline may
 * depend on it.
 */
const SAME_MONEY_WINDOW_MS = 1000

/**
 * Create an empty ledger. One ledger owns one account's observation timeline
 * plus one spend accumulator per Session.
 *
 * @param {Partial<typeof DEFAULT_LIMITS>} [limits] - guard overrides.
 * @returns {object} ledger handle with `recordReading`, `measureSession`,
 *   `ingestSessionEvent`, `snapshot`, `sessionIds`.
 */
export function createLedger(limits = {}) {
  /** A guard may be a number or a live getter, so a settings edit needs no remount. */
  const limit = (field) => {
    const value = limits[field] ?? DEFAULT_LIMITS[field]
    return typeof value === 'function' ? Number(value()) : Number(value)
  }
  /** @type {object[]} ascending-by-time observation timeline (newest last). */
  let readings = []
  /** @type {object | null} newest observation BY TIME — what the wallet is now. */
  let latest = null
  /**
   * @type {object | null} the observation the previous push stored. Deduplication
   * compares against this, not against {@link latest}: a late arrival inserted
   * into the middle of the timeline must not become the thing a repeated read is
   * compared to.
   */
  let cursor = null
  /** Wallet identity of the stored observation, for repeated reads. */
  let cursorKey = ''
  /** @type {Map<string, object>} sessionId -> spend accumulator. */
  const sessions = new Map()
  /** @type {Map<string, object>} sessionId -> token accounting per model. */
  const tokens = new Map()
  let sequence = 0

  /**
   * Insert chronologically, collapsing duplicate moments, and trim the tail.
   *
   * @param {object} reading - the observation to store.
   * @returns {object} the stored (canonical) reading.
   */
  function pushReading(reading) {
    const last = readings.length === 0 ? null : readings[readings.length - 1]
    if (last !== null && sameObservation(last, reading)) return last
    reading.seq = ++sequence
    if (last !== null && reading.time < last.time) {
      let at = readings.length - 1
      while (at > 0 && readings[at - 1].time > reading.time) at -= 1
      readings.splice(at, 0, reading)
      return reading
    }
    readings.push(reading)
    // 600 samples at the shipped 75s cadence is ~12 hours of history: far more
    // than any Session needs, and a hard bound on memory.
    if (readings.length > 600) readings.splice(0, readings.length - 600)
    return reading
  }

  /**
   * Find the first stored observation at or after one instant.
   *
   * @param {number} time - epoch milliseconds.
   * @returns {object | null} the seed observation, or `null` when none is new enough.
   */
  function seedAt(time) {
    for (const reading of readings) {
      if (reading.time >= time) return reading    }
    return null
  }

  /**
   * Get or create the accumulator of one Session.
   *
   * @param {string} sessionId - the Session id.
   * @param {number} createdMs - Session creation time in epoch milliseconds.
   * @returns {object} the accumulator.
   */
  function accumulator(sessionId, createdMs) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        createdMs: Number.isFinite(createdMs) ? createdMs : Date.now(),
        baseline: null,
        baselineSource: 'none',
        topUp: 0,
        spend: 0,
        sampleCount: 0,
        lastSampleMs: 0,
        partial: false,
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
   * @param {object} state - the Session accumulator.
   * @param {number} nowMs - current epoch milliseconds.
   * @returns {boolean} `true` when a baseline was adopted on this call.
   */
  function seedBaseline(state, nowMs) {
    if (state.baseline !== null) return false
    let seed = seedAt(state.createdMs)
    if (seed === null) {
      // No observation is old enough to represent the Session's birth (the
      // Session predates this process). The OLDEST known observation is still
      // the best available reference: using it measures everything since then,
      // while using the newest would hide spending that already happened. The
      // late adoption is published as a partial lower bound either way.
      if (readings.length === 0) return false
      seed = readings[0]
    }
    state.baseline = seed
    state.baselineSource = seed.time - state.createdMs <= 60000 ? 'session-start' : 'first-observation'
    state.partial = state.baselineSource !== 'session-start'
    return true
  }

  /**
   * Record one wallet observation and move every live Session's accumulator.
   *
   * @param {{ time?: number, wallets?: Record<string, unknown>, balance?: readonly unknown[], bonusWallets?: readonly unknown[] }} input - observation.
   * @returns {object} the stored reading.
   */
  function recordReading(input) {
    const time = Number.isFinite(input?.time) ? Number(input.time) : Date.now()
    const wallets = input?.wallets ?? buildWallets(input?.balance ?? [], input?.bonusWallets ?? [])
    const key = walletKey(wallets)
    if (cursor !== null && key === cursorKey && Math.abs(time - cursor.time) <= SAME_MONEY_WINDOW_MS) {
      // The same money read again a moment later is one observation sampled
      // twice — a retry, a reconnect, a double poll — and must never become a
      // second settlement. The window is deliberately small: the same balance an
      // hour later is a REAL observation, and dropping it would cost a Session
      // its baseline.
      return cursor
    }
    const reading = pushReading(createReading(time, wallets))
    cursor = reading
    cursorKey = key
    latest = maxReading()
    for (const state of sessions.values()) {
      if (state.baseline === null) seedBaseline(state, time)
      // One writer owns the reference, so the rules cannot fight over it:
      // `classify` only decides, and this loop is the only place that moves the
      // reference. `null` means the observation changes nothing for this
      // Session (it is not newer than the reference) — which is exactly what an
      // out-of-order arrival that has already been replayed looks like.
      const outcome = classify(state, reading)
      if (outcome === null) continue
      state.baseline = reading
      if (outcome.kind === 'charged') {
        state.spend += outcome.amount
        state.sampleCount += 1
        state.lastSampleMs = reading.time
      } else if (outcome.kind === 'rebased') {
        state.topUp += outcome.topUp
        state.baselineSource = 'rebased'
      }
    }
    return reading
  }

  /**
   * The newest observation by time. A late arrival can be inserted anywhere in
   * the timeline, so "what the wallet is now" is a scan, not the array tail.
   *
   * @returns {object | null} the newest reading.
   */
  function maxReading() {
    if (readings.length === 0) return null
    let newest = readings[0]
    for (const reading of readings) {
      if (reading.time > newest.time) newest = reading
    }
    return newest
  }

  /**
   * Decide what one newer observation means for one Session, without touching
   * any state. The caller is the single writer of the reference, which keeps
   * "charge this drop" and "move past this drop" from fighting over one field.
   *
   * @param {object} state - the Session accumulator.
   * @param {object} reading - the newer observation.
   * @returns {{ kind: 'charged', amount: number } | { kind: 'rebased', topUp: number } | { kind: 'jumped' } | null} the decision, or `null` when the observation changes nothing.
   */
  function classify(state, reading) {
    if (reading.time <= state.baseline.time) return null
    const currency = state.baseline.currency
    const before = state.baseline.wallets?.[currency]?.paid
    const after = reading.wallets?.[currency]?.paid
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      // The paid wallet of the baseline currency vanished (currency switch, or a
      // failed read): rebase on the new money rather than inventing a delta.
      return { kind: 'rebased', topUp: 0 }
    }
    const delta = before - after
    if (delta > 0) {
      // No minimum-spacing guard is needed here, and adding one would only lose
      // money: a drop is charged once per DISTINCT balance moved past, because
      // the reference advances to the observed amount. Re-reading the same
      // balance is deduplicated by value in pushReading, so a settlement cannot
      // be counted twice, and two genuinely different balances are two real
      // settlements however close together they arrive.
      if (before > 0 && delta > before * limit('anomalyRatio')) {
        // Too large to be one Session's bill: an account-level event.
        return { kind: 'jumped' }
      }
      return { kind: 'charged', amount: delta }
    }
    if (delta < 0) {
      // The account grew (top-up, refund, bonus grant): not spending, and the
      // growth becomes the reference so later spend stays exact.
      return { kind: 'rebased', topUp: -delta }
    }
    return { kind: 'jumped' }
  }

  /**
   * The first stored observation at or after one instant — the timeline read
   * the Host uses to anchor a Session whose creation precedes the first request.
   *
   * @param {number} time - epoch milliseconds.
   * @returns {object | null} the seed observation, or `null` when none is new enough.
   */
  function readingAtOrAfter(time) {
    return seedAt(time)
  }

  /**
   * Account one durable Session event: the token cross-check's only input.
   *
   * @param {string} sessionId - the Session id.
   * @param {number} createdMs - Session creation time in epoch milliseconds.
   * @param {{ type?: string, data?: object }} event - a durable Session event.
   * @returns {void}
   */
  function ingestSessionEvent(sessionId, createdMs, event) {
    const data = event?.data
    if (event?.type !== 'assistant/message' || data === null || typeof data !== 'object') return
    const usage = data.usage
    if (usage === null || typeof usage !== 'object') return
    const buckets = tokens.get(sessionId) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    buckets.input += toCount(usage.inputTokens)
    buckets.cacheRead += toCount(usage.cacheReadTokens)
    buckets.cacheWrite += toCount(usage.cacheWriteTokens)
    buckets.output += toCount(usage.outputTokens) + toCount(usage.reasoningTokens)
    tokens.set(sessionId, buckets)
    accumulator(sessionId, createdMs)
  }

  /**
   * Read one Session's current measurement.
   *
   * @param {string} sessionId - the Session id.
   * @param {number} createdMs - Session creation time in epoch milliseconds.
   * @param {number} nowMs - current epoch milliseconds.
   * @returns {object} the measurement payload (never `null`).
   */
  function measureSession(sessionId, createdMs, nowMs) {
    const state = accumulator(sessionId, createdMs)
    seedBaseline(state, nowMs)
    const current = latest
    const wallet = current?.wallets?.[current.currency]
    const fresh = current !== null && nowMs - current.time <= 5 * 60000
    const observed = state.lastSampleMs > 0
    return {
      sessionId,
      createdMs: state.createdMs,
      baseline:
        state.baseline === null
          ? null
          : {
              time: state.baseline.time,
              currency: state.baseline.currency,
              paid: state.baseline.wallets?.[state.baseline.currency]?.paid ?? null,
            },
      baselineSource: state.baselineSource,
      partial: state.partial,
      observed,
      spend: state.spend,
      topUp: state.topUp,
      sampleCount: state.sampleCount,
      windowMs: state.baseline === null ? 0 : Math.max(0, (current?.time ?? nowMs) - state.baseline.time),
      readingCount: readings.length,
    }
  }

  /**
   * The token cross-check: what the Session's tokens would cost at the
   * configured rates. This never drives the headline number.
   *
   * @param {string} sessionId - the Session id.
   * @param {{ currency: string, hit: number, miss: number, out: number }} price - rates per million tokens.
   * @returns {{ tokens: object, cost: number, currency: string } | null} estimate, or `null` without usage.
   */
  function estimateCost(sessionId, price) {
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
    /**
     * Record one observation.
     * @param {object} input - observation input.
     * @returns {object} the stored reading.
     */
    recordReading,
    /**
     * Read one Session's measurement.
     * @param {string} sessionId - the Session id.
     * @param {number} createdMs - Session creation time in epoch milliseconds.
     * @param {number} [nowMs] - current epoch milliseconds.
     * @returns {object} the measurement payload.
     */
    measureSession: (sessionId, createdMs, nowMs = Date.now()) => measureSession(sessionId, createdMs, nowMs),
    /**
     * Account one durable Session event.
     * @param {string} sessionId - the Session id.
     * @param {number} createdMs - Session creation time in epoch milliseconds.
     * @param {object} event - a durable Session event.
     * @returns {void}
     */
    ingestSessionEvent,
    /**
     * The token cross-check for one Session.
     * @param {string} sessionId - the Session id.
     * @param {object} price - rates per million tokens.
     * @returns {object | null} estimate, or `null` without usage.
     */
    estimateCost,
    /**
     * The newest observation, or `null` before the first read.
     * @returns {object | null} newest reading.
     */
    latest: () => latest,
    /**
     * The first stored observation at or after one instant.
     * @param {number} time - epoch milliseconds.
     * @returns {object | null} seed observation.
     */
    readingAtOrAfter,
    /**
     * Every Session the ledger has seen.
     * @returns {string[]} Session ids.
     */
    sessionIds: () => [...sessions.keys()],
    /**
     * Drop one Session's accumulators (Session disposal).
     * @param {string} sessionId - the Session id.
     * @returns {void}
     */
    forgetSession: (sessionId) => {
      sessions.delete(sessionId)
      tokens.delete(sessionId)
    },
  }
}

/**
 * Coerce one usage figure to a non-negative finite count.
 *
 * @param {unknown} value - raw usage field.
 * @returns {number} the count, or 0.
 */
function toCount(value) {
  const amount = toAmount(value)
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}
