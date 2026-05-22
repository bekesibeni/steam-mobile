/**
 * Steam rate-limit tester (MobileApp session).
 *
 * For each target endpoint it runs two phases:
 *   1. PROBE — fire requests until the first 429 (or a hard request cap), recording
 *              how many succeeded and over what wall-clock window  → the LIMIT.
 *   2. RESET — stop, then probe one request on an interval until it recovers,
 *              measuring how long the block lasts                  → the RESET WINDOW.
 *
 * SAFETY:
 *   - Stops the instant it sees a 429 — it never keeps pounding a limited endpoint.
 *   - Hard cap MAX_REQUESTS per endpoint.
 *   - Persists the refresh token to disk so reruns skip the (itself rate-limited)
 *     credential login. Delete bot.refreshtoken to force a fresh login.
 *   - Steam limits are largely PER-IP. Set CONFIG.proxy to the SAME egress your bot
 *     uses, or you'll just throttle your own dev IP. (Proxy needs `undici` installed:
 *     pnpm add -D undici)
 *
 * Run:  npx tsx ratelimit-test.ts
 */
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from "steam-session";
import SteamTotp from "steam-totp";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STEAM } from "./env.js";

// ─── CONFIG ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  username: STEAM.username,
  password: STEAM.password,
  sharedSecret: STEAM.sharedSecret,
  identitySecret: STEAM.identitySecret,
  proxy: STEAM.proxy,
  refreshTokenFile: "./bot.refreshtoken",
};

// ─── test tuning ──────────────────────────────────────────────────────────────────────────
const MAX_REQUESTS = 150; // hard cap per endpoint (safety — stops even if no 429)
const BURST_DELAY_MS = 0; // delay between probe requests (0 = full burst, worst case)
const RESET_PROBE_INTERVAL_MS = 10_000; // how often to test recovery
const RESET_MAX_WAIT_MS = 10 * 60_000; // give up measuring reset after this long
const COOLDOWN_BETWEEN_ENDPOINTS_MS = 30_000; // let one limit settle before testing the next

// Which endpoints to run. Add a real tradeid to enable getTradeStatus.
const RUN = {
  getTradeOffers: true, // api.steampowered.com — the hot poll endpoint
  ownInventory: true, // steamcommunity.com/inventory — the strict one
  getTradeStatus: false, // needs TRADE_ID below
  mobileconfList: false, // steamcommunity.com/mobileconf — uses identitySecret
};
const TRADE_ID = ""; // fill in to test getTradeStatus

// ─── types & helpers ────────────────────────────────────────────────────────────────────
interface Ctx {
  steamID: string;
  accessToken: string;
  cookieHeader: string;
}
interface Probe {
  status: number;
  limited: boolean;
  note?: string;
}
interface Endpoint {
  name: string;
  request: (ctx: Ctx) => Promise<Probe>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookieHeader = (cookies: string[]) => cookies.map((c) => c.split(";")[0]).join("; ");

// ─── login (refresh token preferred → cheap & avoids the auth rate limit) ─────────────────
async function login(): Promise<Ctx> {
  if (CONFIG.proxy) {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(CONFIG.proxy));
    console.log("[proxy] endpoint requests routed through proxy");
  }

  const session = new LoginSession(
    EAuthTokenPlatformType.MobileApp,
    CONFIG.proxy ? { httpProxy: CONFIG.proxy } : undefined,
  );

  // Path 1: saved refresh token → just mint an access token (1 call, no TOTP, no 429 risk).
  if (existsSync(CONFIG.refreshTokenFile)) {
    const token = readFileSync(CONFIG.refreshTokenFile, "utf8").trim();
    if (token) {
      session.refreshToken = token;
      await session.refreshAccessToken();
      const cookies = await session.getWebCookies();
      console.log("[login] used saved refresh token");
      return { steamID: session.steamID.getSteamID64(), accessToken: session.accessToken!, cookieHeader: cookieHeader(cookies) };
    }
  }

  // Path 2: credential login (expensive, rate-limited) → persist the refresh token after.
  const authed = new Promise<void>((resolve, reject) => {
    session.on("authenticated", () => resolve());
    session.on("error", reject);
    session.on("timeout", () => reject(new Error("login timeout")));
  });
  const code = SteamTotp.generateAuthCode(CONFIG.sharedSecret);
  const start = await session.startWithCredentials({ accountName: CONFIG.username, password: CONFIG.password, steamGuardCode: code });
  if (start.actionRequired && (start.validActions ?? []).some((a) => a.type === EAuthSessionGuardType.DeviceCode)) {
    await session.submitSteamGuardCode(code);
  }
  await authed;
  if (session.refreshToken) {
    writeFileSync(CONFIG.refreshTokenFile, session.refreshToken);
    console.log(`[login] credential login OK — refresh token saved to ${CONFIG.refreshTokenFile}`);
  }
  const cookies = await session.getWebCookies();
  return { steamID: session.steamID.getSteamID64(), accessToken: session.accessToken!, cookieHeader: cookieHeader(cookies) };
}

// ─── endpoint definitions ─────────────────────────────────────────────────────────────────
const ENDPOINTS: Record<string, Endpoint> = {
  getTradeOffers: {
    name: "IEconService/GetTradeOffers  (api, access_token)",
    request: async ({ accessToken }) => {
      const url =
        `https://api.steampowered.com/IEconService/GetTradeOffers/v1/?access_token=${encodeURIComponent(accessToken)}` +
        `&get_sent_offers=1&get_received_offers=1&active_only=1&time_historical_cutoff=0`;
      const res = await fetch(url);
      const eresult = res.headers.get("x-eresult");
      return { status: res.status, limited: res.status === 429 || eresult === "84", note: `x-eresult=${eresult}` };
    },
  },
  ownInventory: {
    name: "steamcommunity /inventory/730/2  (cookie)",
    request: async ({ steamID, cookieHeader }) => {
      const url = `https://steamcommunity.com/inventory/${steamID}/730/2?l=english&count=2000`;
      const res = await fetch(url, { headers: { Cookie: cookieHeader } });
      return { status: res.status, limited: res.status === 429 };
    },
  },
  getTradeStatus: {
    name: "IEconService/GetTradeStatus  (api, access_token)",
    request: async ({ accessToken }) => {
      const url =
        `https://api.steampowered.com/IEconService/GetTradeStatus/v1/?access_token=${encodeURIComponent(accessToken)}` +
        `&tradeid=${TRADE_ID}&get_descriptions=1&language=english`;
      const res = await fetch(url);
      const eresult = res.headers.get("x-eresult");
      return { status: res.status, limited: res.status === 429 || eresult === "84", note: `x-eresult=${eresult}` };
    },
  },
  mobileconfList: {
    name: "steamcommunity /mobileconf/getlist  (cookie + identitySecret)",
    request: async ({ steamID, cookieHeader }) => {
      const time = SteamTotp.time();
      const key = SteamTotp.getConfirmationKey(CONFIG.identitySecret, time, "conf");
      const url =
        `https://steamcommunity.com/mobileconf/getlist?p=${encodeURIComponent(SteamTotp.getDeviceID(steamID))}` +
        `&a=${steamID}&k=${encodeURIComponent(key)}&t=${time}&m=react&tag=conf`;
      const res = await fetch(url, { headers: { Cookie: cookieHeader } });
      return { status: res.status, limited: res.status === 429 };
    },
  },
};

// ─── the two-phase probe ─────────────────────────────────────────────────────────────────
async function probeEndpoint(ep: Endpoint, ctx: Ctx): Promise<void> {
  console.log(`\n${"─".repeat(80)}\n=== ${ep.name} ===`);

  // Phase 1 — find the limit.
  const start = Date.now();
  let success = 0;
  let limitedAtRequest = -1;
  for (let i = 1; i <= MAX_REQUESTS; i++) {
    const r = await ep.request(ctx);
    if (r.limited) {
      limitedAtRequest = i;
      const windowMs = Date.now() - start;
      console.log(`  ⛔ LIMITED on request #${i}: ${success} succeeded in ${(windowMs / 1000).toFixed(1)}s before block (status=${r.status} ${r.note ?? ""})`);
      break;
    }
    if (r.status === 200) success++;
    else console.log(`  ⚠️  #${i} non-200 status=${r.status} ${r.note ?? ""}`);
    if (BURST_DELAY_MS) await sleep(BURST_DELAY_MS);
  }
  if (limitedAtRequest === -1) {
    console.log(`  ✅ no 429 within ${MAX_REQUESTS} requests (${success} ok). Limit is above the cap, or window-based — raise MAX_REQUESTS / lower BURST_DELAY_MS.`);
    return;
  }

  // Phase 2 — measure the reset window.
  console.log(`  ⏳ measuring reset (probe every ${RESET_PROBE_INTERVAL_MS / 1000}s, max ${RESET_MAX_WAIT_MS / 60000}min)…`);
  const limitedSince = Date.now();
  while (Date.now() - limitedSince < RESET_MAX_WAIT_MS) {
    await sleep(RESET_PROBE_INTERVAL_MS);
    const r = await ep.request(ctx);
    const waited = (Date.now() - limitedSince) / 1000;
    if (!r.limited && r.status === 200) {
      console.log(`  🔄 RECOVERED after ~${waited.toFixed(0)}s (±${RESET_PROBE_INTERVAL_MS / 1000}s — sliding windows make this approximate)`);
      return;
    }
    console.log(`     still limited at ${waited.toFixed(0)}s (status=${r.status})`);
  }
  console.log(`  ⚠️  did not recover within ${RESET_MAX_WAIT_MS / 60000}min`);
}

// ─── main ───────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n=== Steam rate-limit tester ===`);
  const ctx = await login();
  console.log(`[ready] steamID=${ctx.steamID}\n`);

  const selected = (Object.keys(RUN) as (keyof typeof RUN)[]).filter((k) => RUN[k]);
  for (let i = 0; i < selected.length; i++) {
    await probeEndpoint(ENDPOINTS[selected[i]], ctx);
    if (i < selected.length - 1) {
      console.log(`\n  …cooldown ${COOLDOWN_BETWEEN_ENDPOINTS_MS / 1000}s before next endpoint…`);
      await sleep(COOLDOWN_BETWEEN_ENDPOINTS_MS);
    }
  }
  console.log(`\n${"─".repeat(80)}\n=== done ===\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
