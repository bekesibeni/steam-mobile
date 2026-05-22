/**
 * steam-session login probe — MobileApp platform.
 *
 * Self-contained test. Logs in with credentials + TOTP, gets web cookies, then probes the
 * real trade surfaces so we can compare MobileApp vs WebBrowser (see login-web.ts):
 *   1. token audiences + lifetimes (the "stability" signal)
 *   2. steamcommunity cookie auth  → own trade URL page (logged-in only)
 *   3. web API access_token        → IEconService/GetTradeOffers  (KEY MobileApp unknown)
 *   4. identity_secret             → mobileconf/getlist (confirmations)
 *   5. own CS2 inventory           → informational
 *
 * Run:  npm install  &&  npx tsx login-mobile.ts
 */
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from "steam-session";
import SteamTotp from "steam-totp";
import { STEAM } from "./env.js";

// ─── CONFIG — loaded from .env (copy .env.example). ───────────
const CONFIG = {
  username: STEAM.username,
  password: STEAM.password,
  sharedSecret: STEAM.sharedSecret,
  identitySecret: STEAM.identitySecret,
  proxy: STEAM.proxy,
};

const PLATFORM = EAuthTokenPlatformType.MobileApp;
const PLATFORM_LABEL = "MobileApp";
const LOGIN_TIMEOUT_MS = 30_000;

// ─── helpers ────────────────────────────────────────────────────────────────────────────
function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
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
  console.log(`  ${label}: aud=[${aud}] lifetime=${lifeDays}d expiresIn=${expiresInH}h exp=${exp ? new Date(exp * 1000).toISOString() : "?"}`);
}

function cookieHeader(cookies: string[]): string {
  // getWebCookies() returns entries like "steamLoginSecure=...; Path=/; ...". Keep name=value only.
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

async function probe(label: string, fn: () => Promise<string>): Promise<void> {
  process.stdout.write(`\n[probe] ${label}\n`);
  try {
    const result = await fn();
    console.log(`  ✅ ${result}`);
  } catch (err) {
    console.log(`  ❌ ${(err as Error).message ?? err}`);
  }
}

// ─── main ───────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n=== steam-session login probe — platform: ${PLATFORM_LABEL} ===\n`);

  const session = new LoginSession(PLATFORM, CONFIG.proxy ? { httpProxy: CONFIG.proxy } : undefined);

  // Attach listeners BEFORE start to avoid racing the 'authenticated' event.
  const authenticated = new Promise<void>((resolve, reject) => {
    session.on("authenticated", () => resolve());
    session.on("error", (e: Error) => reject(e));
    session.on("timeout", () => reject(new Error("Steam login timeout (session event)")));
  });

  const startResult = await session.startWithCredentials({
    accountName: CONFIG.username,
    password: CONFIG.password,
    steamGuardCode: SteamTotp.generateAuthCode(CONFIG.sharedSecret),
  });

  if (startResult.actionRequired) {
    const needsDeviceCode = (startResult.validActions ?? []).some(
      (a) => a.type === EAuthSessionGuardType.DeviceCode,
    );
    if (needsDeviceCode) {
      console.log("[login] device code required — submitting TOTP");
      await session.submitSteamGuardCode(SteamTotp.generateAuthCode(CONFIG.sharedSecret));
    } else {
      console.log("[login] actionRequired with non-TOTP guard:", startResult.validActions);
    }
  }

  await Promise.race([
    authenticated,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Login timeout (race)")), LOGIN_TIMEOUT_MS),
    ),
  ]);

  const steamID = session.steamID.getSteamID64();
  console.log(`\n[login] ✅ authenticated as ${CONFIG.username} (${steamID})`);

  // Web cookies. For MobileApp the access token IS the cookie (steamid||token); getWebCookies()
  // refreshes the access token first if needed.
  let cookies: string[] = [];
  try {
    cookies = await session.getWebCookies();
    console.log(`[cookies] getWebCookies() → ${cookies.length} cookie(s)`);
    for (const c of cookies) console.log(`  - ${c.split(";")[0]}`);
  } catch (err) {
    console.log(`[cookies] ❌ getWebCookies() failed: ${(err as Error).message}`);
  }

  // Ensure we have an access token for the web-API probe.
  let accessToken = session.accessToken ?? null;
  if (!accessToken) {
    try {
      await session.refreshAccessToken();
      accessToken = session.accessToken ?? null;
      console.log("[token] refreshAccessToken() → access token obtained");
    } catch (err) {
      console.log(`[token] ❌ refreshAccessToken() failed: ${(err as Error).message}`);
    }
  }

  console.log("\n[tokens]");
  summarizeToken("refreshToken", session.refreshToken ?? null);
  summarizeToken("accessToken ", accessToken);

  const cookieStr = cookieHeader(cookies);

  // 2. steamcommunity cookie auth — own trade-URL page only renders the offer link when logged in.
  await probe("steamcommunity: own trade URL (cookie auth)", async () => {
    const res = await fetch(`https://steamcommunity.com/profiles/${steamID}/tradeoffers/privacy`, {
      headers: { Cookie: cookieStr },
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`redirected (${res.status}) to ${res.headers.get("location")} — likely NOT logged in`);
    }
    const html = await res.text();
    if (html.includes("g_steamID = false")) throw new Error("g_steamID = false — NOT logged in");
    const m = html.match(/\/tradeoffer\/new\/\?partner=\d+&(?:amp;)?token=([\w-]+)/);
    if (!m) throw new Error(`HTTP ${res.status} but no trade token found in page`);
    return `logged in — trade token=${m[1]}`;
  });

  // 3. web API access_token — does api.steampowered.com accept a MobileApp-audience token?
  await probe("web API: IEconService/GetTradeOffers (access_token)", async () => {
    if (!accessToken) throw new Error("no access token");
    const url =
      `https://api.steampowered.com/IEconService/GetTradeOffers/v1/?access_token=${encodeURIComponent(accessToken)}` +
      `&get_received_offers=1&get_sent_offers=1&active_only=1&time_historical_cutoff=0`;
    const res = await fetch(url);
    const eresult = res.headers.get("x-eresult");
    const text = await res.text();
    if (res.status !== 200) throw new Error(`HTTP ${res.status} x-eresult=${eresult} body=${text.slice(0, 120)}`);
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`HTTP 200 but non-JSON body: ${text.slice(0, 120)}`);
    }
    const sent = parsed?.response?.trade_offers_sent?.length ?? 0;
    const recv = parsed?.response?.trade_offers_received?.length ?? 0;
    return `HTTP 200 x-eresult=${eresult} sent=${sent} received=${recv}`;
  });

  // 4. identity_secret — confirmations list.
  await probe("confirmations: mobileconf/getlist (identity_secret)", async () => {
    const time = SteamTotp.time();
    const deviceId = SteamTotp.getDeviceID(steamID);
    const key = SteamTotp.getConfirmationKey(CONFIG.identitySecret, time, "conf");
    const url =
      `https://steamcommunity.com/mobileconf/getlist?p=${encodeURIComponent(deviceId)}&a=${steamID}` +
      `&k=${encodeURIComponent(key)}&t=${time}&m=react&tag=conf`;
    const res = await fetch(url, { headers: { Cookie: cookieStr } });
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
    }
    if (parsed?.needauth) throw new Error("needauth — session not valid for mobileconf");
    if (!parsed?.success) throw new Error(`success=false: ${parsed?.message ?? parsed?.detail ?? "unknown"}`);
    return `success — ${Array.isArray(parsed.conf) ? parsed.conf.length : 0} pending confirmation(s)`;
  });

  // 5. own CS2 inventory — informational.
  await probe("inventory: own CS2 (appid 730, ctx 2)", async () => {
    const res = await fetch(
      `https://steamcommunity.com/inventory/${steamID}/730/2?l=english&count=50`,
      { headers: { Cookie: cookieStr } },
    );
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    return `assets=${json?.assets?.length ?? 0} descriptions=${json?.descriptions?.length ?? 0}`;
  });

  console.log("\n=== done ===\n");
  // LoginSession keeps an internal poll timer alive; force exit.
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
