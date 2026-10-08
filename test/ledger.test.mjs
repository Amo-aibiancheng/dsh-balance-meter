/**
 * The ledger's contract, pinned by test.
 *
 * These cases exist because the balance-delta algorithm has exactly one job —
 * never charge a Session for money it did not spend — and several ways to get
 * it wrong. Each test names the failure it prevents.
 *
 * @module dsh-balance-meter/test/ledger.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildWallets, createLedger } from '../src/core/ledger.js'

/** Assert a money figure within the noise of binary addition. */
function assertMoney(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    message ?? `expected ${String(expected)}, got ${String(actual)}`,
  )
}

test('buildWallets keeps paid and bonus per currency', () => {
  const wallets = buildWallets(
    [{ currency: 'CNY', balance: '4.56' }],
    [{ currency: 'CNY', balance: '1.00' }],
  )
  assert.deepEqual(wallets, { CNY: { paid: 4.56, bonus: 1 } })
})

test('a Session created during this process measures from its birth', () => {
  const ledger = createLedger()
  const start = 1_000_000

  // The plugin was already watching, so an observation at the Session's birth
  // exists: that is the reference, and the delta from it is the Session's cost.
  ledger.recordReading({ time: start, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  const first = ledger.measureSession('s', start, start)
  assert.equal(first.spend, 0)
  assert.equal(first.baselineSource, 'session-start')
  assert.equal(first.baseline.paid, 10)

  ledger.recordReading({ time: start + 30_000, wallets: buildWallets([{ currency: 'CNY', balance: '9.6' }]) })
  const settled = ledger.measureSession('s', start, start + 30_000)
  assertMoney(settled.spend, 0.4)
  assert.equal(settled.sampleCount, 1)
  assert.equal(settled.observed, true)
  assert.equal(settled.partial, false)
})

test('a Session older than this process reports a partial lower bound', () => {
  const ledger = createLedger()
  const sessionCreated = 0
  // Nothing was observing when this Session was born; the earliest observation
  // is the best available "before", and the result is flagged partial.
  ledger.recordReading({ time: 500_000, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  const first = ledger.measureSession('resumed', sessionCreated, 500_000)
  assert.equal(first.baselineSource, 'first-observation')
  assert.equal(first.partial, true)
  assert.equal(first.spend, 0)
})

test('money the account spent before the Session existed is not charged to it', () => {
  const ledger = createLedger()
  const sessionStart = 9_000_000
  // Two drops happened while no Session of interest was alive. Because the
  // plugin was watching, the reference is the money AT the Session's birth.
  ledger.recordReading({ time: sessionStart - 120_000, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  ledger.recordReading({ time: sessionStart - 60_000, wallets: buildWallets([{ currency: 'CNY', balance: '8' }]) })
  ledger.recordReading({ time: sessionStart, wallets: buildWallets([{ currency: 'CNY', balance: '8' }]) })
  const born = ledger.measureSession('late', sessionStart, sessionStart)
  assert.equal(born.baseline.paid, 8)
  assert.equal(born.spend, 0, 'the earlier drops belong to whatever spent them')
  // The Session's own spend is measured from there.
  ledger.recordReading({ time: sessionStart + 30_000, wallets: buildWallets([{ currency: 'CNY', balance: '7.9' }]) })
  assertMoney(ledger.measureSession('late', sessionStart, sessionStart + 30_000).spend, 0.1)
})

test('a Session older than the process charges from the earliest observation, flagged partial', () => {
  const ledger = createLedger()
  const sessionCreated = 0
  // Nothing was observing at this Session's birth, so the earliest observation
  // becomes the reference: the result is a lower bound and says so.
  ledger.recordReading({ time: 100_000, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  ledger.measureSession('old', sessionCreated, 100_000)
  ledger.recordReading({ time: 130_000, wallets: buildWallets([{ currency: 'CNY', balance: '9' }]) })
  const measured = ledger.measureSession('old', sessionCreated, 130_000)
  assertMoney(measured.spend, 1)
  assert.equal(measured.partial, true)
  assert.equal(measured.baselineSource, 'first-observation')
})

test('the first drop after a Session is created counts as its own spend', () => {
  // The published limitation, pinned deliberately: the wallet is the account's,
  // so a drop observed while this Session is alive is attributed to it. Running
  // a second window against the same account is what makes this visible.
  const ledger = createLedger()
  const start = 5_000_000
  ledger.recordReading({ time: start, wallets: buildWallets([{ currency: 'CNY', balance: '5' }]) })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 20_000, wallets: buildWallets([{ currency: 'CNY', balance: '3' }]) })
  const measured = ledger.measureSession('s', start, start + 20_000)
  assertMoney(measured.spend, 2)
  assert.equal(measured.sampleCount, 1)
  assert.equal(measured.observed, true)
})

test('a top-up is recorded as a top-up, never as negative spend', () => {
  const ledger = createLedger()
  const start = 1_000
  ledger.recordReading({ time: start, wallets: buildWallets([{ currency: 'CNY', balance: '1' }]) })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 30_000, wallets: buildWallets([{ currency: 'CNY', balance: '0.8' }]) })
  ledger.recordReading({ time: start + 60_000, wallets: buildWallets([{ currency: 'CNY', balance: '20.8' }]) })
  const afterTopUp = ledger.measureSession('s', start, start + 60_000)
  assertMoney(afterTopUp.spend, 0.2, 'the drop before the top-up still counts')
  assert.equal(afterTopUp.topUp, 20)
  assert.equal(afterTopUp.baseline.paid, 20.8, 'the topped-up balance becomes the new reference')
})

test('re-reading the same balance can never be charged twice', () => {
  const ledger = createLedger()
  const start = 0
  ledger.recordReading({ time: start, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 30_000, wallets: buildWallets([{ currency: 'CNY', balance: '9' }]) })
  assertMoney(ledger.measureSession('s', start, start + 30_000).spend, 1)
  // The provider reports the same settled balance again a second later: an
  // identical observation is collapsed, so nothing is charged a second time.
  ledger.recordReading({ time: start + 31_000, wallets: buildWallets([{ currency: 'CNY', balance: '9' }]) })
  const measured = ledger.measureSession('s', start, start + 31_000)
  assertMoney(measured.spend, 1)
  assert.equal(measured.readingCount, 2, 'the duplicate moment was not stored')
})

test('two genuinely different balances are two settlements, however close', () => {
  // Regressed once: a minimum-spacing guard silently DROPPED a real drop that
  // arrived shortly after another one. Distinct amounts are distinct money, so
  // anything above the provider's read granularity must be charged.
  const ledger = createLedger()
  const start = 0
  ledger.recordReading({ time: start, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 300, wallets: buildWallets([{ currency: 'CNY', balance: '9.9' }]) })
  ledger.recordReading({ time: start + 600, wallets: buildWallets([{ currency: 'CNY', balance: '9.8' }]) })
  assertMoney(ledger.measureSession('s', start, start + 600).spend, 0.2)
})

test('the same balance read twice in the same instant is one observation', () => {
  // Two tabs polling at once, or one retry: identical money at one instant is
  // one observation, so it can never be charged twice. Reads are a produced
  // timeline, so two DIFFERENT balances share a millisecond only if the producer
  // stamps them that way; the shipped poll interval cannot.
  const ledger = createLedger()
  const now = 1_000_000
  ledger.recordReading({ time: now, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  ledger.measureSession('s', now, now)
  ledger.recordReading({ time: now, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  assert.equal(ledger.measureSession('s', now, now).readingCount, 1, 'the duplicate read was not stored')
  // A distinct moment carrying new money is a new observation.
  ledger.recordReading({ time: now + 45_000, wallets: buildWallets([{ currency: 'CNY', balance: '9.9' }]) })
  const measured = ledger.measureSession('s', now, now + 45_000)
  assertMoney(measured.spend, 0.1)
  assert.equal(measured.readingCount, 2)
})

test('a drop far larger than the wallet rebases instead of being charged', () => {
  const ledger = createLedger({ anomalyRatio: 0.5 })
  const start = 0
  ledger.recordReading({ time: start, wallets: buildWallets([{ currency: 'CNY', balance: '1' }]) })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 30_000, wallets: buildWallets([{ currency: 'CNY', balance: '0.9' }]) })
  assertMoney(ledger.measureSession('s', start, start + 30_000).spend, 0.1)
  // A 90% collapse is an account event (bonus expiry, wallet switch), not one
  // Session's token bill.
  ledger.recordReading({ time: start + 60_000, wallets: buildWallets([{ currency: 'CNY', balance: '0.1' }]) })
  assertMoney(ledger.measureSession('s', start, start + 60_000).spend, 0.1)
})

test('a vanished currency rebases instead of differencing across the gap', () => {
  const ledger = createLedger()
  const start = 0
  ledger.recordReading({ time: start, wallets: buildWallets([{ currency: 'CNY', balance: '4' }]) })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 30_000, wallets: buildWallets([{ currency: 'USD', balance: '0.5' }]) })
  const measured = ledger.measureSession('s', start, start + 30_000)
  assert.equal(measured.spend, 0)
  assert.equal(measured.baselineSource, 'rebased')
})

test('an out-of-order arrival keeps the newest money as the reference', () => {
  // A late sample inserted into the middle of the timeline must not become "the
  // wallet now", or the Session would be re-measured against older money.
  const ledger = createLedger()
  const start = 100_000
  ledger.recordReading({ time: start, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 60_000, wallets: buildWallets([{ currency: 'CNY', balance: '9' }]) })
  ledger.recordReading({ time: start + 30_000, wallets: buildWallets([{ currency: 'CNY', balance: '9.5' }]) })
  ledger.recordReading({ time: start + 90_000, wallets: buildWallets([{ currency: 'CNY', balance: '8.5' }]) })
  const measured = ledger.measureSession('s', start, start + 90_000)
  assertMoney(measured.spend, 1.5, 'both drops count, once each')
  assert.equal(measured.topUp, 0, 'a late reading is never mistaken for a top-up')
  assert.equal(measured.baseline.paid, 8.5)
})

test('sessions are measured independently over one shared wallet', () => {
  const ledger = createLedger()
  const ledgerStart = 0
  ledger.recordReading({ time: ledgerStart, wallets: buildWallets([{ currency: 'CNY', balance: '10' }]) })
  ledger.measureSession('a', ledgerStart, ledgerStart)
  // Session b starts after the reference was primed for a, and it anchors on
  // the money it can actually see.
  ledger.recordReading({ time: ledgerStart + 30_000, wallets: buildWallets([{ currency: 'CNY', balance: '9' }]) })
  ledger.measureSession('b', ledgerStart + 10_000, ledgerStart + 30_000)
  ledger.recordReading({ time: ledgerStart + 60_000, wallets: buildWallets([{ currency: 'CNY', balance: '8' }]) })
  const a = ledger.measureSession('a', ledgerStart, ledgerStart + 60_000)
  const b = ledger.measureSession('b', ledgerStart + 10_000, ledgerStart + 60_000)
  // `b` anchored on 9, so the 10 → 9 drop is `a`'s alone. From 9 → 8 both are
  // alive, so both report it — the documented account-level limitation, pinned
  // here so a change to attribution has to be deliberate.
  assertMoney(a.spend, 2)
  assertMoney(b.spend, 1)
  assert.equal(ledger.sessionIds().length, 2)
})

test('a Session the ledger never saw still reports a usable shape', () => {
  const ledger = createLedger()
  assert.equal(ledger.latest(), null)
  const measured = ledger.measureSession('new', 123, 456)
  assert.equal(measured.spend, 0)
  assert.equal(measured.observed, false)
  assert.equal(measured.baseline, null)
  assert.equal(measured.readingCount, 0)
  ledger.recordReading({ time: 1000, wallets: buildWallets([{ currency: 'CNY', balance: '5' }]) })
  assert.equal(ledger.readingAtOrAfter(500).total, 5)
  assert.equal(ledger.readingAtOrAfter(2000), null)
})

test('the token cross-check prices the buckets it is given', () => {
  const ledger = createLedger()
  ledger.ingestSessionEvent('s', 0, {
    type: 'assistant/message',
    data: {
      usage: { inputTokens: 1_000_000, cacheReadTokens: 2_000_000, outputTokens: 500_000, reasoningTokens: 500_000 },
    },
  })
  const estimate = ledger.estimateCost('s', { currency: 'CNY', hit: 0.1, miss: 3, out: 9 })
  assert.notEqual(estimate, null)
  // 1M miss × 3 + 2M hit × 0.1 + 1M out (500k + 500k reasoning) × 9 = 12.2
  assertMoney(estimate.cost, 12.2)
  assert.equal(estimate.tokens.total, 4_000_000)
  assert.equal(ledger.estimateCost('never-seen', { currency: 'CNY', hit: 0, miss: 0, out: 0 }), null)
})

test('forgetSession drops only the named Session', () => {
  const ledger = createLedger()
  ledger.recordReading({ time: 0, wallets: buildWallets([{ currency: 'CNY', balance: '1' }]) })
  ledger.measureSession('a', 0, 0)
  ledger.measureSession('b', 0, 0)
  ledger.forgetSession('a')
  assert.deepEqual(ledger.sessionIds(), ['b'])
})

test('a failed wallet read never fabricates a delta', () => {
  const ledger = createLedger()
  const start = 0
  ledger.recordReading({ time: start, wallets: buildWallets([{ currency: 'CNY', balance: '3' }]) })
  ledger.measureSession('s', start, start)
  // An unreadable balance arrives as NaN, not as zero.
  ledger.recordReading({ time: start + 30_000, wallets: buildWallets([{ currency: 'CNY', balance: 'oops' }]) })
  const measured = ledger.measureSession('s', start, start + 30_000)
  assert.equal(measured.spend, 0)
  assert.equal(measured.baselineSource, 'rebased')
})
