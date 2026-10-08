/**
 * dsh-balance-meter — browser half.
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
 * @module dsh-balance-meter/client
 */

import { BalanceChip, ensureStyle } from './BalanceChip.tsx'
import type { Context } from '@deepseek-ai/cordis'
// Type-only edges: each client module below is what merges its own slot
// declarations and standard props into the SlotMap — the dock key comes from
// ui-conversation, `sessionId`/`useProjection` from the session-controller
// adapter, and the `tokenUsage` projection key this entry reads from the token
// meter. Importing them for types is what makes the register() call type-check
// against the running shell's real contract instead of a local guess, and
// `verbatimModuleSyntax` guarantees none of them survives into the bundle.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-token-meter/client'

/**
 * Services this half consumes. `slots` is the renderer-owned registry; the
 * conversation service is what declares the dock key this entry occupies.
 */
export const inject = ['slots', 'conversation']

/** The cell key of this plugin's entry inside the dock. */
const ENTRY_ID = 'balance-meter'

/**
 * Client plugin body: register the footer entry.
 *
 * @param ctx - the client root context.
 */
export function apply(ctx: Context): void {
  ensureStyle()
  // Two different waits, and both are load order rather than timing:
  // `ctx.inject` waits for the slots SERVICE to exist (it arrives with the
  // renderer), while `slots.inject` waits for this KEY to be declared (it
  // arrives with the conversation shell). Neither guesses, and neither can be
  // rejected for registering into an undeclared slot.
  ctx.inject(['slots'], (scope) => {
    const wait = scope.slots.inject('conversation.composer.dock', () => {
      // `order` 20 keeps the shipped stats entry (order 0) first, so the row
      // reads: turns/steps · tokens · cache, then this entry.
      return scope.slots.register({ name: 'conversation.composer.dock', id: ENTRY_ID, order: 20 }, BalanceChip)
    })
    scope.effect(
      () => () => {
        wait()
      },
      'dsh-balance-meter: footer entry',
    )
  })
}
