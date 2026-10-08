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
export declare function formatMoney(value: number | null | undefined, currency: string, minDigits?: number): string;
/**
 * Format a token count.
 *
 * @param value - the count.
 * @returns display text, or `--` when unreadable.
 */
export declare function formatCount(value: number | null | undefined): string;
/**
 * Format a duration as a compact Chinese span.
 *
 * @param ms - the span in milliseconds.
 * @returns display text, or `—` for an empty span.
 */
export declare function formatSpan(ms: number): string;
/**
 * Format a clock time.
 *
 * @param ms - epoch milliseconds, or `null`.
 * @returns `HH:MM:SS`, or `—` when unavailable.
 */
export declare function formatClock(ms: number | null | undefined): string;
//# sourceMappingURL=format.d.ts.map