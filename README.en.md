# dsh-balance-meter

English | [中文](README.md)

A permanent readout in the DSH Web GUI footer (below the composer, on the same row as the
shipped stats pills) showing two live numbers:

- **Recharge balance** — read from the official account service (`deepseekAccount.getBalance`).
  Like the shipped account card, the **bonus wallet is never summed in** (bonus funds are granted
  and expire rather than being spent down); it gets its own line in the detail panel.
- **This session's spend** — what the current session has cost so far, measured as a
  **wallet delta**, not estimated locally from tokens.

Click it for the breakdown (recharge balance, bonus balance, sample time, spend, observation
window, top-ups seen, token cross-check) and to force an immediate refresh.

```
余额 ¥4.56 · 本次 ¥0.2130
```

![The dock row under the composer: next to the shipped stats pills, 余额 ¥2.56 本次 ¥1.40](docs/pill.png)

Clicking opens the breakdown panel (the same styling as the popover the shipped stats pills open):

![The detail panel: recharge balance, sample time, data age, session spend, baseline, observation window, settlements, token cross-check, token total](docs/panel.png)

## Why a wallet delta instead of token pricing

DeepSeek exposes exactly one exact money number: the account balance. There is no
per-session cost endpoint. So one session's exact cost can only be recovered by
differencing what the account owed before and after its work:

```
sessionSpend = Σ max(0, walletAt(i-1) - walletAt(i))
```

summed over the observations recorded while the session was alive. An observation where the
balance went **up** is not spending (it is a top-up or a grant): it is recorded as a top-up and
becomes the new reference. Because the provider charges the account as requests settle, this
difference converges on the official bill without pricing a single token locally.

The **token cross-check** in the detail panel is an independent second opinion: the session's
token usage, accumulated host-side, priced at the configured rates. It never becomes the
headline number.

## Install

```sh
# local directory (development: rebuild-free, refresh the page after an edit)
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-balance-meter

# npm (not published yet — see "Publishing" below)
dsh plugin --profile <profile> add dsh-balance-meter@latest
```

Replace `<profile>` with the profile you actually run (for example `desktop` or `web`).
**Restart dsh once** afterwards (the host half must reload), then refresh the page.

Equivalent manual install: add the dependency to the profile's `package.json` and insert the
row in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-balance-meter
      name: dsh-balance-meter
```

### Build from source

The package commits its build output (`lib/`), so a `link:` install needs no build step — only
editing the code does:

```sh
git clone https://github.com/Amo-aibiancheng/dsh-balance-meter.git
cd dsh-balance-meter
pnpm install
pnpm run build          # tsc emits lib/types, tsdown emits lib/index.js and lib/client.js
dsh plugin --profile <profile> add link:$PWD
```

Keep `pnpm run watch` running while editing the browser half and just refresh the page; a change
to the host half needs a dsh restart.

## Configuration

Everything has a default. Configuration is the `config:` block of the row in the profile's
`cordis.patch.yml`:

```yaml
- id: dsh-balance-meter
  name: dsh-balance-meter
  config:
    pollIntervalMs: 45000      # balance sampling cadence, 5000 - 1800000
    requestTimeoutMs: 20000    # one balance read, 3000 - 120000
    anomalyRatio: 0.5          # a single drop above this fraction of the wallet is an account event
    showTokenCrossCheck: true  # publish the token-derived estimate in the detail panel
    price:                     # used ONLY by the cross-check, per million tokens
      currency: CNY
      cacheHit: 0.1
      cacheMiss: 3
      output: 9
```

`Config` is a **schemastery schema**, the same shape the official plugins declare — not a
hand-written object of defaults. The loader resolves a row by calling the schema itself, so a plain
object makes the row **fail to import**, which is exactly how the first version of this plugin died
with `failed to import`; the activation case in `test/host.test.mjs` now guards it.

Out-of-range values are rejected by the schema and never reach the provider. Every configurable field
is `volatile()`, so a Settings edit applies to the **running** row immediately (the Host reads each
value through `.get()` on every use) with no restart.

## The algorithm and its edges

| Situation | Behavior |
| --- | --- |
| The plugin was observing when the session was created | The reference is the balance at birth; the delta is the session's cost (`session-start`) |
| The session predates this process | The earliest known observation is the reference, and the panel says the figure is a lower bound (`partial`) |
| Balance went up (top-up / grant / refund) | Not spending: recorded as a top-up, the reference rises with it, later spend stays exact |
| The same balance read again (retry, double poll) | One observation read twice, dropped outright — this is what makes a double charge impossible |
| A single drop above 50% of the wallet | Account-level event (grant expiry, wallet switch): rebase instead of charging |
| Out-of-order arrivals | Inserted at their correct place in the timeline; "the balance now" is always the newest observation by time, never overwritten by an older one |
| A currency disappears or switches | No differencing across the gap: rebase |
| A failed balance read | Recorded as unreadable, never as zero — so no cost is invented |
| The account holds bonus funds | The headline is the recharge wallet only (matching the shipped account card) and bonus keeps its own line; the two are never added |
| Two settlements close together | Both count, as long as the amount differs (a minimum-spacing guard was tried and **lost real charges**, so it was removed) |

**Known limitation, stated in the panel rather than hidden**: the wallet belongs to the
**account**, not to the session. Spending from the same account in another window or on another
machine lands in the same delta. With one client on one account the figure is exact; with
several at once, "this session" reads high. Sampling is polling, so charges between two samples
are folded into the next one.

## Layout

```
src/core/ledger.ts      pure algorithm core (no Node, no DOM): timeline + per-session accumulator
src/index.ts            host half: schemastery Config, balance reads, polling, token accounting, routes
src/client/index.tsx    browser half entry: registers the conversation.composer.dock entry
src/client/BalanceChip.tsx  the footer pill and its detail panel (React, props from the slot declaration)
src/client/format.ts    money and duration formatting rules
src/client/wire.ts      the payload types and fetch the browser half depends on
lib/index.js            built host half (ESM)
lib/client.js           built browser half (the __ModuleLoader__ closure)
lib/types/**            built type declarations
test/ledger.test.mjs    algorithm cases, one per row of the table above
test/host.test.mjs      host cases on a real cordis app: activation, teardown, routes, degraded paths, Config
test/client.test.mjs    browser cases: module format, slot registration, rendering
test/format.test.mjs    money formatting cases
```

### Written to the DSH conventions

- **TypeScript and the official build chain**: `tsc` emits declarations to `lib/types`, `tsdown`
  emits `lib/index.js` and `lib/client.js` — the same published shape (`main` / `types` / `exports`)
  the `@deepseek-ai/*` packages themselves use.
- **Types come from the SDK, not from guesses**: `PropsRuntime<'conversation.composer.dock'>` is the
  slot's own declaration (with `sessionId` and `useProjection` merged in by `dsh-client-ui-session`),
  and the host half uses the official `ctx.deepseekAccount` / `ctx.webServer` types.
  `pnpm run typecheck` is that gate.
- **`Config` is a schemastery schema**, so the loader can resolve it and Settings can generate a page.
- **The browser half bundles no React**: `react`, `react/jsx-runtime` and every `@deepseek-ai/*`
  package stay bare `require()` calls resolved by the shell's static module table. A second copy of
  React inside the plugin would break hooks across that boundary.
- **No credential leaves the host.** The browser half reads only this package's own routes.
- **One state authority.** The accumulator lives host-side, so tabs cannot double count.
- **No host UI is taken over.** The plugin appends one entry to the additive
  `conversation.composer.dock` list (`order: 20`; the shipped stats pill keeps `order: 0`).

## Development

```sh
pnpm install
pnpm run check      # typecheck → build → test (49 cases)
pnpm run build      # build only
pnpm run typecheck  # types only, against the real SDK
pnpm run watch      # incremental build while editing the browser half
```

Under a `link:` install, run `pnpm run build` and refresh the page; no reinstall is needed.

## License

MIT
