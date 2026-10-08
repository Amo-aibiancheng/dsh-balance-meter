import z from "@deepseek-ai/schemastery";
//#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.2.0-rc.2_@deepseek-ai+cordis@4.0.4/node_modules/@deepseek-ai/dsh-brand/lib/index.js
/**
* Duplicate-install-safe nominal primitive helpers.
*
* A brand makes structurally identical strings or numbers non-interchangeable
* at the type level: a `SessionId` cannot be passed where a `ToolCallId` is
* expected, and an event sequence cannot be passed as a log offset. Comparison,
* logging, and serialization retain the underlying primitive behavior.
*
* This package owns no concrete domain value and keeps no runtime identity or mutable
* state, so independently installed copies produce interchangeable values.
*
* @module @deepseek-ai/dsh-brand
*/
/**
* Apply a compile-time string brand without changing the value.
* @param value - string admitted by the domain that owns the target brand.
* @returns the same string with the requested compile-time brand.
*/
function brandString(value) {
	return value;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0._c9dee8deba3bd498ce58eb9c566c157f/node_modules/@deepseek-ai/dsh-session/lib/types/types.js
/**
* Brand a string as a {@link SessionId}.
* @param id - the raw session id string.
* @returns the same string with the session-id brand.
*/
function SessionId(id) {
	return brandString(id);
}
//#endregion
//#region src/core/ledger.ts
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
/** Tombstone for an amount that could not be read as a finite number. */
const UNREADABLE = NaN;
/**
* Coerce one amount to a finite number.
*
* @param value - number, or the decimal string the API returns.
* @returns the finite amount, or `NaN` when unreadable.
*/
function toAmount(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : UNREADABLE;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : UNREADABLE;
	}
	return UNREADABLE;
}
/**
* Normalize one raw paid-wallet record.
*
* The provider's wallet entries carry the amount in `balance`; a pre-summed
* `bonusBalance` is honored only when a composition already folded them.
*
* @param raw - a `{ currency, balance }` record from any source.
* @returns the normalized amounts, or `null` when the record has no currency.
*/
function normalizeWallet(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const record = raw;
	const currency = typeof record.currency === "string" ? record.currency.toUpperCase() : "";
	if (currency === "") return null;
	return {
		currency,
		paid: toAmount(record.balance),
		bonus: record.bonusBalance === void 0 ? 0 : toAmount(record.bonusBalance)
	};
}
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
function buildWallets(wallets, bonusWallets = []) {
	const out = {};
	for (const raw of wallets ?? []) {
		const normalized = normalizeWallet(raw);
		if (normalized === null) continue;
		out[normalized.currency] = {
			paid: normalized.paid,
			bonus: 0
		};
	}
	for (const raw of bonusWallets ?? []) {
		const normalized = normalizeWallet(raw);
		if (normalized === null) continue;
		const existing = out[normalized.currency] ?? {
			paid: 0,
			bonus: 0
		};
		const bonus = Number.isFinite(normalized.paid) ? existing.bonus + normalized.paid : existing.bonus;
		out[normalized.currency] = {
			paid: existing.paid,
			bonus
		};
	}
	return out;
}
/**
* Pick the currency to headline: the paid currency with the largest balance,
* falling back to the first readable one.
*
* @param wallets - wallet map.
* @returns currency code, or `''` when nothing is readable.
*/
function primaryCurrency(wallets) {
	let best = "";
	let bestAmount = -Infinity;
	for (const [currency, wallet] of Object.entries(wallets ?? {})) {
		if (!Number.isFinite(wallet.paid)) continue;
		if (wallet.paid > bestAmount) {
			bestAmount = wallet.paid;
			best = currency;
		}
	}
	if (best !== "") return best;
	return Object.keys(wallets ?? {})[0] ?? "";
}
/**
* Freeze one observation into the immutable record the timeline stores.
*
* @param time - epoch milliseconds when the provider was read.
* @param wallets - wallet map.
* @returns the reading.
*/
function createReading(time, wallets) {
	const currency = primaryCurrency(wallets);
	const wallet = wallets[currency];
	return {
		time: Number.isFinite(time) ? time : Date.now(),
		wallets,
		paid: wallet !== void 0 && Number.isFinite(wallet.paid) ? wallet.paid : UNREADABLE,
		bonus: wallet !== void 0 && Number.isFinite(wallet.bonus) ? wallet.bonus : 0,
		currency,
		seq: 0
	};
}
/**
* Compare two readings for identity (same moment, same money).
*
* @param a - earlier reading.
* @param b - later reading.
* @returns `true` when both describe one observation.
*/
function sameObservation(a, b) {
	if (a === null || b === null) return a === b;
	if (a.time !== b.time) return false;
	const keys = /* @__PURE__ */ new Set([...Object.keys(a.wallets), ...Object.keys(b.wallets)]);
	for (const key of keys) {
		const left = a.wallets[key] ?? {
			paid: 0,
			bonus: 0
		};
		const right = b.wallets[key] ?? {
			paid: 0,
			bonus: 0
		};
		if (left.paid !== right.paid || left.bonus !== right.bonus) return false;
	}
	return true;
}
/**
* A comparable identity string for one wallet map.
*
* @param wallets - wallet map.
* @returns stable, currency-sorted key.
*/
function walletKey(wallets) {
	return Object.keys(wallets).sort().map((currency) => {
		const wallet = wallets[currency];
		return `${currency}:${String(wallet.paid)}:${String(wallet.bonus)}`;
	}).join("|");
}
/**
* Create an empty ledger. One ledger owns one account's observation timeline
* plus one spend accumulator per Session.
*
* @param limits - guard overrides from plugin config.
* @returns the ledger.
*/
function createLedger(limits = {}) {
	const anomalyRatio = limits.anomalyRatio ?? .5;
	const ratio = () => typeof anomalyRatio === "function" ? Number(anomalyRatio()) : Number(anomalyRatio);
	/** Ascending-by-time observation timeline (newest last). */
	let readings = [];
	/** Newest observation BY TIME — what the wallet is now. */
	let latest = null;
	/** The observation the previous push stored; deduplication compares to this. */
	let cursor = null;
	/** Wallet identity of {@link cursor}. */
	let cursorKey = "";
	/** Session accumulators keyed by Session id. */
	const sessions = /* @__PURE__ */ new Map();
	/** Token accounting keyed by Session id. */
	const tokens = /* @__PURE__ */ new Map();
	let sequence = 0;
	/**
	* Insert chronologically, collapsing duplicate moments, and trim the tail.
	*
	* @param reading - the observation to store.
	* @returns the stored (canonical) reading.
	*/
	function pushReading(reading) {
		const last = readings.length === 0 ? null : readings[readings.length - 1];
		if (last !== null && sameObservation(last, reading)) return last;
		reading.seq = ++sequence;
		if (last !== null && reading.time < last.time) {
			let at = readings.length - 1;
			while (at > 0 && readings[at - 1].time > reading.time) at -= 1;
			readings.splice(at, 0, reading);
			return reading;
		}
		readings.push(reading);
		if (readings.length > 600) readings.splice(0, readings.length - 600);
		return reading;
	}
	/**
	* The newest observation by time. A late arrival can be inserted anywhere, so
	* "what the wallet is now" is a scan, not the array tail.
	*
	* @returns the newest reading.
	*/
	function maxReading() {
		if (readings.length === 0) return null;
		let newest = readings[0];
		for (const reading of readings) if (reading.time > newest.time) newest = reading;
		return newest;
	}
	/**
	* Find the first stored observation at or after one instant.
	*
	* @param time - epoch milliseconds.
	* @returns the seed observation, or `null` when none is new enough.
	*/
	function seedAt(time) {
		for (const reading of readings) if (reading.time >= time) return reading;
		return null;
	}
	/**
	* Get or create one Session's accumulator, keeping the earliest known birth.
	*
	* @param sessionId - the Session id.
	* @param createdMs - Session creation time in epoch milliseconds.
	* @returns the accumulator.
	*/
	function accumulator(sessionId, createdMs) {
		let state = sessions.get(sessionId);
		if (state === void 0) {
			state = {
				sessionId,
				createdMs: Number.isFinite(createdMs) ? createdMs : Date.now(),
				baseline: null,
				baselineSource: "none",
				topUp: 0,
				spend: 0,
				chargedCount: 0,
				observed: false,
				partial: false,
				lastMoveMs: 0
			};
			sessions.set(sessionId, state);
		} else if (Number.isFinite(createdMs) && createdMs < state.createdMs) state.createdMs = createdMs;
		return state;
	}
	/**
	* Adopt the baseline observation of one Session if it has none yet.
	*
	* @param state - the Session accumulator.
	* @returns `true` when a baseline was adopted on this call.
	*/
	function seedBaseline(state) {
		if (state.baseline !== null) return false;
		let seed = seedAt(state.createdMs);
		if (seed === null) {
			const oldest = readings[0];
			if (oldest === void 0) return false;
			seed = oldest;
		}
		state.baseline = seed;
		state.baselineSource = seed.time - state.createdMs <= 6e4 ? "session-start" : "first-observation";
		state.partial = state.baselineSource !== "session-start";
		return true;
	}
	/**
	* Decide what one newer observation means for one Session, without touching
	* any state. The caller is the single writer of the reference, which keeps
	* "charge this drop" and "move past this drop" from fighting over one field.
	*
	* @param state - the Session accumulator.
	* @param reading - the newer observation.
	* @returns the decision, or `null` when the observation changes nothing.
	*/
	function classify(state, reading) {
		const baseline = state.baseline;
		if (baseline === null || reading.time <= baseline.time) return null;
		const currency = baseline.currency;
		const before = baseline.wallets[currency]?.paid;
		const after = reading.wallets[currency]?.paid;
		if (before === void 0 || after === void 0 || !Number.isFinite(before) || !Number.isFinite(after)) return {
			kind: "rebased",
			topUp: 0
		};
		const delta = before - after;
		if (delta > 0) {
			if (before > 0 && delta > before * ratio()) return { kind: "jumped" };
			return {
				kind: "charged",
				amount: delta
			};
		}
		if (delta < 0) return {
			kind: "rebased",
			topUp: -delta
		};
		return { kind: "jumped" };
	}
	/**
	* Record one wallet observation and move every live Session's accumulator.
	*
	* @param input - the observation.
	* @returns the stored reading.
	*/
	function recordReading(input) {
		const time = Number.isFinite(input.time) ? Number(input.time) : Date.now();
		const wallets = input.wallets ?? buildWallets(input.balance, input.bonusWallets);
		const key = walletKey(wallets);
		if (cursor !== null && key === cursorKey && Math.abs(time - cursor.time) <= SAME_MONEY_WINDOW_MS) return cursor;
		const reading = pushReading(createReading(time, wallets));
		cursor = reading;
		cursorKey = key;
		latest = maxReading();
		for (const state of sessions.values()) {
			if (state.baseline === null) seedBaseline(state);
			const outcome = classify(state, reading);
			if (outcome === null) continue;
			state.baseline = reading;
			state.lastMoveMs = reading.time;
			if (outcome.kind === "charged") {
				state.spend += outcome.amount;
				state.chargedCount += 1;
				state.observed = true;
			} else if (outcome.kind === "rebased") {
				state.topUp += outcome.topUp;
				state.baselineSource = "rebased";
			}
		}
		return reading;
	}
	/**
	* Read one Session's current measurement.
	*
	* @param sessionId - the Session id.
	* @param createdMs - Session creation time in epoch milliseconds.
	* @param nowMs - current epoch milliseconds.
	* @returns the measurement.
	*/
	function measureSession(sessionId, createdMs, nowMs = Date.now()) {
		const state = accumulator(sessionId, createdMs);
		seedBaseline(state);
		const baseline = state.baseline;
		const current = latest;
		return {
			sessionId,
			createdMs: state.createdMs,
			baseline: baseline === null ? null : {
				time: baseline.time,
				currency: baseline.currency,
				paid: baseline.wallets[baseline.currency]?.paid ?? null
			},
			baselineSource: state.baselineSource,
			partial: state.partial,
			observed: state.observed,
			spend: state.spend,
			topUp: state.topUp,
			chargedCount: state.chargedCount,
			windowMs: baseline === null ? 0 : Math.max(0, (current?.time ?? nowMs) - baseline.time),
			readingCount: readings.length,
			scope: "session-window"
		};
	}
	/**
	* Account one durable Session event: the token cross-check's only input.
	*
	* @param sessionId - the Session id.
	* @param createdMs - Session creation time in epoch milliseconds.
	* @param event - a durable Session event.
	*/
	function ingestSessionEvent(sessionId, createdMs, event) {
		if (event.type !== "assistant/message") return;
		const data = event.data;
		if (data === null || typeof data !== "object") return;
		const usage = data.usage;
		if (usage === null || typeof usage !== "object") return;
		const record = usage;
		const buckets = tokens.get(sessionId) ?? {
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0
		};
		buckets.input += toCount(record.inputTokens);
		buckets.cacheRead += toCount(record.cacheReadTokens);
		buckets.cacheWrite += toCount(record.cacheWriteTokens);
		buckets.output += toCount(record.outputTokens) + toCount(record.reasoningTokens);
		tokens.set(sessionId, buckets);
		accumulator(sessionId, createdMs);
	}
	/**
	* The token cross-check: what the Session's tokens would cost at the
	* configured rates. This never drives the headline number.
	*
	* @param sessionId - the Session id.
	* @param price - rates per million tokens.
	* @returns the estimate, or `null` without usage.
	*/
	function estimateCost(sessionId, price) {
		const buckets = tokens.get(sessionId);
		if (buckets === void 0) return null;
		const total = buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output;
		if (total === 0) return null;
		const perMillion = 1e6;
		const cost = buckets.input / perMillion * price.miss + buckets.cacheRead / perMillion * price.hit + buckets.cacheWrite / perMillion * price.miss + buckets.output / perMillion * price.out;
		return {
			tokens: {
				...buckets,
				total
			},
			cost,
			currency: price.currency
		};
	}
	return {
		recordReading,
		measureSession,
		ingestSessionEvent,
		estimateCost,
		latest: () => latest,
		readingAtOrAfter: seedAt,
		sessionIds: () => [...sessions.keys()],
		forgetSession: (sessionId) => {
			sessions.delete(sessionId);
			tokens.delete(sessionId);
		}
	};
}
/**
* How close two reads carrying identical money must be to count as one
* observation. A provider cannot report two different settlements at one balance
* inside this window, so treating them as one makes a retry or a duplicate poll
* free; a longer gap keeps its own observation, because a baseline may need it.
*/
const SAME_MONEY_WINDOW_MS = 1e3;
/**
* Coerce one usage figure to a non-negative finite count.
*
* @param value - raw usage field.
* @returns the count, or 0.
*/
function toCount(value) {
	const amount = toAmount(value);
	return Number.isFinite(amount) && amount > 0 ? amount : 0;
}
//#endregion
//#region src/index.ts
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
/**
* Plugin config schema.
*
* This MUST be a schemastery schema rather than a plain object of defaults: the
* loader validates a row's `Config` export by calling `.validate()` on it, so a
* hand-written default object makes the entry fail to import. The volatile
* fields are the ones a Settings edit must reach without remounting the row.
*/
const Config = z.object({
	/** How long a reading is reused before the account is asked again (ms). */
	pollIntervalMs: z.natural().min(5e3).max(18e5).default(45e3).volatile(),
	/** Provider read timeout (ms). */
	requestTimeoutMs: z.natural().min(3e3).max(12e4).default(2e4).volatile(),
	/** A single drop above this fraction of the wallet is an account event, not Session spend. */
	anomalyRatio: z.number().min(.05).max(1).default(.5).volatile(),
	/** Publish the token cross-check beside the measured delta. */
	showTokenCrossCheck: z.boolean().default(true).volatile(),
	/** Rates used ONLY by the cross-check, per million tokens. */
	price: z.object({
		currency: z.string().default("CNY").volatile(),
		cacheHit: z.natural().default(1).volatile(),
		cacheMiss: z.natural().default(30).volatile(),
		output: z.natural().default(90).volatile()
	}).default({
		currency: "CNY",
		cacheHit: 1,
		cacheMiss: 30,
		output: 90
	})
});
/** Required services: the route registry and the official account provider. */
const inject = ["webServer", "deepseekAccount"];
/** Route family root. The browser calls it DOCUMENT-RELATIVE (see the client half). */
const ROUTE_STATUS = "/dsh-balance-meter/status";
const ROUTE_REFRESH = "/dsh-balance-meter/refresh";
/** Backoff ceiling for a failing provider read. */
const MAX_BACKOFF_MS = 18e5;
/** Cache-entry ceiling for the session-birth memo; disposal is the normal path. */
const CREATED_CACHE_MAX = 512;
const JSON_HEADERS = {
	"Content-Type": "application/json; charset=utf-8",
	"Cache-Control": "no-store"
};
/**
* Read one config field's live value.
*
* A volatile field arrives as a handle whose `.get()` returns the value the
* settings subsystem last committed — that indirection is what lets a Settings
* edit reach this running row. A plain field (a patch that set the value
* directly) is returned as-is, so both shapes work.
*
* @param field - the schema field, or the value the loader already resolved.
* @param fallback - value used when the field is absent.
* @returns the effective value.
*/
function fieldValue(field, fallback) {
	if (field === void 0) return fallback;
	if (field !== null && typeof field === "object" && "get" in field && typeof field.get === "function") {
		const value = field.get();
		return value === void 0 ? fallback : value;
	}
	return field;
}
/**
* Resolve the live price table for the cross-check.
*
* @param config - the row config.
* @returns rates per million tokens.
*/
function priceTable(config) {
	const price = config?.price;
	const currency = fieldValue(price?.currency, "CNY");
	const rate = (value, fallback) => {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
	};
	return {
		currency: typeof currency === "string" && currency !== "" ? currency.toUpperCase() : "CNY",
		hit: rate(fieldValue(price?.cacheHit, 1), 1),
		miss: rate(fieldValue(price?.cacheMiss, 30), 30),
		out: rate(fieldValue(price?.output, 90), 90)
	};
}
/**
* Race one promise against a timeout, always clearing the timer.
*
* @param promise - the work to bound.
* @param ms - the budget in milliseconds.
* @param onTimeout - value produced when the budget runs out.
* @returns the winner.
*/
async function withTimeout(promise, ms, onTimeout) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((resolve) => {
			timer = setTimeout(() => resolve(onTimeout()), ms);
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
/**
* Copy a wallet map, so a response never aliases the ledger's live objects.
*
* @param wallets - wallet map.
* @returns a detached copy.
*/
function copyWallets(wallets) {
	const out = {};
	for (const [currency, wallet] of Object.entries(wallets ?? {})) out[currency] = {
		paid: wallet.paid,
		bonus: wallet.bonus
	};
	return out;
}
/**
* Mount the observation loop and the route family.
*
* @param ctx - host context carrying `webServer` and `deepseekAccount`.
* @param config - the row's config as the loader resolved it.
*/
function apply(ctx, config) {
	const ledger = createLedger({ anomalyRatio: () => fieldValue(config?.anomalyRatio, .5) });
	/** sessionId -> creation time, memoized for event ingestion. */
	const createdCache = /* @__PURE__ */ new Map();
	/** In-flight provider read, shared by every caller. */
	let inFlight = null;
	/** Last provider outcome. */
	let lastOutcome = null;
	/** Epoch ms of the last read that reached the account. */
	let lastReadAt = 0;
	const pollIntervalMs = () => fieldValue(config?.pollIntervalMs, 45e3);
	const requestTimeoutMs = () => fieldValue(config?.requestTimeoutMs, 2e4);
	/**
	* Read the durable creation time of one Session.
	*
	* The wallet delta is measured from a Session's birth, so the Host needs that
	* instant. The session store is the authority; an Agent that is still live is
	* the fallback; a composition with neither falls back to now, which the ledger
	* records as a late baseline rather than pretending to know.
	*
	* @param sessionId - the Session id.
	* @returns creation time in epoch milliseconds.
	*/
	function sessionCreatedMs(sessionId) {
		const id = SessionId(sessionId);
		try {
			const header = ctx.get("sessions")?.get(id)?.header;
			if (header !== void 0 && Number.isFinite(header.createdAt)) return Number(header.createdAt);
		} catch {}
		try {
			const created = ctx.get("agents")?.get(id)?.session?.header?.createdAt;
			if (Number.isFinite(created)) return Number(created);
		} catch {}
		return Date.now();
	}
	/**
	* Ask the official account provider for the wallet balance.
	*
	* @returns the outcome; never throws.
	*/
	async function readBalance() {
		const client = {
			version: "dsh-balance-meter/0.2.0",
			locale: process.env["LANG"] ?? "zh-CN",
			timezoneOffsetSeconds: -(/* @__PURE__ */ new Date()).getTimezoneOffset() * 60
		};
		let details;
		try {
			details = await ctx.deepseekAccount.getBalance(client);
		} catch (error) {
			return {
				ok: false,
				code: "PROVIDER",
				message: `账号服务读取失败: ${String(error?.message ?? error).slice(0, 160)}`
			};
		}
		if (details === null) return {
			ok: false,
			code: "SIGNED_OUT",
			message: "未登录 DeepSeek 账号"
		};
		if (details.status !== "ready") return {
			ok: false,
			code: "BALANCE_FAILED",
			message: "余额查询失败（账号授权可能已失效）"
		};
		return {
			ok: true,
			wallets: details.value,
			bonusWallets: details.bonusWallets
		};
	}
	/**
	* Read the account unless the newest observation is still inside the TTL.
	* Concurrent callers share one provider request.
	*
	* @param force - bypass the TTL (an explicit user refresh).
	* @returns the latest outcome.
	*/
	async function ensureReading(force) {
		const fresh = lastReadAt > 0 && Date.now() - lastReadAt < pollIntervalMs();
		if (!force && fresh && lastOutcome !== null) return lastOutcome;
		if (inFlight !== null) return inFlight;
		inFlight = (async () => {
			try {
				const outcome = await withTimeout(readBalance(), requestTimeoutMs(), () => ({
					ok: false,
					code: "TIMEOUT",
					message: "余额查询超时"
				}));
				lastOutcome = outcome;
				if (outcome.ok) {
					lastReadAt = Date.now();
					ledger.recordReading({
						time: lastReadAt,
						balance: outcome.wallets,
						bonusWallets: outcome.bonusWallets
					});
				}
				return outcome;
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	}
	/**
	* Build the payload the footer renders.
	*
	* @param sessionId - the Session asking, or `''` for a global read.
	* @param outcome - the last provider outcome.
	* @returns the status payload.
	*/
	function buildPayload(sessionId, outcome) {
		const now = Date.now();
		const latest = ledger.latest();
		const measurement = sessionId === "" ? null : ledger.measureSession(sessionId, sessionCreatedMs(sessionId), now);
		const crossCheck = fieldValue(config?.showTokenCrossCheck, true) && sessionId !== "" ? ledger.estimateCost(sessionId, priceTable(config)) : null;
		const balanceError = outcome === null || !outcome.ok ? {
			code: outcome?.code ?? "PENDING",
			message: outcome?.message ?? "尚未取得余额",
			stale: latest === null ? null : {
				time: latest.time,
				paid: latest.paid,
				currency: latest.currency
			}
		} : null;
		return {
			ok: true,
			config: {
				pollIntervalMs: pollIntervalMs(),
				showTokenCrossCheck: fieldValue(config?.showTokenCrossCheck, true)
			},
			balance: {
				paid: latest === null || !Number.isFinite(latest.paid) ? null : latest.paid,
				bonus: latest?.bonus ?? null,
				currency: latest?.currency ?? "",
				wallets: copyWallets(latest?.wallets),
				updatedAt: latest?.time ?? null,
				ageMs: latest === null ? null : now - latest.time,
				error: balanceError
			},
			session: measurement,
			crossCheck,
			ledger: {
				readingCount: latest?.seq ?? 0,
				sessionCount: ledger.sessionIds().length
			},
			serverTime: now
		};
	}
	/**
	* Write one JSON response.
	*
	* @param res - the server response.
	* @param status - HTTP status.
	* @param body - JSON-serializable body.
	*/
	function sendJson(res, status, body) {
		res.writeHead(status, { ...JSON_HEADERS });
		res.end(JSON.stringify(body));
	}
	/**
	* Drive one route from its request URL.
	*
	* @param url - the request URL (path plus query).
	* @param res - the server response.
	* @param force - whether this route forces a provider read.
	*/
	async function handle(url, res, force) {
		try {
			sendJson(res, 200, buildPayload(new URL(url ?? "/", "http://localhost").searchParams.get("session") ?? "", await ensureReading(force)));
		} catch (error) {
			sendJson(res, 500, {
				ok: false,
				code: "INTERNAL",
				message: String(error?.message ?? error).slice(0, 200)
			});
		}
	}
	ctx.effect(() => {
		const disposers = [ctx.webServer.register({
			kind: "exact",
			path: ROUTE_STATUS,
			handler: (req, res) => handle(req.url, res, false)
		}), ctx.webServer.register({
			kind: "exact",
			path: ROUTE_REFRESH,
			handler: (req, res) => handle(req.url, res, true)
		})];
		return () => {
			for (const dispose of disposers.splice(0)) try {
				dispose();
			} catch {}
		};
	}, "dsh-balance-meter: routes");
	ctx.effect(() => ctx.on("session/event", (session, event) => {
		try {
			const sessionId = session.id;
			let created = createdCache.get(sessionId);
			if (created === void 0) {
				const header = Number(session.header?.createdAt);
				created = Number.isFinite(header) ? header : Date.now();
				createdCache.set(sessionId, created);
				if (createdCache.size > CREATED_CACHE_MAX) {
					const oldest = createdCache.keys().next();
					if (oldest.done !== true) createdCache.delete(oldest.value);
				}
			}
			ledger.ingestSessionEvent(sessionId, created, event);
		} catch {}
	}), "dsh-balance-meter: token accounting");
	ctx.effect(() => ctx.on("session/disposed", (session) => {
		const sessionId = session.id;
		createdCache.delete(sessionId);
		ledger.forgetSession(sessionId);
	}), "dsh-balance-meter: session cleanup");
	ctx.effect(() => {
		let stopped = false;
		let timer;
		let failures = 0;
		const schedule = () => {
			if (stopped) return;
			const delay = failures === 0 ? pollIntervalMs() : Math.min(MAX_BACKOFF_MS, pollIntervalMs() * 2 ** Math.min(failures, 3));
			timer = setTimeout(() => {
				tick();
			}, delay);
		};
		const tick = async () => {
			try {
				failures = (await ensureReading(false)).ok ? 0 : failures + 1;
			} catch {
				failures += 1;
			}
			schedule();
		};
		timer = setTimeout(() => {
			tick();
		}, 1200);
		return () => {
			stopped = true;
			if (timer !== void 0) clearTimeout(timer);
		};
	}, "dsh-balance-meter: balance poll");
}
//#endregion
export { Config, apply, inject };

//# sourceMappingURL=index.js.map