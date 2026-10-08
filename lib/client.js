/**
 * dsh-balance-meter — browser half.
 *
 * Registers one entry in `conversation.composer.dock` (the ambient row under the
 * composer card, where the shipped stats pills live) that shows the account
 * balance and what the current Session has cost so far.
 *
 * Everything factual comes from this package's own Host routes: the browser
 * never holds a credential and never talks to DeepSeek. The number rendered for
 * a Session is the wallet delta the Host measured between two reads (see
 * `src/core/ledger.js` for the algorithm); the client only formats it.
 *
 * Built as a `window.__ModuleLoader__.load({ id, factory })` closure — the
 * module format the harness resolves client bundles through — so the package
 * needs no build step and no bundled peer libraries.
 *
 * @module dsh-balance-meter/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-balance-meter',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const NS = 'dsh-balance-meter'

    /** Routes are DOCUMENT-RELATIVE on purpose: the GUI is served under `<base href="./">`. */
    const ROUTE_STATUS = 'dsh-balance-meter/status'
    const ROUTE_REFRESH = 'dsh-balance-meter/refresh'

    /** Poll cadence used until the Host reports its own (the Host config wins). */
    const FALLBACK_POLL_MS = 45000

    /** Icon for the entry; a missing primitive degrades to a text-only pill. */
    const StatusIcon = primitives.IconGaugeOutline16 ?? primitives.IconDatabaseOutline16 ?? null

    /** One stylesheet for this plugin, tagged so a hot reload replaces rather than stacks it. */
    const CSS = [
      '.dshbm_root{display:inline-flex;align-items:center}',
      '.dshbm_pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:none;border-radius:24px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;max-width:100%;cursor:pointer}',
      '.dshbm_pill:hover,.dshbm_pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshbm_pill svg{flex:none;width:14px;height:14px}',
      '.dshbm_pill[data-loading="1"]{opacity:.65}',
      '.dshbm_label{overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.dshbm_strong{color:var(--dsw-alias-label-secondary);font-weight:600}',
      '.dshbm_sep{color:var(--dsw-alias-separator-primary);margin:0 2px}',
      '.dshbm_panel{position:fixed;z-index:1000;min-width:250px;max-width:330px;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:1.6}',
      '.dshbm_title{font-weight:600;margin-bottom:6px}',
      '.dshbm_row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.dshbm_key{color:var(--dsw-alias-label-tertiary)}',
      '.dshbm_val{font-variant-numeric:tabular-nums;text-align:right}',
      '.dshbm_rule{height:1px;margin:7px 0;background:var(--dsw-alias-border-l1)}',
      '.dshbm_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;margin-top:6px}',
      '.dshbm_warn{color:var(--dsw-alias-state-error-primary);margin-top:6px;font-size:11px}',
    ].join('\n')

    /** Install the stylesheet once per document. */
    function ensureStyle() {
      const id = `${NS}/client.css`
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Format a money amount for the active locale.
     *
     * @param {number | null} value - the amount.
     * @param {string} currency - currency code.
     * @param {number} [minDigits] - minimum fraction digits.
     * @returns {string} display text.
     */
    function formatMoney(value, currency, minDigits) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--'
      const amount = Number(value)
      // Sub-unit amounts keep four decimals: one turn's cost is routinely a few
      // 角, and rounding it to two digits would show ¥0.00 for real spending.
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
        return `${code} ${amount.toFixed(digits)}`
      }
    }

    /**
     * Format a token count.
     *
     * @param {number} value - the count.
     * @returns {string} display text.
     */
    function formatCount(value) {
      if (!Number.isFinite(Number(value))) return '--'
      try {
        return new Intl.NumberFormat('zh-CN').format(Number(value))
      } catch {
        return String(value)
      }
    }

    /**
     * Format a duration in milliseconds as a compact Chinese span.
     *
     * @param {number} ms - the span.
     * @returns {string} display text.
     */
    function formatSpan(ms) {
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
     * @param {number | null} ms - epoch milliseconds.
     * @returns {string} display text.
     */
    function formatClock(ms) {
      if (ms === null || !Number.isFinite(ms)) return '—'
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /**
     * Read the session id out of the slot's standard props.
     *
     * @param {object} props - the slot component props.
     * @returns {string} the Session id, or `''` in the no-Session state.
     */
    function sessionIdOf(props) {
      const id = props?.sessionId
      return typeof id === 'string' ? id : ''
    }

    /**
     * Fetch the Host payload for one Session.
     *
     * @param {string} sessionId - the Session id.
     * @param {boolean} force - ask for a fresh provider read.
     * @param {AbortSignal} signal - cancellation for an unmounted component.
     * @returns {Promise<object | null>} the payload, or `null` on transport failure.
     */
    async function fetchStatus(sessionId, force, signal) {
      const route = force ? ROUTE_REFRESH : ROUTE_STATUS
      const query = sessionId === '' ? '' : `?session=${encodeURIComponent(sessionId)}`
      try {
        const response = await fetch(`${route}${query}`, { cache: 'no-store', signal })
        if (!response.ok) return null
        const payload = await response.json()
        return payload !== null && typeof payload === 'object' ? payload : null
      } catch {
        return null
      }
    }

    /**
     * The footer entry: a pill with the wallet balance and the measured Session
     * spend, plus a detail panel on demand.
     *
     * @param {object} props - the slot's standard props.
     * @returns {object} the rendered element.
     */
    function BalanceChip(props) {
      ensureStyle()
      const sessionId = sessionIdOf(props)
      const [payload, setPayload] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [loading, setLoading] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const anchorRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [panelPos, setPanelPos] = React.useState(null)

      // The token cross-check rides the chat plugin's own projection when the
      // running shell serves it; a shell without that hook simply has no
      // cross-check (`useProjection` is optional on the slot's standard props).
      let usage = null
      try {
        usage = typeof props.useProjection === 'function' ? props.useProjection('tokenUsage') : null
      } catch {
        usage = null
      }

      React.useEffect(() => {
        let alive = true
        const controller = new AbortController()
        setLoading(true)
        fetchStatus(sessionId, false, controller.signal).then((next) => {
          if (!alive) return
          setLoading(false)
          if (next === null) {
            setFailed(true)
            return
          }
          setFailed(false)
          setPayload(next)
        })
        return () => {
          alive = false
          controller.abort()
        }
      }, [sessionId])

      React.useEffect(() => {
        let timer = null
        const interval = payload?.config?.pollIntervalMs ?? FALLBACK_POLL_MS
        const poll = () => {
          if (document.visibilityState === 'hidden') return
          fetchStatus(sessionId, false, new AbortController().signal).then((next) => {
            if (next !== null) {
              setFailed(false)
              setPayload(next)
            }
          })
        }
        timer = setInterval(poll, Math.max(5000, interval))
        document.addEventListener('visibilitychange', poll)
        return () => {
          if (timer !== null) clearInterval(timer)
          document.removeEventListener('visibilitychange', poll)
        }
      }, [sessionId, payload?.config?.pollIntervalMs])

      const refresh = React.useCallback(() => {
        setLoading(true)
        fetchStatus(sessionId, true, new AbortController().signal).then((next) => {
          setLoading(false)
          if (next === null) {
            setFailed(true)
            return
          }
          setFailed(false)
          setPayload(next)
        })
      }, [sessionId])

      // Panel placement: anchored under the pill, clamped into the viewport.
      React.useEffect(() => {
        if (!open) return undefined
        const place = () => {
          const anchor = anchorRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const width = panelRef.current?.offsetWidth ?? 280
          const height = panelRef.current?.offsetHeight ?? 220
          const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8))
          const top = Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - height - 8))
          setPanelPos({ left, top })
        }
        place()
        const onPointerDown = (event) => {
          if (anchorRef.current?.contains(event.target)) return
          if (panelRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
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
      const totalText = formatMoney(balance?.paid ?? stale?.paid ?? null, currency || stale?.currency || '')
      const bonusText = balance?.bonus > 0 ? formatMoney(balance.bonus, currency) : null
      const spendText = session === null ? '--' : formatMoney(session.spend, currency)
      const unavailable = balance?.error !== null && balance?.error !== undefined

      const label = h(
        'span',
        { className: 'dshbm_label' },
        h('span', { className: 'dshbm_key' }, '余额 '),
        h('span', { className: 'dshbm_strong' }, totalText),
        h('span', { className: 'dshbm_sep', 'aria-hidden': true }, '·'),
        h('span', { className: 'dshbm_key' }, '本次 '),
        h(
          'span',
          { className: 'dshbm_strong' },
          session === null
            ? '--'
            : session.observed
              ? spendText
              : '待采样',
        ),
      )

      /** One key/value row of the detail panel. */
      const row = (key, value) => h('div', { className: 'dshbm_row' }, h('span', { className: 'dshbm_key' }, key), h('span', { className: 'dshbm_val' }, value))

      const panel = open
        ? h(
            'div',
            {
              ref: panelRef,
              className: 'dshbm_panel',
              role: 'dialog',
              'aria-label': '余额与本次消费',
              style: panelPos === null ? { visibility: 'hidden' } : { left: panelPos.left, top: panelPos.top },
            },
            h('div', { className: 'dshbm_title' }, '账户与本次会话'),
            // 充值余额 headlines; 赠金 gets its own row only when it exists, the
            // same split the shipped account card uses (never summed).
            row('充值余额', totalText),
            bonusText !== null ? row('赠金余额', bonusText) : null,
            balance?.updatedAt !== null && balance?.updatedAt !== undefined ? row('余额采样于', formatClock(balance.updatedAt)) : null,
            balance?.ageMs !== null && balance?.ageMs !== undefined ? row('数据年龄', formatSpan(balance.ageMs)) : null,
            h('div', { className: 'dshbm_rule' }),
            row('本次消费', session === null ? '--' : formatMoney(session.spend, currency, 4)),
            session?.topUp > 0 ? row('期间充值', formatMoney(session.topUp, currency)) : null,
            session?.baseline != null ? row('基准时点', formatClock(session.baseline.time)) : null,
            session !== null ? row('观测窗口', formatSpan(session.windowMs)) : null,
            session !== null ? row('累计结算', `${session.sampleCount} 次`) : null,
            crossCheck !== null
              ? h(
                  React.Fragment,
                  null,
                  h('div', { className: 'dshbm_rule' }),
                  row('系数校验（估算）', formatMoney(crossCheck.cost, crossCheck.currency, 4)),
                  row('Token 合计', formatCount(crossCheck.tokens.total)),
                )
              : null,
            session?.partial === true
              ? h('div', { className: 'dshbm_note' }, '基准取得较晚：会话开始到首次采样之间的消费无法从余额差还原，本次金额是下限。')
              : null,
            h('div', { className: 'dshbm_note' }, '以账户余额差测量；同账号其它窗口的消费会一并计入。点击可立即刷新。'),
            unavailable
              ? h('div', { className: 'dshbm_warn' }, `余额不可用：${balance.error.message}`)
              : null,
            failed ? h('div', { className: 'dshbm_warn' }, '本地接口请求失败，正在重试。') : null,
          )
        : null

      return h(
        'span',
        { className: 'dshbm_root' },
        h(
          'button',
          {
            ref: anchorRef,
            type: 'button',
            className: 'dshbm_pill',
            'data-loading': loading ? '1' : '0',
            'data-balance-meter': true,
            'aria-expanded': open,
            'aria-haspopup': 'dialog',
            title: `${NS}：余额 ${totalText} · 本次 ${spendText}`,
            onClick: (event) => {
              event.stopPropagation()
              if (open) {
                setOpen(false)
                return
              }
              setOpen(true)
              refresh()
            },
          },
          StatusIcon === null ? null : h(StatusIcon, {}),
          label,
        ),
        panel,
      )
    }

    /** The consumed browser facts; the entry is registered through them. */
    const inject = ['slots']

    /**
     * Client plugin body: register the footer entry.
     *
     * @param {object} ctx - the client root context.
     * @returns {void}
     */
    function apply(ctx) {
      // Two waits are needed and they are different kinds: `ctx.inject` waits
      // for the slots SERVICE to exist (it arrives with the renderer), while
      // `slots.inject` waits for this KEY to be declared (it arrives with the
      // conversation shell). Both are load-order, not timing, so nothing is
      // guessed and no bare register can be rejected.
      ctx.inject(['slots'], (scope) => {
        const wait = scope.slots.inject('conversation.composer.dock', () => {
          try {
            return scope.slots.register({ name: 'conversation.composer.dock', id: 'balance-meter', order: 20, locale: NS }, BalanceChip)
          } catch (error) {
            console.warn(`[${NS}] footer entry registration failed:`, error)
            return () => {}
          }
        })
        scope.effect(() => () => {
          try {
            wait()
          } catch {
            // Unloading must not throw.
          }
        }, `${NS}: footer entry`)
      })
    }

    return { apply, inject, name: NS, BalanceChip }
  },
})
