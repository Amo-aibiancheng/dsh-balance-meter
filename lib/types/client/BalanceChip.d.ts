/**
 * The footer entry: a pill showing 充值余额 and this Session's measured spend,
 * with a detail panel on demand.
 *
 * Props come from the slot system, not from a prop-drilling parent: the dock is
 * a `session`-scope list slot, so `sessionId` and `useProjection` arrive as the
 * standard seat (declared by `@deepseek-ai/dsh-client-ui-session`, whose client
 * module augments `SessionStandardProps`). Nothing here reads a global.
 *
 * @module @amo-aibiancheng/dsh-balance-meter/client/BalanceChip
 */
import { type JSX } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/**
 * The props this entry receives.
 *
 * Taken from the dock's own slot declaration rather than restated: `PropsRuntime`
 * resolves the owner share, the session standard kit (`sessionId`,
 * `useProjection`, `useSession`) and every merged global seat, so a shell that
 * changes the dock contract breaks this file at type-check time instead of at
 * runtime.
 */
export type BalanceChipProps = PropsRuntime<'conversation.composer.dock'>;
/**
 * The dock entry.
 *
 * @param props - the dock slot's runtime props.
 * @returns the rendered pill (and its panel when open).
 */
export declare function BalanceChip(props: BalanceChipProps): JSX.Element;
/**
 * Install the stylesheet once per document.
 *
 * Tagged with the plugin id, exactly like the shipped entries do it, so a hot
 * reload can tell that it is already installed.
 */
export declare function ensureStyle(): void;
//# sourceMappingURL=BalanceChip.d.ts.map