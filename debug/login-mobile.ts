/**
 * MobileApp login probe — now via our own auth layer (loginWithCredentials), no steam-session.
 *
 * Logs in (saved refresh token or credentials+TOTP), then probes the real trade surfaces:
 *   1. token audiences + lifetimes
 *   2. steamcommunity cookie auth → own trade URL page (logged-in only)
 *   3. web API access_token → IEconService/GetTradeOffers
 *   4. identity_secret → mobileconf/getlist (confirmations)
 *   5. own CS2 inventory
 *
 * Run:  npm run login   (or: npx tsx debug/login-mobile.ts)
 */
import * as SteamTotp from "../src/crypto/steamTotp.js";
import { STEAM } from "./env.js";
import { login } from "./login.js";

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
  } catch {
    return null;
  }
}

function summarizeToken(label: string, token: string | null): void {
  if (!token) {
    console.log(`  ${label}: (none)`);
    return;
  }
  const p = decodeJwt(token);
  if (!p) {
    console.log(`  ${label}: <unparseable> (${token.slice(0, 16)}…)`);
    return;
  }
  const iat = Number(p.iat ?? 0);
  const exp = Number(p.exp ?? 0);
  const aud = Array.isArray(p.aud) ? p.aud.join(",") : String(p.aud ?? "");
  const lifeDays = exp && iat ? ((exp - iat) / 86400).toFixed(1) : "?";
  const expiresInH = exp ? ((exp * 1000 - Date.now()) / 3_600_000).toFixed(1) : "?";
  console.log(`  ${label}: aud=[${aud}] lifetime=${lifeDays}d expiresIn=${expiresInH}h`);
}

async function probe(label: string, fn: () => Promise<string>): Promise<void> {
  process.stdout.write(`\n[probe] ${label}\n`);
  try {
    console.log(`  ✅ ${await fn()}`);
  } catch (err) {
    console.log(`  ❌ ${(err as Error).message ?? err}`);
  }
}

async function main(): Promise<void> {
  console.log("\n=== MobileApp login probe (loginWithCredentials) ===\n");

  const { steamID, accessToken, refreshToken, cookieHeader: cookieStr } = await login();
  console.log(`\n[login] ✅ authenticated as ${steamID}\n[tokens]`);
  summarizeToken("refreshToken", refreshToken);
  summarizeToken("accessToken ", accessToken);

  await probe("steamcommunity: own trade URL (cookie auth)", async () => {
    const res = await fetch(`https://steamcommunity.com/profiles/${steamID}/tradeoffers/privacy`, {
      headers: { Cookie: cookieStr },
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`redirected (${res.status}) — likely NOT logged in`);
    }
    const html = await res.text();
    if (html.includes("g_steamID = false")) throw new Error("g_steamID = false — NOT logged in");
    const m = html.match(/\/tradeoffer\/new\/\?partner=\d+&(?:amp;)?token=([\w-]+)/);
    if (!m) throw new Error(`HTTP ${res.status} but no trade token in page`);
    return `logged in — trade token=${m[1]}`;
  });

  await probe("web API: IEconService/GetTradeOffers (access_token)", async () => {
    const url =
      `https://api.steampowered.com/IEconService/GetTradeOffers/v1/?access_token=${encodeURIComponent(accessToken)}` +
      `&get_received_offers=1&get_sent_offers=1&active_only=1&time_historical_cutoff=0`;
    const res = await fetch(url);
    const eresult = res.headers.get("x-eresult");
    if (res.status !== 200) throw new Error(`HTTP ${res.status} x-eresult=${eresult}`);
    const parsed = JSON.parse(await res.text());
    const sent = parsed?.response?.trade_offers_sent?.length ?? 0;
    const recv = parsed?.response?.trade_offers_received?.length ?? 0;
    return `HTTP 200 x-eresult=${eresult} sent=${sent} received=${recv}`;
  });

  await probe("confirmations: mobileconf/getlist (identity_secret)", async () => {
    const time = SteamTotp.time();
    const deviceId = SteamTotp.getDeviceID(steamID);
    const key = SteamTotp.getConfirmationKey(STEAM.identitySecret, time, "conf");
    const url =
      `https://steamcommunity.com/mobileconf/getlist?p=${encodeURIComponent(deviceId)}&a=${steamID}` +
      `&k=${encodeURIComponent(key)}&t=${time}&m=react&tag=conf`;
    const parsed = JSON.parse(await (await fetch(url, { headers: { Cookie: cookieStr } })).text());
    if (parsed?.needauth) throw new Error("needauth — session not valid for mobileconf");
    if (!parsed?.success) throw new Error(`success=false: ${parsed?.message ?? parsed?.detail}`);
    return `success — ${Array.isArray(parsed.conf) ? parsed.conf.length : 0} pending confirmation(s)`;
  });

  await probe("inventory: own CS2 (appid 730, ctx 2)", async () => {
    const res = await fetch(
      `https://steamcommunity.com/inventory/${steamID}/730/2?l=english&count=50`,
      { headers: { Cookie: cookieStr } },
    );
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return `assets=${json?.assets?.length ?? 0} descriptions=${json?.descriptions?.length ?? 0}`;
  });

  console.log("\n=== done ===\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
