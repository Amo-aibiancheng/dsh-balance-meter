/**
 * @amo-aibiancheng/dsh-balance-meter — browser half.
 *
 * Registers one entry in `conversation.composer.dock` (the ambient row under the
 * composer card, where the shipped stats pills live) showing 充值余额 and what
 * the current Session has cost so far.
 *
 * Everything factual comes from this package's own Host routes: the browser
 * never holds a credential and never talks to DeepSeek. The number rendered for
 * a Session is the wallet delta the Host measured between two reads — the
 * algorithm lives in `../core/ledger.ts`.
 *
 * @module @amo-aibiancheng/dsh-balance-meter/client
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Services this half consumes. `slots` is the renderer-owned registry; the
 * conversation service is what declares the dock key this entry occupies.
 */
export declare const inject: string[];
/**
 * Client plugin body: register the footer entry.
 *
 * @param ctx - the client root context.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map