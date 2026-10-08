window.__ModuleLoader__.load({
	id: "dsh-balance-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/format.ts
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
		function formatMoney(value, currency, minDigits) {
			if (value === null || value === void 0 || !Number.isFinite(Number(value))) return "--";
			const amount = Number(value);
			const digits = minDigits ?? (amount > 0 && amount < 1 ? 4 : 2);
			const code = currency === "" ? "CNY" : currency;
			try {
				return new Intl.NumberFormat("zh-CN", {
					style: "currency",
					currency: code,
					minimumFractionDigits: digits,
					maximumFractionDigits: digits
				}).format(amount);
			} catch {
				return `${code} ${amount.toFixed(digits)}`;
			}
		}
		/**
		* Format a token count.
		*
		* @param value - the count.
		* @returns display text, or `--` when unreadable.
		*/
		function formatCount(value) {
			if (value === null || value === void 0 || !Number.isFinite(Number(value))) return "--";
			try {
				return new Intl.NumberFormat("zh-CN").format(Number(value));
			} catch {
				return String(value);
			}
		}
		/**
		* Format a duration as a compact Chinese span.
		*
		* @param ms - the span in milliseconds.
		* @returns display text, or `—` for an empty span.
		*/
		function formatSpan(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "—";
			const seconds = Math.round(ms / 1e3);
			if (seconds < 60) return `${seconds} 秒`;
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
			return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
		}
		/**
		* Format a clock time.
		*
		* @param ms - epoch milliseconds, or `null`.
		* @returns `HH:MM:SS`, or `—` when unavailable.
		*/
		function formatClock(ms) {
			if (ms === null || ms === void 0 || !Number.isFinite(ms)) return "—";
			const date = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}
		//#endregion
		//#region src/client/wire.ts
		/** The Host's own route names, relative to the page (the shell serves `<base href="./">`). */
		const ROUTE_STATUS = "dsh-balance-meter/status";
		const ROUTE_REFRESH = "dsh-balance-meter/refresh";
		/**
		* Fetch the Host payload for one Session.
		*
		* @param sessionId - the Session id, or `''` for a global read.
		* @param force - ask the Host for a fresh provider read.
		* @param signal - cancellation for an unmounted entry.
		* @returns the payload, or `null` on any transport failure.
		*/
		async function fetchStatus(sessionId, force, signal) {
			const route = force ? ROUTE_REFRESH : ROUTE_STATUS;
			const query = sessionId === "" ? "" : `?session=${encodeURIComponent(sessionId)}`;
			try {
				const response = await fetch(`${route}${query}`, {
					cache: "no-store",
					signal
				});
				if (!response.ok) return null;
				const payload = await response.json();
				return payload !== null && typeof payload === "object" ? payload : null;
			} catch {
				return null;
			}
		}
		//#endregion
		//#region src/client/BalanceChip.tsx
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
		/** The stylesheet id, so a hot reload replaces rather than stacks it. */
		const CSS_ID = "dsh-balance-meter/client.css";
		/**
		* Panel placement: anchored under the pill and clamped into the viewport.
		*
		* @param anchor - the pill element.
		* @param panel - the panel element.
		* @returns the style to apply.
		*/
		function placePanel(anchor, panel) {
			const rect = anchor.getBoundingClientRect();
			const width = panel.offsetWidth || 280;
			const height = panel.offsetHeight || 220;
			return {
				left: Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8)),
				top: Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - height - 8))
			};
		}
		/** One key/value row of the detail panel. */
		function Row({ label, value }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshbm_row",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dshbm_key",
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dshbm_val",
					children: value
				})]
			});
		}
		/**
		* The dock entry.
		*
		* @param props - the dock slot's runtime props.
		* @returns the rendered pill (and its panel when open).
		*/
		function BalanceChip(props) {
			const sessionId = String(props.sessionId);
			const usage = props.useProjection("tokenUsage");
			const projectedTokens = usage === void 0 ? null : usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
			const [payload, setPayload] = (0, react.useState)(null);
			const [failed, setFailed] = (0, react.useState)(false);
			const [loading, setLoading] = (0, react.useState)(true);
			const [open, setOpen] = (0, react.useState)(false);
			const [panelStyle, setPanelStyle] = (0, react.useState)(null);
			const anchorRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			const load = (0, react.useCallback)((force) => {
				const controller = new AbortController();
				setLoading(true);
				fetchStatus(sessionId, force, controller.signal).then((next) => {
					setLoading(false);
					if (next === null) {
						setFailed(true);
						return;
					}
					setFailed(false);
					setPayload(next);
				});
				return () => {
					controller.abort();
				};
			}, [sessionId]);
			(0, react.useEffect)(() => load(false), [load]);
			(0, react.useEffect)(() => {
				const cadence = Math.max(5e3, payload?.config.pollIntervalMs ?? 45e3);
				const timer = setInterval(() => {
					if (document.visibilityState === "hidden") return;
					fetchStatus(sessionId, false, new AbortController().signal).then((next) => {
						if (next === null) return;
						setFailed(false);
						setPayload(next);
					});
				}, cadence);
				const onVisible = () => {
					if (document.visibilityState !== "visible") return;
					fetchStatus(sessionId, false, new AbortController().signal).then((next) => {
						if (next !== null) setPayload(next);
					});
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [sessionId, payload?.config.pollIntervalMs]);
			(0, react.useEffect)(() => {
				if (!open) {
					setPanelStyle(null);
					return;
				}
				const place = () => {
					const anchor = anchorRef.current;
					const panel = panelRef.current;
					if (anchor === null || panel === null) return;
					setPanelStyle(placePanel(anchor, panel));
				};
				place();
				const onPointerDown = (event) => {
					const target = event.target;
					if (target !== null && (anchorRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				window.addEventListener("resize", place);
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					window.removeEventListener("resize", place);
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			const balance = payload?.balance ?? null;
			const session = payload?.session ?? null;
			const crossCheck = payload?.crossCheck ?? null;
			const currency = balance?.currency ?? "";
			const stale = balance?.error?.stale ?? null;
			const paidText = formatMoney(balance?.paid ?? stale?.paid ?? null, currency || stale?.currency || "");
			const bonusText = balance?.bonus !== null && balance?.bonus !== void 0 && balance.bonus > 0 ? formatMoney(balance.bonus, currency) : null;
			const spendText = session === null ? "--" : formatMoney(session.spend, currency);
			const unavailable = balance?.error !== null && balance?.error !== void 0;
			const crossCheckTokens = crossCheck?.tokens.total ?? projectedTokens;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dshbm_root",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					ref: anchorRef,
					type: "button",
					className: "dshbm_pill",
					"data-loading": loading ? "1" : "0",
					"data-balance-meter": "true",
					"aria-expanded": open,
					"aria-haspopup": "dialog",
					title: `余额 ${paidText} · 本次 ${spendText}`,
					onClick: (event) => {
						event.stopPropagation();
						if (open) {
							setOpen(false);
							return;
						}
						setOpen(true);
						load(true);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
						viewBox: "0 0 16 16",
						"aria-hidden": "true",
						className: "dshbm_icon",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
							cx: "8",
							cy: "8",
							r: "6.5",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.4"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M8 4.4v7.2M9.9 6.2c0-.9-.85-1.5-1.9-1.5s-1.9.6-1.9 1.5.85 1.35 1.9 1.55 1.9.65 1.9 1.55-.85 1.5-1.9 1.5-1.9-.6-1.9-1.5",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.2",
							strokeLinecap: "round"
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dshbm_label",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshbm_key",
								children: "余额 "
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshbm_strong",
								children: paidText
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshbm_sep",
								"aria-hidden": "true",
								children: "·"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshbm_key",
								children: "本次 "
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshbm_strong",
								children: session === null ? "--" : session.observed ? spendText : "待采样"
							})
						]
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: panelRef,
					className: "dshbm_panel",
					role: "dialog",
					"aria-label": "余额与本次消费",
					style: panelStyle === null ? { visibility: "hidden" } : panelStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshbm_title",
							children: "账户与本次会话"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "充值余额",
							value: paidText
						}),
						bonusText !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "赠金余额",
							value: bonusText
						}) : null,
						balance?.updatedAt !== null && balance?.updatedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "余额采样于",
							value: formatClock(balance.updatedAt)
						}) : null,
						balance?.ageMs !== null && balance?.ageMs !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "数据年龄",
							value: formatSpan(balance.ageMs)
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dshbm_rule" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "本次消费",
							value: session === null ? "--" : formatMoney(session.spend, currency, 4)
						}),
						session !== null && session.topUp > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "期间充值",
							value: formatMoney(session.topUp, currency)
						}) : null,
						session?.baseline != null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "基准时点",
							value: formatClock(session.baseline.time)
						}) : null,
						session !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "观测窗口",
							value: formatSpan(session.windowMs)
						}) : null,
						session !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "累计结算",
							value: `${session.chargedCount} 次`
						}) : null,
						crossCheck !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dshbm_rule" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "系数校验（估算）",
								value: formatMoney(crossCheck.cost, crossCheck.currency, 4)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "Token 合计",
								value: formatCount(crossCheck.tokens.total)
							})
						] }) : null,
						crossCheck === null && crossCheckTokens !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dshbm_rule" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "Token 合计",
							value: formatCount(crossCheckTokens)
						})] }) : null,
						session?.partial === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshbm_note",
							children: "基准取得较晚：会话开始到首次采样之间的消费无法从余额差还原，本次金额是下限。"
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshbm_note",
							children: "以账户余额差测量；同账号其它窗口的消费会一并计入。点击可立即刷新。"
						}),
						unavailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshbm_warn",
							children: ["余额不可用：", balance.error?.message]
						}) : null,
						failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshbm_warn",
							children: "本地接口请求失败，正在重试。"
						}) : null
					]
				}) : null]
			});
		}
		/**
		* Install the stylesheet once per document.
		*
		* Tagged with the plugin id, exactly like the shipped entries do it, so a hot
		* reload can tell that it is already installed.
		*/
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset["plugin"] = "dsh-balance-meter";
			tag.dataset["pluginCss"] = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		/** The plugin's own stylesheet; token-driven so every theme works. */
		const CSS = [
			".dshbm_root{display:inline-flex;align-items:center}",
			".dshbm_pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:none;border-radius:24px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;max-width:100%;cursor:pointer}",
			".dshbm_pill:hover,.dshbm_pill[aria-expanded=\"true\"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dshbm_pill[data-loading=\"1\"]{opacity:.65}",
			".dshbm_icon{flex:none;width:14px;height:14px}",
			".dshbm_label{overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".dshbm_strong{color:var(--dsw-alias-label-secondary);font-weight:600}",
			".dshbm_sep{color:var(--dsw-alias-separator-primary);margin:0 2px}",
			".dshbm_panel{position:fixed;z-index:1000;min-width:250px;max-width:330px;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:1.6}",
			".dshbm_title{font-weight:600;margin-bottom:6px}",
			".dshbm_row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}",
			".dshbm_key{color:var(--dsw-alias-label-tertiary)}",
			".dshbm_val{font-variant-numeric:tabular-nums;text-align:right}",
			".dshbm_rule{height:1px;margin:7px 0;background:var(--dsw-alias-border-l1)}",
			".dshbm_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;margin-top:6px}",
			".dshbm_warn{color:var(--dsw-alias-state-error-primary);margin-top:6px;font-size:11px}"
		].join("\n");
		//#endregion
		//#region src/client/index.tsx
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
		/**
		* Services this half consumes. `slots` is the renderer-owned registry; the
		* conversation service is what declares the dock key this entry occupies.
		*/
		const inject = ["slots", "conversation"];
		/** The cell key of this plugin's entry inside the dock. */
		const ENTRY_ID = "balance-meter";
		/**
		* Client plugin body: register the footer entry.
		*
		* @param ctx - the client root context.
		*/
		function apply(ctx) {
			ensureStyle();
			ctx.inject(["slots"], (scope) => {
				const wait = scope.slots.inject("conversation.composer.dock", () => {
					return scope.slots.register({
						name: "conversation.composer.dock",
						id: ENTRY_ID,
						order: 20
					}, BalanceChip);
				});
				scope.effect(() => () => {
					wait();
				}, "dsh-balance-meter: footer entry");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map