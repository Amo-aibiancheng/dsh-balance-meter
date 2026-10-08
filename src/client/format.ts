/**
 * Display formatting for the footer entry.
 *
 * Pure functions with no React and no DOM, so the money rules can be tested
 * directly: what counts as sub-unit, how a currency code the browser does not
 * know is spelled, and how a duration reads in the panel.
 *
 * @module dsh-balance-meter/client/format
 */

/**
 * Format a money amount for the active locale.
 *
 * @param value - the amount, or `null` when unreadable.
 * @param currency - currency code; `''` falls back to CNY.
 * @param minDigits - override the digit count.
 * @returns display text, or `--` when there is nothing to show.
 */
export function formatMoney(value: number | null | undefined, currency: string, minDigits?: number): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--'
  const amount = Number(value)
  // Sub-unit amounts keep four decimals: one turn's cost is routinely a few 角,
  // and rounding it to two digits would show ¥0.00 for real spending.
  const digits = minDigits ?? (amount > 0 && amount < 1 ? 4 : 2)
  const code = currency === '' ? 'CNY' : currency
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount)
  } catch {
    // An unknown currency code must not blank the entry.
    return `${code} ${amount.toFixed(digits)}`
  }
}

/**
 * Format a token count.
 *
 * @param value - the count.
 * @returns display text, or `--` when unreadable.
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--'
  try {
    return new Intl.NumberFormat('zh-CN').format(Number(value))
  } catch {
    return String(value)
  }
}

/**
 * Format a duration as a compact Chinese span.
 *
 * @param ms - the span in milliseconds.
 * @returns display text, or `—` for an empty span.
 */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/**
 * Format a clock time.
 *
 * @param ms - epoch milliseconds, or `null`.
 * @returns `HH:MM:SS`, or `—` when unavailable.
 */
export function formatClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
