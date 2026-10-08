/**
 * The wire contract between this package's two halves.
 *
 * Kept in its own module so the browser half never imports anything from the
 * Host half: the types below are the entire coupling, and they are structural
 * (no classes, no `Date`, nothing that would not survive JSON).
 *
 * @module dsh-balance-meter/client/wire
 */

/** Wallet amounts per currency, as the Host reports them. */
export interface WalletPayload {
  readonly paid: number
  readonly bonus: number
}

/** A failure the Host reports instead of throwing. */
export interface BalanceErrorPayload {
  readonly code: string
  readonly message: string
  /** The last numbers that were readable, so the panel can still show something. */
  readonly stale: { readonly time: number; readonly paid: number; readonly currency: string } | null
}

/** One Session's measured spend. */
export interface SessionPayload {
  readonly sessionId: string
  readonly createdMs: number
  readonly baseline: { readonly time: number; readonly currency: string; readonly paid: number | null } | null
  readonly baselineSource: 'none' | 'session-start' | 'first-observation' | 'rebased'
  readonly partial: boolean
  readonly observed: boolean
  readonly spend: number
  readonly topUp: number
  readonly chargedCount: number
  readonly windowMs: number
  readonly readingCount: number
  readonly scope: 'session-window'
}

/** The token cross-check. */
export interface CrossCheckPayload {
  readonly tokens: { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number; readonly total: number }
  readonly cost: number
  readonly currency: string
}

/** The whole status response. */
export interface StatusPayload {
  readonly ok: true
  readonly config: { readonly pollIntervalMs: number; readonly showTokenCrossCheck: boolean }
  readonly balance: {
    readonly paid: number | null
    readonly bonus: number | null
    readonly currency: string
    readonly wallets: Readonly<Record<string, WalletPayload>>
    readonly updatedAt: number | null
    readonly ageMs: number | null
    readonly error: BalanceErrorPayload | null
  }
  readonly session: SessionPayload | null
  readonly crossCheck: CrossCheckPayload | null
  readonly ledger: { readonly readingCount: number; readonly sessionCount: number }
  readonly serverTime: number
}

/** The Host's own route names, relative to the page (the shell serves `<base href="./">`). */
export const ROUTE_STATUS = 'dsh-balance-meter/status'
export const ROUTE_REFRESH = 'dsh-balance-meter/refresh'

/** Poll cadence used until the Host reports its own. */
export const FALLBACK_POLL_MS = 45_000

/**
 * Fetch the Host payload for one Session.
 *
 * @param sessionId - the Session id, or `''` for a global read.
 * @param force - ask the Host for a fresh provider read.
 * @param signal - cancellation for an unmounted entry.
 * @returns the payload, or `null` on any transport failure.
 */
export async function fetchStatus(sessionId: string, force: boolean, signal: AbortSignal): Promise<StatusPayload | null> {
  const route = force ? ROUTE_REFRESH : ROUTE_STATUS
  const query = sessionId === '' ? '' : `?session=${encodeURIComponent(sessionId)}`
  try {
    const response = await fetch(`${route}${query}`, { cache: 'no-store', signal })
    if (!response.ok) return null
    const payload = (await response.json()) as unknown
    return payload !== null && typeof payload === 'object' ? (payload as StatusPayload) : null
  } catch {
    return null
  }
}
