# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`steam-mobile` is a headless, fully-typed **ESM TypeScript** client for the **Steam mobile app**, built
for trading. It unifies the *web* logic of DoctorMcKay's `steamcommunity` + `steam-tradeoffer-manager`
into one package — **no `steam-user`, no Steam CM binary protocol**. It impersonates the Steam MobileApp
platform on the wire (MobileApp access token, per-host user agents, mobile cookies, `mobileconf`
confirmations). MobileApp is the only platform whose access token self-renews over plain HTTP, which is
what makes a headless web-only client possible. Credential login, TOTP, RSA, and the
`IAuthenticationService` protobufs are all in-package; the only runtime deps are `got`, `proxy-agent`,
`tough-cookie`, `steamid`, and `@bufbuild/protobuf`.

## Commands

```bash
pnpm install                       # pnpm 11, Node 22+
pnpm typecheck                     # tsc --noEmit (strict NodeNext)
pnpm lint                          # biome check src test
pnpm lint:fix                      # biome check --write (run after edits; fixes import order + wrapping)
pnpm test                          # vitest run (all tests)
pnpm exec vitest run test/exchange.test.ts        # a single test file
pnpm exec vitest run test/exchange.test.ts -t "name"   # a single test by name
pnpm build                         # tsdown → dist (ESM + .d.ts)
pnpm proto                         # regenerate src/protobufs from protobufs/*.proto (buf + protoc-gen-es)
```

Standard gate before considering work done: `pnpm typecheck && pnpm lint && pnpm test`.

## Architecture

The codebase is layered bottom-up; each layer has one job and is independently testable.

**Transport (`src/http/`)** — `HttpClient` wraps `got` + `proxy-agent` + `tough-cookie` with
`throwHttpErrors: false` (callers inspect `statusCode` themselves), adds an `origin=SteamMobile` header
on non-GET requests, and follows the `/market/eligibilitycheck/` interstitial once-and-retries (it is a
server-side priming redirect, NOT a "limited account" signal). `webApi.ts` (`WebApiClient`) is the JSON
Web-API caller (`access_token` in query, `x-eresult` parsing, the fake-`Fail(2)`-with-body tolerance).
`checkers.ts` maps HTTP/eresult conditions to the typed error hierarchy.

**Protobuf transport (`src/session/protoTransport.ts`, `src/auth/AuthClient.ts`)** — the symmetric
sibling to `webApi.ts` for `input_protobuf_encoded` calls. Wire format mirrors the real iOS app exactly:
**GET** for read methods (rsaKey, getSessions) with `input_protobuf_encoded` + `origin=SteamMobile` in
the query; **POST multipart** for writes (begin/poll/guard/mint/revoke); `input_protobuf_encoded` must
be present even when empty (else Steam returns JSON). `AuthClient` is the typed wrapper over every
`IAuthenticationService` method used.

**Session / auth (`src/session/`, `src/auth/`)** — `SessionManager` (= `bot.session`) owns the token
lifecycle: lazy access-token mint/renew, refresh-token rotation (emits `refreshToken`), the
`steamLoginSecure` cookie, `listSessions()`, `logout()`. Pre-auth credential login lives in `src/auth/`
(`loginWithCredentials` → `CredentialSession` state machine → `AuthClient`), and is standalone (not on
`SteamMobile`) so it can produce a refresh token before a client exists.

**Root + namespaces** — `SteamMobile` (`src/SteamMobile.ts`) constructs everything and re-emits all
trade events on the root. **Construction is synchronous** (no network; `steamID` comes from the
refresh-token JWT); `await bot.login()` is the only network step (mints the token, applies the cookie,
auto-starts polling if configured). The two namespaces:
- `bot.trade` (`src/trade/`) — `TradeNamespace` (an EventEmitter) + `TradeOffer` (fluent
  give/receive/send/accept/cancel/confirm/counter). `polling.ts` is the faithful McKay poll loop
  (active poll + periodic full sweep, glitched-offer cutoff blocking, diff vs persisted `pollData`).
  `exchange.ts` is settlement reads (`getTradeStatus`/`getTradeHistory`/`getTradeOffersSummary`).
- `bot.community` (`src/community/`) — `CommunityNamespace` (inventory, profile, trade URLs, escrow
  scrape, API key) + `confirmations.ts` (`ConfirmationManager`: mobileconf engine, `m=react`, time
  offset, per-request HMAC timestamp dedup).

**Shared (`src/core/`)** — `enums.ts`, `errors.ts` (everything extends `SteamError`), `types.ts` (raw
Steam JSON shapes), `constants.ts` (endpoints, renewal thresholds), `rateLimits.ts`, `paginate.ts`,
`target.ts` (`OfferTarget` resolution), `mobileProfile.ts` (iOS/Android wire profiles).
`src/models/EconItem.ts` is the single item model + `buildItem`/`buildDescriptionMap` helpers.
`src/crypto/` is vendored steam-totp + RSA (replaced the `steam-totp` dependency).

## Conventions (load-bearing — violating these breaks behavior)

- **Port, don't reinvent.** Before writing any function, read the original in `steamcommunity` and
  `steam-tradeoffer-manager` (and DoctorMcKay's upstream when behavior is load-bearing — the fork can
  differ). If a response shape is unclear, ask for a real sample or fetch it live; never fabricate
  field shapes.
- **Faithful, lossless data types.** Model Steam JSON 1:1: `snake_case` field names, plain objects, no
  invented helper getters, preserve unknown fields (`[key: string]: unknown`). Numbers/strings/bigints
  match the wire (fixed64/uint64 → bigint).
- **Minimal comments.** Match the existing terse one-liner style (node-steam-session-like). No
  restate-the-code comments; keep only non-obvious *why* notes.
- **Partner inventory must use `/partnerinventory/`** (`bot.trade.getInventory`), not the new
  `/inventory/` endpoint — the latter hides trade-protected items. `bot.community.getInventory` is for
  your own / public inventories.
- **`cancel`/`decline` are community POSTs**, not Web API calls (the WebAPI rejects the mobile token);
  escrow/probation comes from a trade-page scrape (`GetTradeHoldDurations` returns AccessDenied).
- **Rate limits are classified, not retried.** Community = HTTP 429, WebAPI = eresult 84;
  `RateLimitError` carries `unlockAt`/`retryAfterMs`. The poll loop's adaptive backoff is the one
  exception. Cooldown policy stays in the consumer.
- **TS strictness:** `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
  `verbatimModuleSyntax`. Use `import type` for type-only imports, `.js` extensions on all relative
  imports (NodeNext), and conditional spreads (`...(x ? { x } : {})`) instead of assigning `undefined`
  to optional fields.

## Protobufs

`protobufs/steammessages_auth.proto` is the vendored + trimmed official Steam schema (unused
messages/services deleted, like steam-session does). `pnpm proto` regenerates
`src/protobufs/steammessages_auth_pb.ts` (committed, and **excluded from biome** via `biome.json`). Edit
the `.proto` and regenerate — never hand-edit the generated file. Uses Protobuf-ES v2
(`create`/`toBinary`/`fromBinary`).

## Live testing (`debug/`)

Debug scripts read a gitignored `.env` and reuse `./bot.refreshtoken` (also gitignored):
`pnpm bootstrap` (credential login → save token), `pnpm smoke` (read-only health check of the whole API
surface), `pnpm watch` (live trade-event watcher), `pnpm trade` (gated send→confirm→cancel; needs
`SEND=1 PARTNER_TRADE_URL=…`). Constraints when running live:
- The current test account is **limited** (can't send trades, use the market, or get an API key), so
  send/confirm/cancel, real API-key registration, and `changeTradeURL` correctness need a non-limited
  bot to verify; their code paths are complete and offline-tested.
- Access tokens are **IP-bound** (~24h). **Do not run aggressive rate-limit profiling** — keep live
  tests to gentle, single calls (prior profiling caused an IP edge-block).
- Secrets (`.env`, `bot.refreshtoken`, `debug/ratelimit-history.ts`) are gitignored — keep them out of
  commits.
