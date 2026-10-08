/**
 * The ledger's contract, pinned by test.
 *
 * These cases exist because the balance-delta algorithm has exactly one job —
 * never charge a Session for money it did not spend — and several ways to get it
 * wrong. Each test names the failure it prevents.
 *
 * Imported from `src/`, not from the bundle: this is the algorithm's own
 * contract, and testing the source keeps a bundling change from silently
 * rewriting what is under test.
 *
 * @module dsh-balance-meter/test/ledger.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildWallets, createLedger } from '../src/core/ledger.ts'

/**
 * Assert a money figure within the noise of binary addition.
 *
 * @param {number} actual - the measured amount.
 * @param {number} expected - the expected amount.
 * @param {string} [message] - failure context.
 */
function assertMoney(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `expected ${String(expected)}, got ${String(actual)}`)
}

/**
 * Shorthand: one CNY paid wallet from a decimal string.
 *
 * @param {string} balance - the amount as the provider reports it.
 * @returns {object} the wallet map.
 */
const cny = (balance) => buildWallets([{ currency: 'CNY', balance }])

test('buildWallets keeps paid and bonus per currency', () => {
  const wallets = buildWallets([{ currency: 'CNY', balance: '4.56' }], [{ currency: 'CNY', balance: '1.00' }])
  assert.deepEqual(wallets, { CNY: { paid: 4.56, bonus: 1 } })
})

test('a Session created during this process measures from its birth', () => {
  const ledger = createLedger()
  const start = 1_000_000

  ledger.recordReading({ time: start, wallets: cny('10') })
  const first = ledger.measureSession('s', start, start)
  assert.equal(first.spend, 0)
  assert.equal(first.baselineSource, 'session-start')
  assert.equal(first.baseline.paid, 10)

  ledger.recordReading({ time: start + 30_000, wallets: cny('9.6') })
  const settled = ledger.measureSession('s', start, start + 30_000)
  assertMoney(settled.spend, 0.4)
  assert.equal(settled.chargedCount, 1)
  assert.equal(settled.observed, true)
  assert.equal(settled.partial, false)
  assert.equal(settled.scope, 'session-window')
})

test('a Session older than this process reports a partial lower bound', () => {
  const ledger = createLedger()
  ledger.recordReading({ time: 500_000, wallets: cny('10') })
  const first = ledger.measureSession('resumed', 0, 500_000)
  assert.equal(first.baselineSource, 'first-observation')
  assert.equal(first.partial, true)
  assert.equal(first.spend, 0)
})

test('money the account spent before the Session existed is not charged to it', () => {
  const ledger = createLedger()
  const sessionStart = 9_000_000
  ledger.recordReading({ time: sessionStart - 120_000, wallets: cny('10') })
  ledger.recordReading({ time: sessionStart - 60_000, wallets: cny('8') })
  ledger.recordReading({ time: sessionStart, wallets: cny('8') })
  const born = ledger.measureSession('late', sessionStart, sessionStart)
  assert.equal(born.baseline.paid, 8)
  assert.equal(born.spend, 0, 'the earlier drops belong to whatever spent them')
  ledger.recordReading({ time: sessionStart + 30_000, wallets: cny('7.9') })
  assertMoney(ledger.measureSession('late', sessionStart, sessionStart + 30_000).spend, 0.1)
})

test('a top-up is recorded as a top-up, never as negative spend', () => {
  const ledger = createLedger()
  const start = 1_000
  ledger.recordReading({ time: start, wallets: cny('1') })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 30_000, wallets: cny('0.8') })
  ledger.recordReading({ time: start + 60_000, wallets: cny('20.8') })
  const afterTopUp = ledger.measureSession('s', start, start + 60_000)
  assertMoney(afterTopUp.spend, 0.2, 'the drop before the top-up still counts')
  assert.equal(afterTopUp.topUp, 20)
  assert.equal(afterTopUp.baseline.paid, 20.8, 'the topped-up balance becomes the new reference')
})

test('re-reading the same balance can never be charged twice', () => {
  const ledger = createLedger()
  const start = 0
  ledger.recordReading({ time: start, wallets: cny('10') })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 30_000, wallets: cny('9') })
  assertMoney(ledger.measureSession('s', start, start + 30_000).spend, 1)
  // The provider reports the same settled balance again a second later: an
  // identical observation is collapsed, so nothing is charged a second time.
  ledger.recordReading({ time: start + 31_000, wallets: cny('9') })
  const measured = ledger.measureSession('s', start, start + 31_000)
  assertMoney(measured.spend, 1)
  assert.equal(measured.readingCount, 2, 'the duplicate moment was not stored')
})

test('two genuinely different balances are two settlements, however close', () => {
  // Regressed once: a minimum-spacing guard silently DROPPED a real drop that
  // arrived shortly after another one. Distinct amounts are distinct money.
  const ledger = createLedger()
  const start = 0
  ledger.recordReading({ time: start, wallets: cny('10') })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 300, wallets: cny('9.9') })
  ledger.recordReading({ time: start + 600, wallets: cny('9.8') })
  assertMoney(ledger.measureSession('s', start, start + 600).spend, 0.2)
})

test('a drop far larger than the wallet rebases instead of being charged', () => {
  const ledger = createLedger({ anomalyRatio: 0.5 })
  const start = 0
  ledger.recordReading({ time: start, wallets: cny('1') })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 30_000, wallets: cny('0.9') })
  assertMoney(ledger.measureSession('s', start, start + 30_000).spend, 0.1)
  // A 90% collapse is an account event, not one Session's token bill.
  ledger.recordReading({ time: start + 60_000, wallets: cny('0.1') })
  assertMoney(ledger.measureSession('s', start, start + 60_000).spend, 0.1)
})

test('a live anomalyRatio getter is honoured per observation', () => {
  // The Host passes a getter so a Settings edit applies to the NEXT observation
  // without a remount. A decrease the current guard calls an account event is not
  // charged; one it accepts is.
  let ratio = 0.5
  const ledger = createLedger({ anomalyRatio: () => ratio })
  const start = 0
  ledger.recordReading({ time: start, wallets: cny('1') })
  ledger.measureSession('s', start, start)

  // 60% of the wallet: above the shipped 0.5 guard, so it rebases untouched.
  ledger.recordReading({ time: start + 30_000, wallets: cny('0.4') })
  assertMoney(ledger.measureSession('s', start, start + 30_000).spend, 0, 'nothing charged at ratio 0.5')

  // The same shape of drop is ordinary spending once the guard is relaxed: the
  // reference has already moved to 0.4, so this is measured from there.
  ratio = 0.9
  ledger.recordReading({ time: start + 60_000, wallets: cny('0.3') })
  assertMoney(ledger.measureSession('s', start, start + 60_000).spend, 0.1, 'charged at ratio 0.9')
  assert.equal(ledger.measureSession('s', start, start + 60_000).chargedCount, 1)
})

test('a vanished currency rebases instead of differencing across the gap', () => {
  const ledger = createLedger()
  const start = 0
  ledger.recordReading({ time: start, wallets: cny('4') })
  ledger.measureSession('s', start, start)
  ledger.recordReading({
    time: start + 30_000,
    wallets: buildWallets([{ currency: 'USD', balance: '0.5' }]),
  })
  const measured = ledger.measureSession('s', start, start + 30_000)
  assert.equal(measured.spend, 0)
  assert.equal(measured.baselineSource, 'rebased')
})

test('an out-of-order arrival keeps the newest money as the reference', () => {
  const ledger = createLedger()
  const start = 100_000
  ledger.recordReading({ time: start, wallets: cny('10') })
  ledger.measureSession('s', start, start)
  ledger.recordReading({ time: start + 60_000, wallets: cny('9') })
  // The late sample belongs BETWEEN the two stored ones.
  ledger.recordReading({ time: start + 30_000, wallets: cny('9.5') })
  ledger.recordReading({ time: start + 90_000, wallets: cny('8.5') })
  const measured = ledger.measureSession('s', start, start + 90_000)
  assertMoney(measured.spend, 1.5, 'both drops count, once each')
  assert.equal(measured.topUp, 0, 'a late reading is never mistaken for a top-up')
  assert.equal(measured.baseline.paid, 8.5, 'the reference is the newest money, not the late arrival')
})

test('sessions are measured independently over one shared wallet', () => {
  const ledger = createLedger()
  const ledgerStart = 0
  ledger.recordReading({ time: ledgerStart, wallets: cny('10') })
  ledger.measureSession('a', ledgerStart, ledgerStart)
  ledger.recordReading({ time: ledgerStart + 30_000, wallets: cny('9') })
  ledger.measureSession('b', ledgerStart + 10_000, ledgerStart + 30_000)
  ledger.recordReading({ time: ledgerStart + 60_000, wallets: cny('8') })
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
  ledger.recordReading({ time: 1000, wallets: cny('5') })
  assert.equal(ledger.readingAtOrAfter(500)?.paid, 5)
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

test('token accounting ignores unrelated events and malformed usage', () => {
  const ledger = createLedger()
  ledger.ingestSessionEvent('s', 0, { type: 'turn/start', data: {} })
  ledger.ingestSessionEvent('s', 0, { type: 'assistant/message', data: {} })
  ledger.ingestSessionEvent('s', 0, { type: 'assistant/message', data: { usage: null } })
  ledger.ingestSessionEvent('s', 0, { type: 'assistant/message', data: { usage: { inputTokens: 10 } } })
  const estimate = ledger.estimateCost('s', { currency: 'CNY', hit: 0, miss: 3, out: 0 })
  assert.equal(estimate.tokens.total, 10)
  assertMoney(estimate.cost, 0.00003)
})

test('forgetSession drops only the named Session accounting', () => {
  const ledger = createLedger()
  ledger.recordReading({ time: 0, wallets: cny('1') })
  ledger.measureSession('a', 0, 0)
  ledger.measureSession('b', 0, 0)
  ledger.ingestSessionEvent('a', 0, { type: 'assistant/message', data: { usage: { inputTokens: 5 } } })
  ledger.ingestSessionEvent('b', 0, { type: 'assistant/message', data: { usage: { inputTokens: 5 } } })
  ledger.forgetSession('a')
  assert.deepEqual(ledger.sessionIds(), ['b'])
  assert.equal(ledger.estimateCost('a', { currency: 'CNY', hit: 0, miss: 1, out: 0 }), null)
  assert.notEqual(ledger.estimateCost('b', { currency: 'CNY', hit: 0, miss: 1, out: 0 }), null)
})

test('a failed wallet read never fabricates a delta', () => {
  const ledger = createLedger()
  const start = 0
  ledger.recordReading({ time: start, wallets: cny('3') })
  ledger.measureSession('s', start, start)
  // An unreadable balance arrives as NaN, not as zero.
  ledger.recordReading({ time: start + 30_000, wallets: cny('oops') })
  const measured = ledger.measureSession('s', start, start + 30_000)
  assert.equal(measured.spend, 0)
  assert.equal(measured.baselineSource, 'rebased')
})
