/**
 * The footer entry: a pill showing 充值余额 and this Session's measured spend,
 * with a detail panel on demand.
 *
 * Props come from the slot system, not from a prop-drilling parent: the dock is
 * a `session`-scope list slot, so `sessionId` and `useProjection` arrive as the
 * standard seat (declared by `@deepseek-ai/dsh-client-ui-session`, whose client
 * module augments `SessionStandardProps`). Nothing here reads a global.
 *
 * @module dsh-balance-meter/client/BalanceChip
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatClock, formatCount, formatMoney, formatSpan } from './format.ts'
import { fetchStatus, type StatusPayload } from './wire.ts'

/**
 * The props this entry receives.
 *
 * Taken from the dock's own slot declaration rather than restated: `PropsRuntime`
 * resolves the owner share, the session standard kit (`sessionId`,
 * `useProjection`, `useSession`) and every merged global seat, so a shell that
 * changes the dock contract breaks this file at type-check time instead of at
 * runtime.
 */
export type BalanceChipProps = PropsRuntime<'conversation.composer.dock'>

/** The stylesheet id, so a hot reload replaces rather than stacks it. */
const CSS_ID = 'dsh-balance-meter/client.css'

/**
 * Panel placement: anchored under the pill and clamped into the viewport.
 *
 * The panel opens ABOVE the pill, because the dock row sits at the very bottom
 * of the window and below is nothing but the frame edge.
 *
 * @param anchor - the pill element.
 * @param panel - the panel element.
 * @returns the style to apply.
 */
function placePanel(anchor: HTMLElement, panel: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect()
  const width = panel.offsetWidth || 300
  const height = panel.offsetHeight || 240
  const margin = 12
  return {
    left: Math.min(Math.max(margin, rect.right - width), Math.max(margin, window.innerWidth - width - margin)),
    top: Math.max(margin, rect.top - height - 8),
  }
}

/**
 * One definition row of the detail panel.
 *
 * `dt`/`dd` in a CSS grid, which is the official stat dialog's structure — the
 * grid columns are what align every value into one column.
 *
 * @param props - the row content.
 * @returns the rendered row pair.
 */
function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

/**
 * The dock entry.
 *
 * @param props - the dock slot's runtime props.
 * @returns the rendered pill (and its panel when open).
 */
export function BalanceChip(props: BalanceChipProps): JSX.Element {
  const sessionId = String(props.sessionId)
  // Read the chat plugin's own token projection so this entry stays subscribed to
  // the same accounting the shipped usage pill shows. It is a READ, not a
  // dependency: the panel prints the Host's cross-check, and a shell whose
  // projection store has not published the key simply yields `undefined`.
  const usage = props.useProjection('tokenUsage')
  const projectedTokens = usage === undefined ? null : usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens

  const [payload, setPayload] = useState<StatusPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null)

  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(
    (force: boolean) => {
      const controller = new AbortController()
      setLoading(true)
      void fetchStatus(sessionId, force, controller.signal).then((next) => {
        setLoading(false)
        if (next === null) {
          setFailed(true)
          return
        }
        setFailed(false)
        setPayload(next)
      })
      return () => {
        controller.abort()
      }
    },
    [sessionId],
  )

  // First read for this Session.
  useEffect(() => load(false), [load])

  // Polling, paused while the document is hidden. The cadence is the Host's:
  // it owns the provider budget, the browser only asks.
  useEffect(() => {
    const cadence = Math.max(5_000, payload?.config.pollIntervalMs ?? 45_000)
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void fetchStatus(sessionId, false, new AbortController().signal).then((next) => {
        if (next === null) return
        setFailed(false)
        setPayload(next)
      })
    }, cadence)
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      void fetchStatus(sessionId, false, new AbortController().signal).then((next) => {
        if (next !== null) setPayload(next)
      })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sessionId, payload?.config.pollIntervalMs])

  // Panel geometry plus its dismissal affordances.
  useEffect(() => {
    if (!open) {
      setPanelStyle(null)
      return
    }
    const place = (): void => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (anchor === null || panel === null) return
      setPanelStyle(placePanel(anchor, panel))
    }
    place()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target !== null && (anchorRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', place)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const balance = payload?.balance ?? null
  const session = payload?.session ?? null
  const crossCheck = payload?.crossCheck ?? null
  const currency = balance?.currency ?? ''
  const stale = balance?.error?.stale ?? null
  const paidText = formatMoney(balance?.paid ?? stale?.paid ?? null, currency || stale?.currency || '')
  const bonusText = balance?.bonus !== null && balance?.bonus !== undefined && balance.bonus > 0 ? formatMoney(balance.bonus, currency) : null
  const spendText = session === null ? '--' : formatMoney(session.spend, currency)
  const unavailable = balance?.error !== null && balance?.error !== undefined
  // The Host's own cross-check is the number shown; the projection read above is
  // the fallback when a composition serves the tokens but not the estimate.
  const crossCheckTokens = crossCheck?.tokens.total ?? projectedTokens

  return (
    <span className="dshbm_root">
      <button
        ref={anchorRef}
        type="button"
        className="dshbm_pill"
        data-loading={loading ? '1' : '0'}
        data-balance-meter="true"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`余额 ${paidText} · 本次 ${spendText}`}
        onClick={(event) => {
          event.stopPropagation()
          if (open) {
            setOpen(false)
            return
          }
          setOpen(true)
          load(true)
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="dshbm_icon">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 4.4v7.2M9.9 6.2c0-.9-.85-1.5-1.9-1.5s-1.9.6-1.9 1.5.85 1.35 1.9 1.55 1.9.65 1.9 1.55-.85 1.5-1.9 1.5-1.9-.6-1.9-1.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {/*
          Labels and amounts share ONE class on purpose: the shipped stats pills
          render every figure in the tertiary label color with no weight change,
          so emphasising the numbers here would make this entry the loudest thing
          in the row. The separator between the two figures is the only mark that
          distinguishes them.
        */}
        <span className="dshbm_label">
          <span className="dshbm_key">余额 </span>
          <span className="dshbm_value">{paidText}</span>
          <span className="dshbm_sep" aria-hidden="true">
            ·
          </span>
          <span className="dshbm_key">本次 </span>
          <span className="dshbm_value">{session === null ? '--' : session.observed ? spendText : '待采样'}</span>
        </span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          className="dshbm_panel"
          role="dialog"
          aria-label="余额与本次消费"
          style={panelStyle === null ? { visibility: 'hidden' } : panelStyle}
        >
          <div className="dshbm_title">
            <span className="dshbm_titleLabel">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M8 4.4v7.2M9.9 6.2c0-.9-.85-1.5-1.9-1.5s-1.9.6-1.9 1.5.85 1.35 1.9 1.55 1.9.65 1.9 1.55-.85 1.5-1.9 1.5-1.9-.6-1.9-1.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              余额与本次消费
            </span>
            <span className="dshbm_titleValue">{spendText}</span>
          </div>
          <div className="dshbm_titleRule" aria-hidden="true" />
          <dl className="dshbm_details">
            {/* 充值余额 headlines; 赠金 gets its own row only when it exists — the
                same split the shipped account card uses, never summed. */}
            <Row label="充值余额" value={paidText} />
            {bonusText !== null ? <Row label="赠金余额" value={bonusText} /> : null}
            {balance?.updatedAt !== null && balance?.updatedAt !== undefined ? (
              <Row label="余额采样于" value={formatClock(balance.updatedAt)} />
            ) : null}
            {balance?.ageMs !== null && balance?.ageMs !== undefined ? <Row label="数据年龄" value={formatSpan(balance.ageMs)} /> : null}
            <Row label="本次消费" value={session === null ? '--' : formatMoney(session.spend, currency, 4)} />
            {session !== null && session.topUp > 0 ? <Row label="期间充值" value={formatMoney(session.topUp, currency)} /> : null}
            {session?.baseline != null ? <Row label="基准时点" value={formatClock(session.baseline.time)} /> : null}
            {session !== null ? <Row label="观测窗口" value={formatSpan(session.windowMs)} /> : null}
            {session !== null ? <Row label="累计结算" value={`${session.chargedCount} 次`} /> : null}
            {crossCheck !== null ? (
              <>
                <Row label="系数校验（估算）" value={formatMoney(crossCheck.cost, crossCheck.currency, 4)} />
                <Row label="Token 合计" value={formatCount(crossCheck.tokens.total)} />
              </>
            ) : null}
            {crossCheck === null && crossCheckTokens !== null ? <Row label="Token 合计" value={formatCount(crossCheckTokens)} /> : null}
          </dl>
          {session?.partial === true ? (
            <div className="dshbm_note">基准取得较晚：会话开始到首次采样之间的消费无法从余额差还原，本次金额是下限。</div>
          ) : null}
          <div className="dshbm_note">以账户余额差测量；同账号其它窗口的消费会一并计入。点击可立即刷新。</div>
          {unavailable ? <div className="dshbm_warn">余额不可用：{balance.error?.message}</div> : null}
          {failed ? <div className="dshbm_warn">本地接口请求失败，正在重试。</div> : null}
        </div>
      ) : null}
    </span>
  )
}

/**
 * Install the stylesheet once per document.
 *
 * Tagged with the plugin id, exactly like the shipped entries do it, so a hot
 * reload can tell that it is already installed.
 */
export function ensureStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-balance-meter'
  tag.dataset['pluginCss'] = CSS_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/**
 * The plugin's own stylesheet; token-driven so every theme works.
 *
 * Typography is deliberately COPIED from the shipped stats pills rather than
 * invented: the dock row is a single centered flex line, so this entry has to
 * read as one more pill in it, not as an announcement. That means
 * `font: inherit; line-height: inherit` (so the row's own secondary content
 * font decide the size), the tertiary label color for everything including the
 * amounts, and no weight change anywhere. Only the hover/expanded fill is kept,
 * because the shipped pills have exactly that.
 */
const CSS = [
  // Mirror of the shipped dock row's own font declaration, so this entry cannot
  // drift from its neighbours in either direction: same token, same fallback.
  ':root{--dshbm-font-size:var(--dsh-content-font-size-secondary,13px);--dshbm-line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
  '.dshbm_root{display:inline-flex;align-items:center;font-size:var(--dshbm-font-size);line-height:var(--dshbm-line-height)}',
  '.dshbm_pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:none;border-radius:24px;background:0 0;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:inherit;font-weight:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;max-width:100%;cursor:pointer}',
  '.dshbm_pill:hover,.dshbm_pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '.dshbm_pill[data-loading="1"]{opacity:.65}',
  // Sized in `em` so the glyph follows the row's font rather than pinning a px
  // value the neighbouring icons would not share.
  '.dshbm_icon{flex:none;width:1.08em;height:1.08em}',
  '.dshbm_label{overflow:hidden;text-overflow:ellipsis;min-width:0}',
  // The dock's own copy is already the tertiary color; stating it keeps the entry
  // identical to its neighbours even if a theme moves the inherited color.
  '.dshbm_key{color:var(--dsw-alias-label-tertiary);font-weight:inherit}',
  '.dshbm_value{color:inherit;font-weight:inherit}',
  // `--dsw-alias-separator-primary` (the token the shipped pills use for their
  // `·`) is NOT defined anywhere in the shell's theme layer, so reusing it here
  // rendered the dot in the inherited color. The border token is the one that
  // actually resolves for a divider.
  '.dshbm_sep{color:var(--dsw-alias-border-l2);margin:0 6px}',
  // The panel mirrors the official stat dialog (the popover the shipped stats
  // pills open) token for token, so the two read as the same control.
  '.dshbm_panel{z-index:1100;box-sizing:border-box;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;position:fixed}',
  '.dshbm_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
  '.dshbm_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
  '.dshbm_titleLabel svg{flex:none;width:14px;height:14px}',
  '.dshbm_titleValue{font-variant-numeric:tabular-nums}',
  '.dshbm_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
  '.dshbm_details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
  '.dshbm_details dt,.dshbm_details dd{min-width:0;margin:0}',
  '.dshbm_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}',
  '.dshbm_note{color:var(--dsw-alias-label-tertiary);margin-top:10px}',
  '.dshbm_warn{color:var(--dsw-alias-state-error-primary);margin-top:6px}',
  '.dshbm_rule{height:1px;margin:7px 0;background:var(--dsw-alias-border-l1)}',
  '.dshbm_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;margin-top:6px}',
  '.dshbm_warn{color:var(--dsw-alias-state-error-primary);margin-top:6px;font-size:11px}',
].join('\n')
