# @assetpay/steam-mobile — Project Context & Handoff

> **Read this first.** This file is the source of truth for the project's goals and decisions.
> Project memory was keyed to the old folder path (`...-steam-trade`) and will NOT auto-load
> after the folder is renamed to `steam-mobile` — so everything important lives here.

---

## What this is
A new, standalone, modern, fully-typed **ESM TypeScript** library: a **headless Steam *Mobile
app* client** for trading. It unifies the *web* logic of DoctorMcKay's `steamcommunity` +
`steam-tradeoffer-manager` into one cohesive package, with **no `steam-user` / no CM binary
protocol**. Auth is delegated to `steam-session` + `steam-totp` (kept as dependencies).

- **Package name:** `@assetpay/steam-mobile` (scoped/private).
- **Why "steam-mobile":** it impersonates the Steam mobile app (MobileApp-platform auth,
  `mobileconf` confirmations, `[web,mobile]` token). Named after the client it emulates, the
  same way `steam-user` is named for the CM/desktop client. Pairs with `steam-session`.
- **`assetpay-api` is reference-only.** Its `src/modules/steam/**` is good for *ideas and
  pitfalls*, NOT code to copy, and NOT a coupling target. The lib is framework-agnostic
  (no NestJS / Prisma / BullMQ).

## Current status
- Decisions locked (below). No library code written yet.
- Tooling set up: **pnpm** (v11), ESM, `tsx` for running TS. Build scripts decided in
  `pnpm-workspace.yaml` (`esbuild: true` — needed by tsx; `protobufjs: false` — its postinstall
  is non-essential; protobufjs is a transitive *runtime* dep via steam-session).
- Probe scripts present (throwaway, but useful references):
  - `login-mobile.ts` — MobileApp login + surface probe (`pnpm login:mobile`)
  - `probe-capabilities.ts` — full capability sweep (`pnpm probe`)
- **Next step: M1 (session layer).** See Milestones.

---

## Locked decisions
1. **No `steam-user`, no CM.** Pure HTTPS. Offer detection = timer-based polling of
   `IEconService/GetTradeOffers` (we accept losing the CM's ~few-seconds-faster trigger).
2. **Platform = `EAuthTokenPlatformType.MobileApp`** (NOT SteamClient, NOT WebBrowser). See
   "Platform decision" for the evidence. SteamClient is fully dropped.
3. **Depend on `steam-session` (auth/session) + `steam-totp` (codes/confirmation keys).** Do
   NOT reimplement them — credential login = RSA + protobuf `IAuthenticationService`, the
   genuinely hard part. The lib "works with" steam-session; it is not standalone for auth.
4. **HTTP stack:** `got` + `proxy-agent` (unified auto-detect http/https/socks) + `tough-cookie`.
   ESM-only, Node 20+. Must set `throwHttpErrors:false`, `retry:{limit:0}`, `decompress:true`.
   Reuse the forks' Steam error/redirect/`sessionExpired` checkers near-verbatim (they're
   client-agnostic — operate on status/headers/body).
5. **Items 100% web-sourced** (no Game Coordinator, no float API). `EconItem` exposes CS2/Rust
   props from the web API: `asset_properties` (1=paint_seed, 2=float_value, 3=charm_template,
   5=nametag, 6=item_certificate, 7=finish_catalog) and `asset_accessories` (stickers/keychains,
   `sticker_wear` from parent_relationship_properties pid 4).
6. **API = domain namespaces** on a thin session-owning root (see "API design").
7. **Confirmations are EXPLICIT only** — never a background auto-accepter.
8. **All async Promise-native; typed errors + typed events.** drmckay's `(err, result)`
   callback style is explicitly replaced.

---

## Platform decision (MobileApp) — the evidence
Probed all three `EAuthTokenPlatformType`s with the test account. Findings:

| | refresh `aud` | access `aud` | refresh life | access life | getWebCookies | refreshAccessToken |
|---|---|---|---|---|---|---|
| SteamClient | client,web,renew,derive | client,web | ~211d | ~24h | OK (uses initial token) | ❌ AccessDenied (needs CM) |
| WebBrowser | web,renew,derive | web | ~211d | ~24h | OK (16 per-subdomain cookies) | ❌ AccessDenied |
| **MobileApp** | web,renew,derive,mobile | web,mobile | ~211d | ~24h | OK (2 cookies) | ✅ **only one that works** |

- **Token lifetimes are identical** across platforms — the "mobile is more stable" rumor is NOT
  about expiry.
- **Decisive:** `refreshAccessToken()` / `renewRefreshToken()` work **only on MobileApp** over
  HTTP (per steam-session source `LoginSession.js:785-788`; SteamClient needs a CM session,
  WebBrowser can't at all). A long-running bot must roll its ~24h access token (and renew the
  ~211d refresh token) without re-doing a credentials login → MobileApp is the only platform
  that can self-renew on pure HTTP.
- **Simpler cookie model:** MobileApp returns one self-describing cookie
  `steamLoginSecure=steamid||accessToken`; refresh = rebuild it from the renewed access token.
  WebBrowser needs per-subdomain finalizelogin+transfer cookies (domain-aware jar required).
- **What we lose by skipping the client token: nothing trade-relevant.** The `client` audience
  only unlocks CM/GC/chat/presence/machine-auth — the steam-user surface we dropped.

## MobileApp capability map (from `probe-capabilities.ts` + `test-iecon.ts`)
**✅ Works with the mobile access token (LIVE-TESTED):** `GetTradeOffers`, `GetTradeOffer`,
`GetTradeOffersSummary`, `GetTradeHistory`, `GetTradeStatus`; inventory (own/partner);
confirmations (`mobileconf`); profile/persona/avatar via community profile XML (`?xml=1`); Steam
level + owned games via `IPlayerService` (token accepted).

**❌ Rejects the mobile token — must use a workaround (LIVE-TESTED `test-iecon.ts`):**
- `GetTradeHoldDurations` → **eresult=15 AccessDenied**. (The old probe wrongly marked this
  "works" — it only checked HTTP 200 and missed the eresult in the body.) → **escrow/probation
  come from the community trade-page scrape (`getUserDetails`-style), NOT the API.**
- `CancelTradeOffer` / `DeclineTradeOffer` → **HTTP 404 (HTML) on every request shape** — not
  served for our token. → **cancel/decline use the community POST `/tradeoffer/{id}/cancel`.**
- `ISteamUser/GetPlayerSummaries` → wants a Web API *key*. → profile from community XML +
  `IPlayerService`. Optional `ensureApiKey()` self-registers a key on eligible accounts.

**⚠️ Account-state, not platform:** trade-URL token + API-key registration were blocked because
the *test* account is limited/fresh (market-ineligible). They work on a provisioned ($5-spent,
verified) bot account.

**🚫 Impossible without the CM (by design):** real-time offer push (we poll), Game Coordinator
(we read float/stickers from web `asset_properties`), chat, presence, idling, machine-token
Steam Guard. None are trade-relevant.

> **Untested:** full live send → mobile-confirm → partner accepts → `getExchangeDetails`
> (new_assetid read). Needs a NON-limited bot account with items + a trade partner.

---

## API design

Thin root client owns the shared plumbing (one MobileApp session, one cookie jar, one got
instance, one access token, one confirmation engine). Capabilities hang off as namespaces:

```
bot (session)        → login, shutdown, steamID, accessToken, ensureApiKey, session events
├── bot.trade.*      → offers, inventory, confirmations, escrow check, exchange details, poll+events
└── bot.community.*  → profile/persona, trade URL get/change
   (bot.market.* reserved — NOT built; market + wallet + Money out of current scope)
```

### Construction & session (root)
```ts
SteamTradeClient.login(opts): Promise<Client>   // opts: refreshToken OR {accountName,password,sharedSecret};
                                                //       identitySecret, proxy, language, poll, autoConfirm?
bot.steamID; bot.accessToken
bot.ensureApiKey(): Promise<string|null>        // self-register/fetch; null if account ineligible
bot.refreshSession(): Promise<void>             // normally automatic
bot.shutdown(): Promise<void>
bot.on("refreshToken" | "sessionExpired" | "sessionRefreshed" | "debug", …)
```
Session **self-maintains**: refresh ~24h access token before expiry; renew ~211d refresh token
near end-of-life (emit `refreshToken` so caller persists — the OLD token is invalidated on
renew); rebuild the `steamid||token` cookie. This replaces the old webSession/webLogOn/
sessionExpired dance entirely.

### bot.trade
```ts
bot.trade.getMyInventory(appid, contextid?, tradableOnly?): Promise<EconItem[]>   // contextid defaults per app (CS2→2, Rust→2, TF2→2, Steam→6); tradableOnly default true
bot.trade.getPartnerInventory(steamIdOrUrl, appid, contextid?, tradableOnly?): Promise<EconItem[]>
bot.trade.createOffer(partnerOrUrl, token?): TradeOffer
bot.trade.getOffer(id); bot.trade.getOffers(filter?)
bot.trade.checkUser(partnerOrUrl): Promise<{ escrowDays, probation, contexts }>   // pre-send validation
bot.trade.confirm(offerId): Promise<void>
bot.trade.getExchangeDetails({ offerId, tradeId, partner }): Promise<ExchangeDetails>
bot.trade.on("sentOfferChanged" | "receivedOfferChanged" | "newOffer", …)

// TradeOffer (fluent): addMyItems/addTheirItems/setMessage,
//   send({autoConfirm?}) -> "pending" | "confirmed",
//   accept(), cancel(), decline(), confirm(), getExchangeDetails()
```

### bot.community
```ts
bot.community.getProfile(steamID?): Promise<{ personaName, avatar, steamLevel, accountCreated }>  // XML + IPlayerService (NOT GetPlayerSummaries)
bot.community.getTradeURL(): Promise<{ url, token }>
bot.community.changeTradeURL(): Promise<{ url, token }>
```

### Confirmations — explicit only
- `bot.trade.confirm(offerId)` / `offer.confirm()` — confirm a specific offer.
- `offer.send({ autoConfirm: true })` — send then immediately confirm that one offer.
- Optional client default `login({ autoConfirm: true })` (default false).
- **No background poller that silently approves things.** Uses the client's `identitySecret`.
- (Internally: trade + market confirmations share one `mobileconf` engine — relevant once
  market is built; `EConfirmationType.Trade=2`, `MarketListing=3`.)

### ExchangeDetails (settlement)
```ts
interface ExchangeDetails {
  status: ETradeStatus; tradeInitTime: Date;
  receivedItems: ExchangeAsset[];   // new_assetid/new_contextid (Rust populates; CS2 often omits)
  sentItems: ExchangeAsset[];
  usedInventoryFallback: boolean;   // true when new_assetid absent → diff bot inventory
}
```
First-class replacement for the old `new TradeOffer(...)` + manual id/tradeID hack.

### EconItem (one item type everywhere)
`appid, contextid, assetid, classid, instanceid, amount, market_hash_name, tradable, marketable`
+ CS2/Rust: `float_value, paint_seed, paint_index, pattern, nametag, stickers[], keychains[]`.

### Open API questions (not yet decided)
- Main class name (working name `SteamTradeClient`; could be `SteamMobile`, `Bot`, etc.).
- Single `login()` (auto-detect refreshToken vs credentials) vs two factories — leaning single.
- Keep optional `cancelTime` auto-cancel of stale outgoing offers? (default off.)

---

## Reference sources (logic to port — TS already)
These are bekesibeni's TS forks (already ported from drmckay). Use as the porting reference;
the canonical copies are on GitHub, local copies under assetpay-api/node_modules:
- **steamcommunity** (`github:bekesibeni/node-steamcommunity`):
  `C:/Users/GamerBady/Desktop/csfarm/assetpay/assetpay-api/node_modules/steamcommunity/src`
  - `components/http.ts` — HTTP adapter (`_performHttpRequest` 9-91) + **reusable** error
    checkers (`_checkHttpError`/`_checkCommunityError`/`_checkTradeError`/`_notifySessionExpired`
    217-299).
  - `SteamCommunity.ts` 84-168 — client/cookie/proxy construction + setCookies.
  - `components/confirmations.ts` — mobileconf TOTP flow (request builder 28-64; getlist 68+).
  - `classes/CEconItem.ts` — inventory item shape.
- **steam-tradeoffer-manager** (`github:bekesibeni/node-steam-tradeoffer-manager`):
  `.../assetpay-api/node_modules/steam-tradeoffer-manager/src`
  - `classes/TradeOffer.ts` — offer model; `getExchangeDetails` 661-712 (reads `assets_received`
    from IEconService/GetTradeStatus); `getUserDetails` 714+; send/accept/etc. Public ctor,
    public id/tradeID.
  - `classes/EconItem.ts` — item model w/ asset_properties (pids 1/2/3/5/6/7) + asset_accessories.
  - `components/polling.ts` 18-219 — poll loop + `sentOfferChanged`/`receivedOfferChanged`/
    `newOffer` (DROP the steam-user trigger at TradeOfferManager.ts:167-169).
  - `components/webapi.ts` `_apiCall` 19-105 — routes ALL calls through `_community.httpRequest`
    (one shared HTTP layer); x-eresult handling incl. fake-Fail(2) workaround.
  - `components/offers.ts`, `components/assets.ts` (descriptions via ISteamEconomy/
    GetAssetClassInfo), `resources/*` enums.
- **steam-session** source (for the auth/session model):
  `.../assetpay-api/node_modules/steam-session/dist/LoginSession.js` — `getWebCookies` 663+,
  `refreshAccessToken` 790, `renewRefreshToken` 809.
- **assetpay-api reference (ideas only):** `src/modules/steam/bot/{steam-session,bot-boot,
  bot-lifecycle}.ts`, `auth/steam-auth.service.ts`, `queues/handlers/reconcile-asset-ids.handler.ts`.

---

## Tooling
- ESM (`"type":"module"`), Node 20+ (dev currently on Node 25). pnpm v11.
- `pnpm-workspace.yaml` approves builds: `esbuild: true`, `protobufjs: false`.
- Runtime deps (planned): `steam-session`, `steam-totp`, `steamid`, `got`, `proxy-agent`,
  `tough-cookie`, `node-html-parser` (confirmations/HTML parsing). Dev: `typescript`, `tsup`
  (build), `tsx` (run), `vitest`, `@biomejs/biome`, `@types/node`.
- Profile/persona via community XML — needs an XML parser or regex; `node-html-parser` or
  `fast-xml-parser` (decide in M6).

## Milestones
- **M1** Scaffold (src/, tsconfig strict NodeNext, biome, tsup, vitest) + `http/HttpClient`
  (got+proxy-agent+tough-cookie) + reused error checkers + typed error hierarchy +
  `session/SessionManager` (MobileApp login both paths; build `steamid||token` cookie;
  auto-renew via refreshAccessToken / renewRefreshToken).
- **M2** `models/EconItem` (asset_properties/accessories) + inventory (own + partner).
- **M3** `models/TradeOffer` + send (trade-protection ack retry) / accept / cancel; `_apiCall`
  (shared HTTP); confirmations (explicit); `checkUser` (escrow/probation).
- **M4** Poll loop + typed events (timer-only; no steam-user trigger). pollData persistence
  optional.
- **M5** First-class `getExchangeDetails` (GetTradeStatus + inventory-diff fallback;
  `usedInventoryFallback`); surface `tradeID` on accept events.
- **M6** Account basics: trade URL get/change, web API key get/create (+ `ensureApiKey`),
  profile read (XML + IPlayerService).

## Typed error hierarchy (M1)
`SteamError`(eresult/cause/body) → `HttpStatusError`, `SteamSessionExpiredError`,
`RateLimitError`(eresult 84), `OfferLimitError`, `EscrowError`(escrowDays), `TradeBanError`,
`TradeOfferError`, `ConfirmationError`, `FamilyViewError`. Ship a `classifyRateLimit` util but
keep cooldown *durations* in the consumer (policy).

---

## Inventory loading (IMPORTANT — two different paths)
Steam exposes two ways to read an inventory, and they are NOT interchangeable:

1. **Own inventory → `steamcommunity.com/inventory/{steamid}/{appid}/{contextid}`.** Fine for
   our own bot. Paginates via `count` (≤1000–2000/page) + `start_assetid`/`last_assetid`.
   Limitation: it does NOT reliably load large/other-user inventories and is the **strictest
   rate-limited endpoint (per-IP 429s come from here first)**.
2. **Partner inventory → load via the TRADE URL by initiating a trade offer.** We open the
   trade-offer page first (`/tradeoffer/new/?partner=<accountid>&token=<token>`) to "prime"
   the session, then page `/tradeoffer/new/partnerinventory/` (`more`/`more_start`), merging
   `rgDescriptions` + `rgAssetProperties`. This is the path that actually loads partner items
   for trading; plain `/inventory` is unreliable for partners. (Quirk confirmed in both the
   fork and DoctorMcKay original: `/partnerinventory/` only authorizes AFTER the trade page is
   visited; secure sessionid required.)

**Simplification plan:** the lib hides ALL of this behind one function. The caller passes a
trade URL (or steamId+token) and the lib does prime → paginate → merge → return `EconItem[]`:
```ts
bot.trade.getPartnerInventory({ tradeUrl } | { steamId, token }, appid, contextid?, tradableOnly?)
bot.trade.getMyInventory(appid, contextid?, tradableOnly?)   // uses /inventory directly
```
No manual trade-page prime, no pagination loop, no descriptions merge in caller code.

## Endpoint hot-paths & rate limits (see `ratelimit-test.ts`)
Endpoints hit repeatedly in normal operation, by host (hosts have SEPARATE per-IP limits):
- **api.steampowered.com** (token): `IEconService/GetTradeOffers` (poll: every ~30s incremental
  + every ~2min FULL sweep, cursor-paginated = many calls), `GetTradeOffer` (per-ID reconcile),
  `GetTradeStatus` (per completed trade).
- **steamcommunity.com** (cookie): `/inventory/...` (STRICTEST — partner inventory via trade
  page), `/mobileconf/getlist` (per confirm), `/tradeoffer/new/send` + `/tradeoffer/{id}/accept`.
Run `pnpm ratelimit` to measure the limit + reset window per endpoint. Limits are PER-IP →
test through the same proxy the bot uses.

## Security note
The test account creds (username/password/shared_secret/identity_secret) and full refresh
tokens were shared in the originating chat. The refresh tokens are valid ~211 days. **Revoke
them** (Steam → Account → Deauthorize all devices) and consider rotating the secrets if the
account matters.

## Folder rename (why this file exists)
The folder is being renamed `steam-trade` → `steam-mobile`. It had to be done outside the
session because Claude Code held the dir open. After reopening Claude Code in `steam-mobile`,
this file carries the context (project memory was keyed to the old path).
