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
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
/**
 * Plugin config schema.
 *
 * This MUST be a schemastery schema rather than a plain object of defaults: the
 * loader validates a row's `Config` export by calling `.validate()` on it, so a
 * hand-written default object makes the entry fail to import. The volatile
 * fields are the ones a Settings edit must reach without remounting the row.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** How long a reading is reused before the account is asked again (ms). */
    pollIntervalMs: z<number, number, "volatile-defined">;
    /** Provider read timeout (ms). */
    requestTimeoutMs: z<number, number, "volatile-defined">;
    /** A single drop above this fraction of the wallet is an account event, not Session spend. */
    anomalyRatio: z<number, number, "volatile-defined">;
    /** Publish the token cross-check beside the measured delta. */
    showTokenCrossCheck: z<boolean, boolean, "volatile-defined">;
    /** Rates used ONLY by the cross-check, per million tokens. */
    price: z<Schemastery.ObjectS<NoInfer<{
        currency: z<string, string, "volatile-defined">;
        cacheHit: z<number, number, "volatile-defined">;
        cacheMiss: z<number, number, "volatile-defined">;
        output: z<number, number, "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        currency: z<string, string, "volatile-defined">;
        cacheHit: z<number, number, "volatile-defined">;
        cacheMiss: z<number, number, "volatile-defined">;
        output: z<number, number, "volatile-defined">;
    }>>, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** How long a reading is reused before the account is asked again (ms). */
    pollIntervalMs: z<number, number, "volatile-defined">;
    /** Provider read timeout (ms). */
    requestTimeoutMs: z<number, number, "volatile-defined">;
    /** A single drop above this fraction of the wallet is an account event, not Session spend. */
    anomalyRatio: z<number, number, "volatile-defined">;
    /** Publish the token cross-check beside the measured delta. */
    showTokenCrossCheck: z<boolean, boolean, "volatile-defined">;
    /** Rates used ONLY by the cross-check, per million tokens. */
    price: z<Schemastery.ObjectS<NoInfer<{
        currency: z<string, string, "volatile-defined">;
        cacheHit: z<number, number, "volatile-defined">;
        cacheMiss: z<number, number, "volatile-defined">;
        output: z<number, number, "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        currency: z<string, string, "volatile-defined">;
        cacheHit: z<number, number, "volatile-defined">;
        cacheMiss: z<number, number, "volatile-defined">;
        output: z<number, number, "volatile-defined">;
    }>>, "defined">;
}>>, "plain">;
/**
 * The row's config as the loader resolves it.
 *
 * `ReturnType` of the schema, not a hand-written interface: a volatile field is a
 * live handle with a `.get()`, and deriving the type from the schema is what
 * keeps the two from drifting. {@link fieldValue} is the reader for it.
 */
export type BalanceMeterConfig = ReturnType<typeof Config>;
/** The value behind one config field: a volatile handle, or an already-plain value. */
export type FieldValue<F> = F extends {
    get: () => infer V;
} ? V : F;
/** Required services: the route registry and the official account provider. */
export declare const inject: string[];
/**
 * Mount the observation loop and the route family.
 *
 * @param ctx - host context carrying `webServer` and `deepseekAccount`.
 * @param config - the row's config as the loader resolved it.
 */
export declare function apply(ctx: Context, config?: BalanceMeterConfig): void;
//# sourceMappingURL=index.d.ts.map