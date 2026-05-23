# steam-mobile

A headless, fully-typed **ESM TypeScript** client for the **Steam mobile app**, built for trading. It
unifies the *web* logic of [`steamcommunity`](https://github.com/DoctorMcKay/node-steamcommunity) and
[`steam-tradeoffer-manager`](https://github.com/DoctorMcKay/node-steam-tradeoffer-manager) into one
cohesive, Promise-native package — with **no `steam-user` and no Steam CM binary protocol**.

Everything the mobile app needs is in-package: credential login, TOTP, mobile confirmations
(`mobileconf`), and the `IAuthenticationService` protobufs. The only runtime dependencies are
[`got`](https://github.com/sindresorhus/got), [`proxy-agent`](https://github.com/TooTallNate/proxy-agents),
[`tough-cookie`](https://github.com/salesforce/tough-cookie), [`steamid`](https://github.com/DoctorMcKay/node-steamid),
and [`@bufbuild/protobuf`](https://github.com/bufbuild/protobuf-es).

The client impersonates the Steam mobile app on the wire (a MobileApp-platform access token, per-host
user agents, mobile cookies, and `mobileconf` confirmations). MobileApp is the only platform whose
access token can self-renew over plain HTTP, which is what lets this library run headless without a
persistent CM connection.

## Table of contents

- [Installation](#installation)
- [The basics](#the-basics)
- [Logging in](#logging-in)
- [SteamMobile](#steammobile) — the root client
- [bot.trade](#bottrade) — sending, reading, and polling trade offers
- [TradeOffer](#tradeoffer) — a single offer
- [bot.community](#botcommunity) — inventories, profiles, trade URLs, API keys
- [bot.session](#botsession) — token lifecycle and sessions
- [bot.confirmations](#botconfirmations) — low-level mobile confirmations
- [Data types](#data-types)
- [Enums](#enums)
- [Errors](#errors)
- [Mobile-app impersonation](#mobile-app-impersonation)
- [Notes & limitations](#notes--limitations)
- [Development](#development)

---

## Installation

```bash
pnpm add steam-mobile   # Node 24+, ESM only
```

This package is ESM-only and targets Node 24+. Import it with `import { SteamMobile } from "steam-mobile"`.

## The basics

```ts
import { SteamMobile } from "steam-mobile";

const bot = await new SteamMobile({
  refreshToken: process.env.STEAM_REFRESH_TOKEN!,
  identitySecret: process.env.STEAM_IDENTITY_SECRET, // only needed to confirm trades
}).login();

console.log("Logged in as", bot.steamID.getSteamID64());

const { sent, received } = await bot.trade.getOffers();
console.log(`${sent.length} sent, ${received.length} received`);
```

Construction is **synchronous** and does no network I/O — your `steamID` is known immediately because
it is encoded in the refresh-token JWT. The single network step is `await bot.login()`, which mints the
access token and applies the login cookie. Every method awaits the token lazily, so you *can* call
methods before `login()`, but calling `login()` up front gives you fail-fast behavior and lets you
auto-start polling.

---

## Logging in

There are two ways to get a session. In production you almost always want the **refresh-token** path:
log in once with credentials, store the long-lived refresh token, and reuse it.

### From a refresh token (the normal path)

```ts
const bot = await new SteamMobile({ refreshToken }).login();
```

A MobileApp refresh token lives ~211 days. The library renews the ~24-hour access token lazily and
rotates the refresh token automatically as it nears end-of-life — emitting a [`refreshToken`](#event-refreshtoken)
event each time so you can persist the new one.

### From credentials

When you don't yet have a refresh token, use `loginWithCredentials`. This drives the full
`IAuthenticationService` credential flow (RSA password encryption → begin session → answer Steam Guard
→ poll) entirely in-package — no `steam-session` needed.

#### loginWithCredentials(options)

- `options`
  - `accountName` — Your Steam account name (login name, not persona).
  - `password` — Your account password.
  - `sharedSecret` — Optional. Your TOTP `shared_secret`. If present, device (TOTP) Steam Guard codes are answered automatically.
  - `steamGuardCode` — Optional. A Steam Guard code you supply yourself (email or device).
  - `machineToken` — Optional. A previously-issued Steam Guard machine token (`guard_data`) to skip the Guard prompt.
  - `proxy` — Optional. A proxy URL; routes the entire login flow.
  - `mobileProfile` — Optional. `"ios"` (default), `"android"`, or an object overriding individual [profile fields](#mobile-app-impersonation).
  - `onSteamGuardRequired` — Optional. `async ({ type, message }) => code`. Called when a code is required and none was supplied (e.g. an email code). Resolve it with the code to continue.

Returns a `Promise` that resolves to a **`LoginResult`**:

- `refreshToken` — The MobileApp refresh token. **Store this** and feed it to `new SteamMobile({ refreshToken })`.
- `accessToken` — The freshly-minted access token, or `undefined` if Steam didn't return one.
- `steamId` — The account's SteamID64, as a string.
- `accountName` — The account name Steam echoed back.
- `steamGuardMachineToken` — A machine token to reuse as `machineToken` next time, or `undefined`.

```ts
import { loginWithCredentials, SteamMobile } from "steam-mobile";

const { refreshToken } = await loginWithCredentials({
  accountName: "myaccount",
  password: "…",
  sharedSecret: "…",            // answers the device-code 2FA automatically
  // onSteamGuardRequired: async ({ message }) => await promptUser(message),
});

const bot = await new SteamMobile({ refreshToken }).login();
```

Credential login is rate-limited by Steam, so do it once per device and reuse the refresh token. For
finer-grained control over the state machine (events for each step, manual code submission), use the
[`CredentialSession`](#credentialsession-low-level) class directly.

#### CredentialSession (low-level)

`loginWithCredentials` is a thin one-shot wrapper around this `EventEmitter`. Use it directly when you
need to react to each step.

- `new CredentialSession(http, profile[, pollTimeoutMs])` — `http` is an `HttpClient`, `profile` a resolved [`MobileProfile`](#mobile-app-impersonation), `pollTimeoutMs` defaults to 180000.
- `start(options)` — Begins the flow. `options` is the credentials (`accountName`, `password`, `sharedSecret?`, `steamGuardCode?`, `machineToken?`). Returns `Promise<void>`.
- `submitSteamGuardCode(code)` — Supplies a code in response to a `steamGuardRequired` event. Returns `Promise<void>`.
- `stop()` — Aborts the flow and clears the poll timer.
- Properties (populated as the flow progresses): `steamID?`, `accountName`, `accessToken?`, `refreshToken?`, `steamGuardMachineToken?`.
- Events:
  - `authenticated` — A refresh token is available; read it off the instance.
  - `steamGuardRequired` — `{ type, message }`. No code could be supplied automatically; call `submitSteamGuardCode()`.
  - `remoteInteraction` — Steam is waiting for the user to approve on their phone (device/email confirmation).
  - `steamGuardMachineToken` — `token`. A new machine token to reuse next time as `machineToken`.
  - `timeout` — The confirmation window elapsed.
  - `error` — `error`. The flow failed.
  - `debug` — `message`. Verbose step logging.

---

## SteamMobile

The root client. It owns the HTTP layer, the session, and the namespaces, and it re-emits every
[trade event](#trade-events) so you can listen on `bot` directly instead of `bot.trade`.

### Constructor: new SteamMobile(options)

- `options`
  - `refreshToken` — **Required.** A MobileApp refresh token (from `loginWithCredentials` or a prior session).
  - `identitySecret` — Optional. Your `identity_secret`, required to **confirm** trades and other mobile confirmations. Read-only operations and sending don't need it.
  - `proxy` — Optional. A proxy URL (`http://user:pass@host:port`, `socks5://…`, etc.). All traffic — API, community, and confirmations — routes through it.
  - `mobileProfile` — Optional. `"ios"` (default), `"android"`, or a `Partial<MobileProfile>` to override individual fields. See [Mobile-app impersonation](#mobile-app-impersonation).
  - `polling` — Optional. `true` to start polling with default cadence after `login()`, or a [`PollOptions`](#polloptions) object to tune it / resume from saved `pollData`.

Throws `SteamSessionExpiredError` synchronously if the refresh token is malformed (no SteamID in its
payload). Does **not** make any network request.

### Properties

- `steamID` — A [`SteamID`](https://github.com/DoctorMcKay/node-steamid) object for the logged-in account. Available immediately after construction.
- `accessToken` — The current access token (`string`), or `undefined` before the first mint.
- `refreshToken` — The current refresh token (`string`). This changes when Steam rotates it; listen for the [`refreshToken`](#event-refreshtoken) event to persist updates.
- `identitySecret` — The `identity_secret` you passed, or `undefined`.
- `trade` — The [TradeNamespace](#bottrade).
- `community` — The [CommunityNamespace](#botcommunity).
- `session` — The [SessionManager](#botsession).
- `confirmations` — The [ConfirmationManager](#botconfirmations).
- `http`, `api` — The low-level `HttpClient` and `WebApiClient`. You normally won't need these.

### login()

Mints the access token (failing fast if the refresh token is dead), applies the `steamLoginSecure`
login cookie, and — if you passed `polling` — starts the poll loop. Returns a `Promise` that resolves
to the `SteamMobile` instance itself, so you can write `const bot = await new SteamMobile(opts).login()`.

### ensureApiKey(\[domain])

- `domain` — Optional. The domain to register the key under (default `"assetpay.gg"`). Steam's API-key `domain` is a hostname label, not a URL.

Returns the account's existing Web API key, or registers a new one (auto-accepting the mobile
confirmation prompt if `identitySecret` is set), as a `Promise<string | null>`. Resolves to `null` when
the account is **ineligible** for a key (unverified email, no mobile authenticator, or a
[limited account](#notes--limitations)). This is a convenience passthrough to
[`bot.community.ensureApiKey`](#communityensureapikeydomain).

### shutdown()

Stops the poll loop and removes all event listeners (on both `bot` and `bot.trade`). Call this when
you're done with the client so it doesn't keep timers alive. Returns a `Promise<void>`.

### Events

`SteamMobile` re-emits all [trade events](#trade-events) (`newOffer`, `sentOfferChanged`,
`receivedOfferChanged`, `unknownOfferSent`, `pollData`, `pollSuccess`, `pollFailure`, `debug`) plus two
of its own:

#### Event: refreshToken

- `token` — The new refresh token (`string`).

Emitted when Steam rotates your refresh token (which happens automatically near end-of-life). **Persist
the new value** — the old one stops working.

#### Event: sessionExpired

- `error` — A `SteamSessionExpiredError`.

Emitted when the refresh token is rejected or expired and the session can no longer be renewed. This is
your cue to re-authenticate (e.g. with `loginWithCredentials`).

---

## bot.trade

The trade namespace. It's an `EventEmitter` (see [Trade events](#trade-events)) and holds every method for
reading, sending, and watching trade offers.

### createOffer(target)

- `target` — An [`OfferTarget`](#offertarget): either `{ tradeUrl }` or `{ steamId, token? }`.

Creates a new, empty [TradeOffer](#tradeoffer) addressed to the partner. **Local only** — nothing is
sent to Steam until you call [`offer.send()`](#send). Chain `.give()` / `.receive()` / `.setMessage()`
to build it.

### getTradeOffer(id)

- `id` — The trade offer's numeric id, as a string.

Fetches a single offer and returns it as a [TradeOffer](#tradeoffer). Item descriptions are inlined
(`get_descriptions=1`), so the offer's items are full [`EconItem`](#econitem)s. Rejects with a
`SteamError` if the offer doesn't exist.

### getOffers(\[filter]\[, historicalCutoff])

- `filter` — Optional. A value from [`EOfferFilter`](#eofferfilter) (default `ActiveOnly`).
- `historicalCutoff` — Optional. A `Date`. When `filter` includes historical offers, only offers updated at or after this time are returned. Defaults to one year in the future (i.e. "active only").

Returns `Promise<{ sent: TradeOffer[]; received: TradeOffer[] }>`. This cursor-paginates **all** pages
internally and inlines descriptions into every offer's items. If Steam returns the wholly-malformed
"data temporarily unavailable" glitch (all offers missing partner/items), this rejects with a
`SteamError` rather than handing back garbage.

### getTradeOffers(\[filter])

- `filter` — Optional. A value from [`EOfferFilter`](#eofferfilter) (default `ActiveOnly`).

A convenience wrapper around `getOffers` that returns the sent and received arrays merged into one
`Promise<TradeOffer[]>`.

### getTradeStatus({tradeId})

- `tradeId` — The **trade id** (not the offer id). This is set on a [TradeOffer](#tradeoffer) once it's accepted (`offer.tradeID`).

Returns settlement details for a completed or escrowed trade as a `Promise<`[`ExchangeDetails`](#exchangedetails)`>`,
including where each item *landed* after the trade (`new_assetid` / `new_contextid`, when Steam provides
them). See [`offer.getTradeStatus()`](#gettradestatus) for the offer-level shortcut.

### getTradeHistory(\[options])

- `options` — Optional [`TradeHistoryOptions`](#tradehistoryoptions):
  - `maxTrades` — Max trades to return (default 100).
  - `startAfterTime` / `startAfterTradeId` — Cursor: the time and id of the last trade from the previous page. Pass both to fetch the next page.
  - `navigatingBack` — Page backwards (toward newer trades) instead of forward.
  - `includeFailed` — Include failed/rolled-back trades.
  - `includeTotal` — Ask Steam for the total trade count (populates `totalTrades`).

Returns past trades, newest first, as a `Promise<`[`TradeHistory`](#tradehistory)`>`. Each entry is a
fully-parsed [`ExchangeDetails`](#exchangedetails) plus its `tradeId` and `partnerSteamId`. To page,
take the last entry's `tradeInitTime`/`tradeId` and pass them as `startAfterTime`/`startAfterTradeId`
while `more` is `true`.

### getTradeOffersSummary()

Returns counts of pending/new/historical sent & received offers (and escrow counts) as a
`Promise<`[`TradeOffersSummary`](#tradeofferssummary)`>`. Cheap; useful as a "do I have anything to
look at?" check before a full `getOffers`.

### reconcile(ids)

- `ids` — An array of trade offer id strings.

Re-reads each id in parallel and returns a `Promise<Map<string, TradeOffer>>` keyed by id. **Missing or
errored ids are skipped**, so one bad id can't fail the whole batch. This is the authoritative,
poll-free way to track offers you've sent: persist the id from `send()`, then reconcile it on demand.

### getOffersContainingItems(items\[]\[, includeInactive])

- `items` — An array of `{ appid, contextid, assetid }` item references.
- `includeInactive` — Optional. If `true`, searches all offers; otherwise active only (default `false`).

Returns the offers that contain **all** of the given items, as a `Promise<TradeOffer[]>`.

### getInventory(target, appid\[, contextid]\[, options])

- `target` — An [`OfferTarget`](#offertarget) identifying whose inventory to load (typically a partner via `{ tradeUrl }`).
- `appid` — The app id (e.g. `730` for CS2, `252490` for Rust).
- `contextid` — Optional. The context id (default `"2"`).
- `options`
  - `tradableOnly` — Optional. If `true`, only tradable items are returned (default `false`).

Loads a **partner's** inventory through the trade-offer page (`/tradeoffer/new/partnerinventory/`),
which is the reliable way to see a partner's items — including trade-protected ones that the public
`/inventory/` endpoint hides. Returns `Promise<`[`EconItem`](#econitem)`[]>`, paginated automatically.
For your *own* inventory, prefer [`bot.community.getInventory`](#getinventoryappid-contextid-options).

### startPolling(\[options])

- `options` — Optional [`PollOptions`](#polloptions):
  - `pollInterval` — Active-poll cadence in ms (default `10000`).
  - `pollFullUpdateInterval` — Full-sweep cadence in ms (default `300000`).
  - `pollData` — A saved [`PollData`](#polldata) snapshot to resume from (so a restart doesn't re-emit known offers).

Starts the poll loop. The library does an **active poll** (recently-changed offers only) on the short
interval and a periodic **full sweep** (all offers, to catch backdated state changes) on the long
interval. State changes are diffed against the last snapshot and surfaced as [events](#trade-events). The
loop never dies on a rate limit — it backs off and resumes. Calling this again replaces the running
loop.

### stopPolling()

Stops the poll loop.

### pollData (getter)

A getter returning the current [`PollData`](#polldata) snapshot, or `undefined` if polling isn't
running. Usually you persist this via the [`pollData` event](#event-polldata) rather than reading it
directly.

### Trade events

`bot.trade` (and `bot`, which re-emits them) emits:

#### Event: newOffer

- `offer` — A [TradeOffer](#tradeoffer) for the newly-received offer.

Emitted when someone sends you a new trade offer.

#### Event: receivedOfferChanged

- `offer` — The [TradeOffer](#tradeoffer) in its new state.
- `oldState` — The previous [`ETradeOfferState`](#etradeofferstate).

Emitted when an offer you received changes state (e.g. you accepted it elsewhere, or it expired).

#### Event: sentOfferChanged

- `offer` — The [TradeOffer](#tradeoffer) in its new state.
- `oldState` — The previous [`ETradeOfferState`](#etradeofferstate).

Emitted when an offer you sent changes state (e.g. the partner accepted or declined it).

#### Event: unknownOfferSent

- `offer` — The [TradeOffer](#tradeoffer).

Emitted when polling sees a sent offer it has no record of — either sent out-of-band (not via this
client) or seen on the first cold poll.

#### Event: pollData

- `data` — The new [`PollData`](#polldata) snapshot.

Emitted whenever the poll snapshot changes. **Persist this** and pass it back as `pollData` on the next
`startPolling` to resume without re-emitting offers you've already handled.

#### Event: pollSuccess

Emitted after each successful poll cycle.

#### Event: pollFailure

- `error` — The `Error` that caused the failed poll.

Emitted when a poll cycle fails. The loop keeps running; this is informational.

#### Event: debug

- `message` — A human-readable debug string.

Verbose internal logging (cursor pages, mint/renewal, backoff). Listen on this while developing.

---

## TradeOffer

Represents a single trade offer — either one you're building to send, or one fetched from Steam. Build
offers with [`bot.trade.createOffer`](#createoffertarget); fetch them with
[`bot.trade.getTradeOffer`](#gettradeofferid) / `getOffers` / `getTradeOffers`.

### Offer properties

- `id` — The offer id (`string`), or `undefined` before it's been sent.
- `partner` — A [`SteamID`](https://github.com/DoctorMcKay/node-steamid) for the other party.
- `token` — The partner's trade-URL token (`string`), if known.
- `message` — The offer message (≤128 chars).
- `state` — The current [`ETradeOfferState`](#etradeofferstate).
- `itemsToGive` — Array of [`TradeItem`](#tradeitem) (full [`EconItem`](#econitem)s on fetched offers) you'd give up.
- `itemsToReceive` — Array of items you'd receive.
- `isOurOffer` — `true` if we sent it, `false` if we received it.
- `tradeID` — The trade id once accepted (`string`), or `undefined`. Needed for [`getTradeStatus()`](#gettradestatus).
- `confirmationMethod` — An [`EConfirmationMethod`](#econfirmationmethod) (`MobileApp`, `Email`, or `None`).
- `escrowEnds` — A `Date` when the escrow hold ends, or `undefined`.
- `created` / `updated` / `expires` — `Date`s, or `undefined`.
- `fromRealTimeTrade` — `true` if this came from a real-time trade session.
- `glitched` — `true` when the offer is missing item names (descriptions not ready) or has no items. Polling won't advance its cutoff past a glitched offer, so it gets re-polled until complete.

### give(items)

- `items` — An array of [`TradeItem`](#tradeitem) (`{ appid, contextid, assetid, amount? }`).

Adds items **you** will give. Chainable (returns the offer). Array-only.

### receive(items)

- `items` — An array of [`TradeItem`](#tradeitem).

Adds items you'll receive from the partner. Chainable.

### setMessage(message)

- `message` — The offer message (truncated to 128 characters).

Sets the message. Chainable. Throws if the offer has already been sent.

### send()

Sends the offer. Before sending it best-effort acknowledges the 2025 trade-protection notice (which
Steam otherwise blocks new offers on). Returns a `Promise` resolving to a **`SendResult`**:

- `"sent"` — The offer is live; `offer.id` and `offer.state` (`Active`) are now set.
- `"needs_confirmation"` — The offer was created but needs a mobile/email confirmation. Call [`confirm()`](#confirm).

Throws a typed [error](#errors) on failure (e.g. `OfferLimitError`, `TradeBanError`,
`SteamSessionExpiredError`). Throws if the offer is empty or already sent.

### accept()

Accepts an offer **you received**. Returns a `Promise` resolving to an **`AcceptResult`**:

- `"accepted"` — Done; items have transferred.
- `"escrow"` — Accepted but held in escrow (`offer.escrowEnds` tells you until when).
- `"needs_confirmation"` — Needs a mobile/email confirmation; call [`confirm()`](#confirm).

Because the accept response doesn't itself flag escrow, this re-reads the offer afterward to tell a
held trade from a settled one (best-effort; falls back to `"accepted"`). Throws if the offer isn't
active, is our own, or on a Steam error.

### cancel()

Cancels an offer you sent (or, for a received offer, declines it) via the community endpoint — the Web
API rejects the mobile token for this. Returns `Promise<void>`. Throws if the offer isn't active /
pending-confirmation.

### decline()

Alias for [`cancel()`](#cancel); use it for readability on received offers.

### confirm()

Accepts the pending mobile confirmation for this offer (after `send()`/`accept()` returned
`"needs_confirmation"`). Requires `identitySecret`. Returns `Promise<void>`. Throws a
`ConfirmationError` if the offer is unsent or no matching confirmation is found.

### counter()

Returns a **new** unsent [TradeOffer](#tradeoffer) to the same partner, pre-filled with this offer's
items and message (deep-copied, so editing the counter won't mutate the original). Edit it and call
`send()`; sending marks the original as countered. Throws if the original isn't active.

### getTradeStatus()

Shortcut for [`bot.trade.getTradeStatus({ tradeId: this.tradeID })`](#gettradestatustradeid). Returns
`Promise<`[`ExchangeDetails`](#exchangedetails)`>`. Throws if the offer has no `tradeID` (i.e. it hasn't
been accepted).

### getPartnerInventory(appid\[, contextid]\[, tradableOnly])

- `appid` — App id.
- `contextid` — Optional context id (default `"2"`).
- `tradableOnly` — Optional. Tradable items only.

Loads the **partner's** inventory, reusing this offer's partner and token. Returns
`Promise<`[`EconItem`](#econitem)`[]>`.

### containsItem(item)

- `item` — `{ appid, contextid, assetid }`.

Returns `true` if either side of the offer contains that exact asset.

---

## bot.community

Account- and profile-level helpers backed by `steamcommunity.com` and a couple of Web API calls.

### getInventory(appid\[, contextid]\[, options])

- `appid` — App id.
- `contextid` — Optional context id (default `"2"`).
- `options`
  - `steamId` — Optional. Whose inventory to load (default: yourself).
  - `tradableOnly` — Optional. Tradable items only.

Loads your own inventory — or any **public** inventory — via the `/inventory/` endpoint. Returns
`Promise<`[`EconItem`](#econitem)`[]>`, paginated automatically. Throws `"This profile is private."` on
a private inventory. For a trade **partner's** inventory, use
[`bot.trade.getInventory`](#getinventorytarget-appid-contextid-options) instead — `/partnerinventory/`
is the only path that reveals trade-protected items.

### checkUser(target)

- `target` — An [`OfferTarget`](#offertarget).

Scrapes the trade page for escrow-hold and probation status (the Web API's `GetTradeHoldDurations`
returns AccessDenied for a mobile token). Returns a `Promise<`[`UserCheck`](#usercheck)`>`. Throws
loudly rather than reporting a misleading `0` if the escrow values can't be parsed.

### getTradeURL()

Returns your current trade URL and token as `Promise<{ url: string; token: string }>`.

### changeTradeURL()

Regenerates (and thereby **invalidates**) your trade URL/token. Returns the new
`Promise<{ url: string; token: string }>`.

### getProfile(\[steamId])

- `steamId` — Optional. Whose profile to read (default: yourself).

Reads a profile summary from the community XML in a **single request**. Returns a
`Promise<`[`SteamProfile`](#steamprofile)`>` with persona, avatar, account-creation date, trade-ban
state, VAC status, privacy state, and the `isLimited` flag. (Steam level isn't in the XML — use
`getSteamLevel`.)

### getSteamLevel(\[steamId])

- `steamId` — Optional (default: yourself).

Returns the account's Steam level as a `Promise<number>` via `IPlayerService/GetSteamLevel` (which
accepts the access token — no API key required).

### community.ensureApiKey(\[domain])

- `domain` — Optional hostname for the key (default `"assetpay.gg"`).

Returns the existing Web API key, or registers a new one (auto-accepting the mobile confirmation if
`identitySecret` is set), as `Promise<string | null>`. Resolves to `null` when the account is
ineligible (unverified email, no authenticator, or limited). The registration flow handles Steam's
Pending → confirm → retry handshake for you.

### acknowledgeTradeProtection()

Acknowledges the 2025 trade-protection notice. Called automatically by [`send()`](#send); exposed here
for completeness. Returns `Promise<void>`.

---

## bot.session

The `SessionManager` owns the token lifecycle. You rarely call it directly — the namespaces refresh the
access token for you — but it's where session control lives.

### getAccessToken()

Returns a valid access token, minting or renewing it if needed, as `Promise<string>`. Concurrent calls
share one in-flight mint. Throws `SteamSessionExpiredError` if the session has been revoked or the
refresh token is dead.

### listSessions()

Returns the client ids of in-progress auth sessions (login-approval flows) as `Promise<bigint[]>`.
Note: this is **not** a list of logged-in devices — it reflects pending `IAuthenticationService`
sessions.

### logout(\[action])

- `action` — Optional [`EAuthTokenRevokeAction`](#eauthtokenrevokeaction) (default `Logout`).

Revokes this refresh token server-side. Afterward the session is dead and any further call throws
`SteamSessionExpiredError`. Returns `Promise<void>`.

### Properties & events

- `refreshToken` / `accessToken` / `steamID` — Same values surfaced on [`SteamMobile`](#properties).
- Events: `refreshToken`, `sessionExpired`, `debug` — re-emitted on the root client.

---

## bot.confirmations

The low-level `ConfirmationManager` for mobile confirmations. **Prefer [`offer.confirm()`](#confirm)**
for trades — these are for advanced cases (market listings, manual flows). All require `identitySecret`.

### getConfirmations(time, key)

- `time` — A Unix timestamp (use the manager's server-time-corrected clock).
- `key` — A confirmation key, or `{ tag, key }`.

Returns the outstanding confirmations as `Promise<`[`Confirmation`](#confirmation)`[]>`.

### respondToConfirmation(confID, confKey, time, key, accept)

- `confID` — The confirmation id.
- `confKey` — The confirmation's nonce.
- `time` — A Unix timestamp.
- `key` — A confirmation key, or `{ tag, key }`.
- `accept` — `true` to allow, `false` to cancel.

Accepts or rejects a single confirmation. Returns `Promise<void>`.

### acceptConfirmationForObject(objectID)

- `objectID` — The id of the object the confirmation is for (e.g. a trade offer id, or an API-key request id).

Finds and accepts the confirmation tied to that object, handling the time-offset and per-request HMAC
timestamps for you. Returns `Promise<void>`. Throws a `ConfirmationError` if no matching confirmation
exists.

---

## Data types

### OfferTarget

Identifies a trade partner. It's a discriminated union — supply **one** of the two shapes:

```ts
type OfferTarget =
  | { tradeUrl: string }            // a full trade URL (partner + token parsed out)
  | { steamId: string; token?: string };  // a SteamID64, optionally with a trade token
```

### TradeItem

The minimal shape needed to put an item into an offer:

```ts
interface TradeItem {
  appid: number;
  contextid: string;
  assetid: string;
  amount?: number; // default 1
}
```

### EconItem

The fully-typed item, with Steam's fields preserved 1:1 (snake_case, lossless). Returned by every
inventory and offer read. Key fields:

- `appid` (number), `contextid`, `assetid`, `classid`, `instanceid`, `amount`, `currencyid?`
- `name`, `market_name`, `market_hash_name`, `type`, `name_color?`, `background_color?`
- `icon_url`, `icon_url_large?`
- `tradable`, `marketable`, `commodity` (booleans), `market_tradable_restriction`, `market_marketable_restriction` (numbers)
- `descriptions`, `owner_descriptions` ([`SteamDescriptionLine`](#data-types)[]), `actions`, `market_actions` (`SteamAction[]`), `fraudwarnings` (string[]), `tags` (`SteamTag[]`)
- `asset_properties` ([`AssetProperty`](#data-types)[]) — CS2 float/seed/sticker data when present
- Any other field Steam returns is preserved (`[key: string]: unknown`).

### ExchangeItem

An [`EconItem`](#econitem) plus where it landed after the trade settled:

```ts
interface ExchangeItem extends EconItem {
  new_assetid?: string;        // Rust populates these; CS2 usually omits them
  new_contextid?: string;
  rollback_new_assetid?: string;
  rollback_new_contextid?: string;
}
```

### ExchangeDetails

Returned by [`getTradeStatus`](#gettradestatustradeid):

```ts
interface ExchangeDetails {
  status: ETradeStatus;
  tradeInitTime: Date;
  settlementTime: Date | null;   // when items were actually delivered
  receivedItems: ExchangeItem[];
  sentItems: ExchangeItem[];
  usedInventoryFallback: boolean; // always false — surfacing new_assetid is enough; reconciling by inventory diff is the server's job
}
```

### TradeHistory

Returned by [`getTradeHistory`](#gettradehistoryoptions):

```ts
interface TradeHistory {
  trades: TradeHistoryEntry[];   // newest first
  more: boolean;                 // are there more pages?
  totalTrades: number | undefined; // only when includeTotal was set
}

interface TradeHistoryEntry extends ExchangeDetails {
  tradeId: string;
  partnerSteamId: string | undefined;
}
```

### TradeHistoryOptions

See [`getTradeHistory`](#gettradehistoryoptions) for field meanings: `maxTrades?`, `startAfterTime?`,
`startAfterTradeId?`, `navigatingBack?`, `includeFailed?`, `includeTotal?`.

### TradeOffersSummary

Returned by [`getTradeOffersSummary`](#gettradeofferssummary) — all `number`:

`pending_received_count`, `new_received_count`, `updated_received_count`, `historical_received_count`,
`pending_sent_count`, `newly_accepted_sent_count`, `updated_sent_count`, `historical_sent_count`,
`escrow_received_count`, `escrow_sent_count`.

### SteamProfile

Returned by [`getProfile`](#getprofilesteamid):

```ts
interface SteamProfile {
  steamId: string;
  personaName: string;
  avatar: string;
  accountCreated: Date | null;
  tradeBanState: string;   // e.g. "None"
  isLimited: boolean;
  vacBanned: boolean;
  privacyState: string;    // e.g. "public"
}
```

### UserCheck

Returned by [`checkUser`](#checkusertarget):

```ts
interface UserCheck {
  escrowDays: number;       // max of the two sides
  myEscrowDays: number;
  theirEscrowDays: number;
  probation: boolean;
  contexts: Record<string, unknown> | null;
}
```

### PollData

The poll snapshot — persist it via the [`pollData` event](#event-polldata) and pass it back to
[`startPolling`](#startpollingoptions):

```ts
interface PollData {
  offersSince: number;                          // Unix seconds of the newest processed update
  sent: Record<string, ETradeOfferState>;       // offer id -> last seen state
  received: Record<string, ETradeOfferState>;
  timestamps: Record<string, number>;
}
```

### PollOptions

See [`startPolling`](#startpollingoptions): `pollInterval?` (default 10000 ms), `pollFullUpdateInterval?`
(default 300000 ms), `pollData?`.

### Confirmation

Returned by [`getConfirmations`](#getconfirmationstime-key): `id`, `type`, `creator`, `key` (nonce),
`title`, `receiving`, `sending`, `time` (ISO string), `timestamp` (`Date`), `icon`.

---

## Enums

All are exported and have the standard Steam numeric values.

### ETradeOfferState

`Invalid (1)`, `Active (2)`, `Accepted (3)`, `Countered (4)`, `Expired (5)`, `Canceled (6)`,
`Declined (7)`, `InvalidItems (8)`, `CreatedNeedsConfirmation (9)`, `CanceledBySecondFactor (10)`,
`InEscrow (11)`, `Reverted (12)`.

### ETradeStatus

`Init (0)`, `PreCommitted (1)`, `Committed (2)`, `Complete (3)`, `Failed (4)`,
`PartialSupportRollback (5)`, `FullSupportRollback (6)`, `SupportRollback_Selective (7)`,
`RollbackFailed (8)`, `RollbackAbandoned (9)`, `InEscrow (10)`, `EscrowRollback (11)`, `Reverted (12)`.

### EConfirmationMethod

`None (0)`, `Email (1)`, `MobileApp (2)`.

### EConfirmationType

`Invalid (0)`, `Generic (1)`, `Trade (2)`, `MarketListing (3)`, `FeatureOptOut (4)`,
`PhoneNumberChange (5)`, `AccountRecovery (6)`.

### EOfferFilter

`ActiveOnly (1)`, `HistoricalOnly (2)`, `All (3)`.

### EAuthSessionGuardType

`Unknown (0)`, `None (1)`, `EmailCode (2)`, `DeviceCode (3)`, `DeviceConfirmation (4)`,
`EmailConfirmation (5)`, `MachineToken (6)`, `LegacyMachineAuth (7)`.

### EAuthTokenRevokeAction

`Logout (0)`, `Permanent (1)`, `Replaced (2)`, `Support (3)`, `Consume (4)`, `NonRememberedLogout (5)`,
`NonRememberedPermanent (6)`, `Automatic (7)`. Used by [`bot.session.logout`](#logoutaction).

### Others

`EAuthTokenPlatformType`, `ESessionPersistence`, `ETokenRenewalType`, and the full `EResult` table are
also exported.

---

## Errors

Every error extends **`SteamError`**, which carries an optional `eresult` (a Steam `EResult`) and `body`
(the raw response). The library **classifies** errors but does not implement a cooldown policy — retry
logic stays in your code.

| Class | Extra fields | Meaning |
| ----- | ------------ | ------- |
| `SteamError` | `eresult?`, `body?` | Base class for everything. |
| `HttpStatusError` | `statusCode` | A non-2xx HTTP response. |
| `SteamSessionExpiredError` | — | The session/token is no longer valid; re-authenticate. |
| `RateLimitError` | `statusCode?`, `retryAfterMs?`, `unlockAt?` | Rate limited (HTTP 429 or eresult 84). `unlockAt` is a millisecond epoch when you may retry. |
| `EscrowError` | `escrowDays` | The trade would be (or is) held in escrow. |
| `TradeBanError` | — | The account is trade-banned. |
| `OfferLimitError` | `eresult = 25` | Sent too many offers. |
| `ConfirmationError` | — | A mobile-confirmation step failed. |
| `FamilyViewError` | — | Family View is restricting the account. |
| `LoginError` | `extendedErrorMessage?` | Credential-login failure; carries Steam's extended message when present. |

```ts
import { RateLimitError } from "steam-mobile";

try {
  await bot.trade.getTradeOffers();
} catch (err) {
  if (err instanceof RateLimitError && err.unlockAt) {
    await sleepUntil(err.unlockAt);
  } else throw err;
}
```

---

## Mobile-app impersonation

The client presents as the Steam mobile app on the wire: per-host user agents, the `mobileClient`
cookie, an `origin=SteamMobile` header on writes, and `mobileconf` confirmations. Pick a preset with
`mobileProfile: "ios"` (default) or `"android"`, or override individual fields with an object.

A **`MobileProfile`** has: `mobileClient` (`"ios"` | `"android"`), `mobileClientVersion`,
`apiUserAgent`, `webUserAgent`, `deviceFriendlyName` (iOS sends the model id, e.g. `"iPhone18,3"`),
`osType` (signed EOSType; iOS `-600`, Android `-500`), `gamingDeviceType`, and `appType?`. The
`IOS_PROFILE` and `ANDROID_PROFILE` constants (captured from real apps) and `resolveMobileProfile` are
exported if you want to build on them.

```ts
const bot = new SteamMobile({
  refreshToken,
  mobileProfile: { mobileClient: "ios", deviceFriendlyName: "iPhone17,2" },
});
```

---

## Notes & limitations

- **MobileApp-only.** No real-time CM push — offer detection is polling. No Game Coordinator (item data
  comes from the web `asset_properties`). No chat/presence.
- **Limited accounts** can't send trades, use the market, or get a Web API key. The library surfaces
  this clearly: `getProfile().isLimited`, `ensureApiKey()` → `null`, and a typed eligibility error on
  trade-page features.
- **English only** (`l=english`) by design — no localization dependency.
- **Settlement is read-only.** `getTradeStatus` surfaces Steam's `new_assetid`/`new_contextid`;
  reconciling items by inventory diff (the race-prone part) is left to your server, which has the
  concurrency context. `usedInventoryFallback` is therefore always `false`.
- **No auto-retry.** Rate limits are thrown as `RateLimitError` (the poll loop is the one exception — it
  backs off and resumes). The caller owns retry policy.

---

## Development

```bash
pnpm install
pnpm typecheck   # tsc --noEmit (strict NodeNext)
pnpm lint        # biome
pnpm test        # vitest
pnpm build       # tsdown → dist (ESM + d.ts)
pnpm proto       # regenerate src/protobufs from protobufs/*.proto (buf + protoc-gen-es)
```

Live debug scripts live in `debug/` and read a `.env` for credentials:

```bash
pnpm bootstrap   # credential login → save ./bot.refreshtoken (run once)
pnpm smoke       # read-only health check across the whole API
pnpm watch       # live trade-event watcher — send the bot a trade and watch it fire
pnpm trade       # send → confirm → cancel lifecycle (gated: SEND=1 PARTNER_TRADE_URL=…; needs a non-limited bot)
```
