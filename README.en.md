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

# npm (once published)
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

Out-of-range numbers are clamped; a wrong type falls back to the default, so a bad edit cannot
pin the provider.

> Why there is no generated settings page: the DSH loader validates a plugin's exported `Config`
> by calling `Config.validate()`, so a plain-JS object of defaults makes the row crash at load time
> (verified against a real cordis, and pinned by a test). This plugin therefore exports no `Config`;
> the values are read from the patch and validated here. The cost is that Settings shows no page
> for it.

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
src/core/ledger.js   pure algorithm core (no Node, no DOM): observation timeline + per-session accumulator
src/index.js         host half: reads the official balance, polls, accounts tokens, serves /dsh-balance-meter/*
lib/client.js        browser half: a window.__ModuleLoader__.load closure registering conversation.composer.dock
test/ledger.test.mjs algorithm cases, one per row of the table above
test/host.test.mjs   host cases: routes, degraded paths, config clamping
test/client.test.mjs browser cases: module format, slot registration, rendered text
```

Design notes:

- **No credential leaves the host.** The browser half reads only this package's own routes.
- **One state authority.** The accumulator lives host-side, so tabs cannot double count.
- **No build step.** The browser half is a `__ModuleLoader__` closure; `require("react")` resolves
  against the shell's static module table.
- **No host UI is taken over.** The plugin appends one entry to the additive
  `conversation.composer.dock` list; it never shadows a shipped seat.

## Development

```sh
node --test test/          # algorithm cases, no third-party dependency
```

## License

MIT
