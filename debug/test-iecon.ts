/**
 * IEconService access-token acceptance test.
 *
 * Logs in (MobileApp) and probes each IEconService method to determine whether our
 * MOBILE ACCESS TOKEN is accepted, or whether the method requires a Web API key.
 *
 * Auth is tested WITHOUT side effects: write methods (CancelTradeOffer / DeclineTradeOffer)
 * are called with an INVALID tradeofferid (1), so nothing real is ever canceled/declined.
 *   - auth denied (HTTP 401/403 or x-eresult=15 AccessDenied) → token rejected, needs a key
 *   - ANY other result (200, invalid-param, offer-not-found, etc.) → token got past auth = OK
 *
 * Run:  npx tsx test-iecon.ts   (or: pnpm test:iecon)
 */
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from "steam-session";
import SteamTotp from "steam-totp";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STEAM } from "./env.js";

const CONFIG = {
  username: STEAM.username,
  password: STEAM.password,
  sharedSecret: STEAM.sharedSecret,
  proxy: STEAM.proxy,
  refreshTokenFile: "./bot.refreshtoken",
};

const INVALID_TRADEOFFERID = "1"; // nonexistent — safe to "cancel"/"decline"
const INVALID_TRADEID = "1";

// ─── login (refresh token preferred → avoids the auth rate limit) ─────────────────────────
async function login() {
  const session = new LoginSession(
    EAuthTokenPlatformType.MobileApp,
    CONFIG.proxy ? { httpProxy: CONFIG.proxy } : undefined,
  );
  if (existsSync(CONFIG.refreshTokenFile)) {
    const token = readFileSync(CONFIG.refreshTokenFile, "utf8").trim();
    if (token) {
      session.refreshToken = token;
      await session.refreshAccessToken();
      console.log("[login] used saved refresh token");
      return { steamID: session.steamID.getSteamID64(), accessToken: session.accessToken! };
    }
  }
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
  return { steamID: session.steamID.getSteamID64(), accessToken: session.accessToken! };
}

type Verdict = "ok" | "authdenied" | "inconclusive";
function classify(status: number, eresult: string | null): Verdict {
  if (status === 401 || status === 403 || eresult === "15") return "authdenied"; // AccessDenied
  if (status === 200) return "ok"; // method ran & evaluated (even eresult!=1 like "no such offer") = token accepted
  // 404 (method not served for us), 429 (rate-limited), 5xx (outage) → NOT proof the token works
  return "inconclusive";
}

interface Method {
  name: string;
  http: "GET" | "POST";
  build: (ctx: { steamID: string; accessToken: string }) => { url: string; body?: string };
}

const api = (iface: string, method: string, v = 1) => `https://api.steampowered.com/${iface}/${method}/v${v}/`;

const METHODS: Method[] = [
  { name: "GetTradeOffers", http: "GET", build: ({ accessToken }) => ({ url: `${api("IEconService", "GetTradeOffers")}?access_token=${accessToken}&get_sent_offers=1&get_received_offers=1&active_only=1&time_historical_cutoff=0` }) },
  { name: "GetTradeOffer (invalid id)", http: "GET", build: ({ accessToken }) => ({ url: `${api("IEconService", "GetTradeOffer")}?access_token=${accessToken}&tradeofferid=${INVALID_TRADEOFFERID}` }) },
  { name: "GetTradeOffersSummary", http: "GET", build: ({ accessToken }) => ({ url: `${api("IEconService", "GetTradeOffersSummary")}?access_token=${accessToken}&time_last_visit=0` }) },
  { name: "GetTradeHistory", http: "GET", build: ({ accessToken }) => ({ url: `${api("IEconService", "GetTradeHistory")}?access_token=${accessToken}&max_trades=1&include_total=1` }) },
  { name: "GetTradeHoldDurations (self)", http: "GET", build: ({ accessToken, steamID }) => ({ url: `${api("IEconService", "GetTradeHoldDurations")}?access_token=${accessToken}&steamid_target=${steamID}` }) },
  { name: "GetTradeStatus (invalid id)", http: "GET", build: ({ accessToken }) => ({ url: `${api("IEconService", "GetTradeStatus")}?access_token=${accessToken}&tradeid=${INVALID_TRADEID}` }) },
  // ── the two we actually want to settle (invalid id = no real side effect) ──
  { name: "CancelTradeOffer (invalid id)", http: "POST", build: ({ accessToken }) => ({ url: `${api("IEconService", "CancelTradeOffer")}?access_token=${accessToken}`, body: `tradeofferid=${INVALID_TRADEOFFERID}` }) },
  { name: "DeclineTradeOffer (invalid id)", http: "POST", build: ({ accessToken }) => ({ url: `${api("IEconService", "DeclineTradeOffer")}?access_token=${accessToken}`, body: `tradeofferid=${INVALID_TRADEOFFERID}` }) },
];

async function main() {
  console.log("\n=== IEconService access-token acceptance test ===\n");
  const ctx = await login();
  console.log(`[ready] steamID=${ctx.steamID}\n`);
  console.log("─".repeat(92));

  for (const m of METHODS) {
    const { url, body } = m.build(ctx);
    try {
      const res = await fetch(url, body !== undefined
        ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }
        : { method: "GET" });
      const eresult = res.headers.get("x-eresult");
      const verdict = classify(res.status, eresult);
      const text = (await res.text()).replace(/\s+/g, " ").slice(0, 80);
      const icon =
        verdict === "ok" ? "✅ token OK   " : verdict === "authdenied" ? "❌ AUTH DENIED" : "⚠️  INCONCLUSIVE";
      const tag = verdict === "inconclusive" ? `(HTTP ${res.status} — method not cleanly served, NOT proof of acceptance)` : "";
      console.log(`${icon} ${m.http.padEnd(4)} ${m.name.padEnd(34)} HTTP ${res.status} eresult=${eresult ?? "-"} ${tag}`);
      if (text) console.log(`              ↳ ${text}`);
    } catch (err) {
      console.log(`❓ FETCH FAIL ${m.http.padEnd(4)} ${m.name.padEnd(34)} ${(err as Error).message}`);
    }
  }

  console.log("─".repeat(92));
  console.log("\nVerdict: if CancelTradeOffer/DeclineTradeOffer show ✅ token OK → we can use the API.");
  console.log("         if ❌ AUTH DENIED → keep the community POST (cookies).\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
