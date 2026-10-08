/**
 * Money and duration formatting, pinned by test.
 *
 * These rules are the difference between a readout and a misleading one: one
 * turn's cost is routinely a few 角, so a two-decimal format would render real
 * spending as ¥0.00, and an unknown currency code must not blank the entry.
 *
 * @module dsh-balance-meter/test/format.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { formatClock, formatCount, formatMoney, formatSpan } from '../src/client/format.ts'

test('sub-unit amounts keep four decimals', () => {
  // ¥0.21 loses the precision this plugin exists to show; ¥0.2130 does not.
  assert.match(formatMoney(0.213, 'CNY'), /0\.2130/)
  assert.match(formatMoney(0.0001, 'CNY'), /0\.0001/)
  // A unit or more reads as ordinary money.
  assert.match(formatMoney(4.56, 'CNY'), /4\.56/)
})

test('unreadable money is a placeholder, never a number', () => {
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatMoney(value, 'CNY'), '--')
  }
})

test('an unknown currency code still renders the amount', () => {
  const text = formatMoney(1.5, 'XYZ')
  assert.match(text, /1\.50/)
  assert.doesNotMatch(text, /NaN/)
})

test('an empty currency falls back to CNY', () => {
  assert.match(formatMoney(2, ''), /2\.00/)
})

test('durations read compactly in Chinese', () => {
  assert.equal(formatSpan(0), '—')
  assert.equal(formatSpan(-5), '—')
  assert.equal(formatSpan(30_000), '30 秒')
  assert.equal(formatSpan(90_000), '1 分 30 秒')
  assert.equal(formatSpan(3_600_000), '1 小时 0 分')
})

test('token counts are grouped, and unreadable ones are placeholders', () => {
  assert.equal(formatCount(12_345), '12,345')
  assert.equal(formatCount(null), '--')
  assert.equal(formatCount(Number.NaN), '--')
})

test('clock formatting is zero-padded and total', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5).getTime()
  assert.equal(formatClock(at), '03:04:05')
  assert.equal(formatClock(null), '—')
})
