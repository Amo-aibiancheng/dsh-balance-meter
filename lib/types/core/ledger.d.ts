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
/** One currency's money, split the way the provider reports it. */
export interface WalletAmounts {
    /** 充值余额: the recharge wallet. This is the money spend is measured against. */
    readonly paid: number;
    /** 赠金余额: granted funds. Reported beside `paid`, never summed with it. */
    readonly bonus: number;
}
/** Wallet amounts keyed by currency code. */
export type WalletMap = Readonly<Record<string, WalletAmounts>>;
/** One raw wallet record as the account provider returns it. */
export interface RawWallet {
    readonly currency?: string;
    readonly balance?: string | number;
    /** Present only when a composition already folded bonus into the entry. */
    readonly bonusBalance?: string | number;
}
/** One frozen observation of the account. */
export interface Reading {
    /** Non-decreasing epoch milliseconds; the timeline's ordering key. */
    readonly time: number;
    readonly wallets: WalletMap;
    /** The headline money: `paid` of the primary currency. */
    readonly paid: number;
    /** Grant money beside it, never added to `paid`. */
    readonly bonus: number;
    /** Currency `paid`/`bonus` are denominated in. */
    readonly currency: string;
    /** Monotonic publication sequence, for callers that must detect a new one. */
    seq: number;
}
/** Per-Session accumulator state. */
export interface SessionState {
    readonly sessionId: string;
    /** Durable Session creation time in epoch milliseconds. */
    createdMs: number;
    /** The observation the Session's spend is measured from. */
    baseline: Reading | null;
    /** Why the baseline is what it is; surfaced in the detail panel. */
    baselineSource: BaselineSource;
    /** Growth observed while this Session was alive (top-ups, refunds). */
    topUp: number;
    /** Money this Session is charged with, in `currency`. */
    spend: number;
    /** Settlements charged so far. */
    chargedCount: number;
    /** Whether anything has been charged yet (the panel's "待采样" state). */
    observed: boolean;
    /** The measurement is a lower bound, not a complete window. */
    partial: boolean;
    /** The last observation this Session's reference moved to. */
    lastMoveMs: number;
}
/** How a Session's baseline was chosen. */
export type BaselineSource = 'none' | 'session-start' | 'first-observation' | 'rebased';
/** The measurement one Session reports. */
export interface SessionMeasurement {
    readonly sessionId: string;
    readonly createdMs: number;
    readonly baseline: {
        readonly time: number;
        readonly currency: string;
        readonly paid: number | null;
    } | null;
    readonly baselineSource: BaselineSource;
    readonly partial: boolean;
    readonly observed: boolean;
    readonly spend: number;
    readonly topUp: number;
    readonly chargedCount: number;
    readonly windowMs: number;
    readonly readingCount: number;
    /** How much of the account's movement this Session could be responsible for. */
    readonly scope: 'session-window';
}
/** Token usage accumulated for the cross-check. */
export interface TokenBuckets {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
}
/** The token-derived estimate, priced at configured rates. */
export interface CrossCheck {
    readonly tokens: TokenBuckets & {
        total: number;
    };
    readonly cost: number;
    readonly currency: string;
}
/** Rates the cross-check prices with, per million tokens. */
export interface PriceTable {
    readonly currency: string;
    readonly hit: number;
    readonly miss: number;
    readonly out: number;
}
/** Guard knobs; the Host resolves them from plugin config. */
export interface LedgerLimits {
    /** A single drop above this fraction of the wallet is an account event. */
    anomalyRatio?: number | (() => number);
}
/** Input accepted by {@link Ledger.recordReading}. */
export interface ReadingInput {
    time?: number;
    wallets?: WalletMap;
    balance?: readonly RawWallet[];
    bonusWallets?: readonly RawWallet[];
}
/** The ledger handle. */
export interface Ledger {
    recordReading(input: ReadingInput): Reading;
    measureSession(sessionId: string, createdMs: number, nowMs?: number): SessionMeasurement;
    ingestSessionEvent(sessionId: string, createdMs: number, event: {
        type?: string;
        data?: unknown;
    }): void;
    estimateCost(sessionId: string, price: PriceTable): CrossCheck | null;
    latest(): Reading | null;
    readingAtOrAfter(time: number): Reading | null;
    sessionIds(): string[];
    forgetSession(sessionId: string): void;
}
/**
 * Coerce one amount to a finite number.
 *
 * @param value - number, or the decimal string the API returns.
 * @returns the finite amount, or `NaN` when unreadable.
 */
export declare function toAmount(value: unknown): number;
/**
 * Normalize one raw paid-wallet record.
 *
 * The provider's wallet entries carry the amount in `balance`; a pre-summed
 * `bonusBalance` is honored only when a composition already folded them.
 *
 * @param raw - a `{ currency, balance }` record from any source.
 * @returns the normalized amounts, or `null` when the record has no currency.
 */
export declare function normalizeWallet(raw: unknown): {
    currency: string;
    paid: number;
    bonus: number;
} | null;
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
export declare function buildWallets(wallets: readonly RawWallet[] | undefined, bonusWallets?: readonly RawWallet[] | undefined): WalletMap;
/**
 * Pick the currency to headline: the paid currency with the largest balance,
 * falling back to the first readable one.
 *
 * @param wallets - wallet map.
 * @returns currency code, or `''` when nothing is readable.
 */
export declare function primaryCurrency(wallets: WalletMap | undefined): string;
/**
 * Freeze one observation into the immutable record the timeline stores.
 *
 * @param time - epoch milliseconds when the provider was read.
 * @param wallets - wallet map.
 * @returns the reading.
 */
export declare function createReading(time: number, wallets: WalletMap): Reading;
/**
 * Compare two readings for identity (same moment, same money).
 *
 * @param a - earlier reading.
 * @param b - later reading.
 * @returns `true` when both describe one observation.
 */
export declare function sameObservation(a: Reading | null, b: Reading | null): boolean;
/**
 * Create an empty ledger. One ledger owns one account's observation timeline
 * plus one spend accumulator per Session.
 *
 * @param limits - guard overrides from plugin config.
 * @returns the ledger.
 */
export declare function createLedger(limits?: LedgerLimits): Ledger;
//# sourceMappingURL=ledger.d.ts.map