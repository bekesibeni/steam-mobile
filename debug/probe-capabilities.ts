/**
 * MobileApp capability sweep.
 *
 * Logs in ONCE with EAuthTokenPlatformType.MobileApp, then probes the full surface the trading
 * lib cares about — trade-offer web API, broader web API services, steamcommunity cookie
 * endpoints, and confirmations — to map exactly what a MobileApp session can and cannot do.
 *
 * Results distinguish three outcomes:
 *   ✅ works   ⚠️ reachable+authed but account-state/empty (NOT a platform limit)   ❌ blocked
 *
 * Run:  npx tsx probe-capabilities.ts
 */
import * as SteamTotp from "../src/crypto/steamTotp.js";
import { STEAM } from "./env.js";
import { login } from "./login.js";

const CONFIG = {
  identitySecret: STEAM.identitySecret,
};

type Outcome = "ok" | "warn" | "fail";
const results: { group: string; name: string; outcome: Outcome; detail: string }[] = [];
async function check(
  group: string,
  name: string,
  fn: () => Promise<{ outcome: Outcome; detail: string }>,
) {
  try {
    const { outcome, detail } = await fn();
    results.push({ group, name, outcome, detail });
  } catch (err) {
    results.push({ group, name, outcome: "fail", detail: (err as Error).message ?? String(err) });
  }
}

async function webApi(
  iface: string,
  method: string,
  version: number,
  accessToken: string,
  params: Record<string, string | number>,
): Promise<{ status: number; eresult: string | null; json: any; text: string }> {
  const qs = new URLSearchParams({
    access_token: accessToken,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  const res = await fetch(`https://api.steampowered.com/${iface}/${method}/v${version}/?${qs}`);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, eresult: res.headers.get("x-eresult"), json, text };
}

async function main(): Promise<void> {
  console.log(`\n=== MobileApp capability sweep ===\n`);

  const { steamID, accessToken, cookieHeader: cookieStr } = await login();
  console.log(`logged in as ${steamID}; access token aud=[web,mobile]\n`);

  // ── A. Trade offers (IEconService, access_token) ──────────────────────────────────────
  await check("A. tradeoffers (web API)", "GetTradeOffers", async () => {
    const r = await webApi("IEconService", "GetTradeOffers", 1, accessToken, {
      get_received_offers: 1,
      get_sent_offers: 1,
      active_only: 1,
      time_historical_cutoff: 0,
    });
    if (r.status !== 200)
      return { outcome: "fail", detail: `HTTP ${r.status} eresult=${r.eresult}` };
    return {
      outcome: "ok",
      detail: `sent=${r.json?.response?.trade_offers_sent?.length ?? 0} recv=${r.json?.response?.trade_offers_received?.length ?? 0}`,
    };
  });
  await check("A. tradeoffers (web API)", "GetTradeOffersSummary", async () => {
    const r = await webApi("IEconService", "GetTradeOffersSummary", 1, accessToken, {
      time_last_visit: 0,
    });
    if (r.status !== 200)
      return { outcome: "fail", detail: `HTTP ${r.status} eresult=${r.eresult}` };
    return { outcome: "ok", detail: JSON.stringify(r.json?.response ?? {}) };
  });
  await check("A. tradeoffers (web API)", "GetTradeHistory", async () => {
    const r = await webApi("IEconService", "GetTradeHistory", 1, accessToken, {
      max_trades: 1,
      include_total: 1,
      include_failed: 0,
      get_descriptions: 0,
    });
    if (r.status !== 200)
      return { outcome: "fail", detail: `HTTP ${r.status} eresult=${r.eresult}` };
    return { outcome: "ok", detail: `total=${r.json?.response?.total_trades ?? 0}` };
  });
  await check("A. tradeoffers (web API)", "GetTradeHoldDurations (own)", async () => {
    const r = await webApi("IEconService", "GetTradeHoldDurations", 1, accessToken, {
      steamid_target: steamID,
    });
    if (r.status !== 200)
      return { outcome: "fail", detail: `HTTP ${r.status} eresult=${r.eresult}` };
    return { outcome: "ok", detail: JSON.stringify(r.json?.response ?? {}) };
  });
  await check("A. tradeoffers (web API)", "GetTradeOffer (invalid id)", async () => {
    const r = await webApi("IEconService", "GetTradeOffer", 1, accessToken, { tradeofferid: 1 });
    // 200/eresult or a clean error both prove the token is accepted; only auth-denied is a fail.
    if (r.eresult === "15" || r.status === 401 || r.status === 403)
      return { outcome: "fail", detail: `auth denied (HTTP ${r.status} eresult=${r.eresult})` };
    return { outcome: "ok", detail: `reachable+authed (HTTP ${r.status} eresult=${r.eresult})` };
  });

  // ── B. Broader web API services (does the mobile token work beyond IEconService?) ─────
  await check("B. other web API (token)", "ISteamUser/GetPlayerSummaries", async () => {
    const r = await webApi("ISteamUser", "GetPlayerSummaries", 2, accessToken, {
      steamids: steamID,
    });
    if (r.status !== 200)
      return {
        outcome: "fail",
        detail: `HTTP ${r.status} eresult=${r.eresult} (may require API key)`,
      };
    const p = r.json?.response?.players?.[0];
    return {
      outcome: "ok",
      detail: p
        ? `persona=${p.personaname} level? created=${p.timecreated ? new Date(p.timecreated * 1000).toISOString().slice(0, 10) : "?"}`
        : "empty",
    };
  });
  await check("B. other web API (token)", "IPlayerService/GetSteamLevel", async () => {
    const r = await webApi("IPlayerService", "GetSteamLevel", 1, accessToken, { steamid: steamID });
    if (r.status !== 200)
      return { outcome: "fail", detail: `HTTP ${r.status} eresult=${r.eresult}` };
    return { outcome: "ok", detail: `level=${r.json?.response?.player_level ?? "?"}` };
  });
  await check("B. other web API (token)", "IPlayerService/GetOwnedGames", async () => {
    const r = await webApi("IPlayerService", "GetOwnedGames", 1, accessToken, {
      steamid: steamID,
      include_appinfo: 0,
    });
    if (r.status !== 200)
      return { outcome: "fail", detail: `HTTP ${r.status} eresult=${r.eresult}` };
    return { outcome: "ok", detail: `games=${r.json?.response?.game_count ?? 0}` };
  });

  // ── C. steamcommunity (cookies) ───────────────────────────────────────────────────────
  await check("C. steamcommunity (cookies)", "own CS2 inventory 730/2", async () => {
    const res = await fetch(
      `https://steamcommunity.com/inventory/${steamID}/730/2?l=english&count=50`,
      { headers: { Cookie: cookieStr } },
    );
    if (res.status !== 200)
      return {
        outcome: res.status === 403 ? "warn" : "fail",
        detail: `HTTP ${res.status} (403 = private/empty, not a platform limit)`,
      };
    const j: any = await res.json();
    return { outcome: "ok", detail: `assets=${j?.assets?.length ?? 0}` };
  });
  await check("C. steamcommunity (cookies)", "profile XML (persona/avatar)", async () => {
    const res = await fetch(`https://steamcommunity.com/profiles/${steamID}?xml=1`, {
      headers: { Cookie: cookieStr },
    });
    const t = await res.text();
    const persona = t.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/)?.[1];
    const created = t.match(/<memberSince>(.*?)<\/memberSince>/)?.[1];
    if (!persona) return { outcome: "fail", detail: `no persona parsed (HTTP ${res.status})` };
    return { outcome: "ok", detail: `persona=${persona} memberSince=${created ?? "?"}` };
  });
  await check("C. steamcommunity (cookies)", "trade URL / token", async () => {
    const res = await fetch(`https://steamcommunity.com/profiles/${steamID}/tradeoffers/privacy`, {
      headers: { Cookie: cookieStr },
      redirect: "manual",
    });
    const loc = res.headers.get("location") ?? "";
    if (res.status >= 300 && res.status < 400) {
      if (loc.includes("/login")) return { outcome: "fail", detail: "redirected to /login" };
      return {
        outcome: "warn",
        detail: `logged in but redirected → ${loc.split("?")[0]} (account limited)`,
      };
    }
    const html = await res.text();
    const m = html.match(/\/tradeoffer\/new\/\?partner=\d+&(?:amp;)?token=([\w-]+)/);
    return m
      ? { outcome: "ok", detail: `token=${m[1]}` }
      : { outcome: "warn", detail: `HTTP ${res.status}, no token (limited account?)` };
  });
  await check("C. steamcommunity (cookies)", "web API key (/dev/apikey)", async () => {
    const res = await fetch(`https://steamcommunity.com/dev/apikey?l=english`, {
      headers: { Cookie: cookieStr },
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400)
      return {
        outcome: "fail",
        detail: `redirected → ${(res.headers.get("location") ?? "").split("?")[0]}`,
      };
    const html = await res.text();
    const key = html.match(/Key:\s*([0-9A-F]{32})/)?.[1];
    if (key) return { outcome: "ok", detail: `existing key=${key.slice(0, 6)}…` };
    if (
      html.includes("You must have a validated email") ||
      html.includes("access_denied") ||
      html.includes("limited")
    )
      return { outcome: "warn", detail: "no key; account not eligible to register one (limited)" };
    return { outcome: "ok", detail: "page reachable, no key registered yet" };
  });
  await check("C. steamcommunity (cookies)", "notification counts (logged-in only)", async () => {
    const res = await fetch(`https://steamcommunity.com/actions/GetNotificationCounts`, {
      headers: { Cookie: cookieStr },
    });
    if (res.status !== 200) return { outcome: "fail", detail: `HTTP ${res.status}` };
    const j: any = await res.json().catch(() => null);
    return j?.notifications
      ? { outcome: "ok", detail: "authenticated (got notification counts)" }
      : { outcome: "fail", detail: "no notifications object — not logged in" };
  });

  // ── D. confirmations (identity_secret) ────────────────────────────────────────────────
  await check("D. confirmations", "mobileconf/getlist", async () => {
    const time = SteamTotp.time();
    const key = SteamTotp.getConfirmationKey(CONFIG.identitySecret, time, "conf");
    const url = `https://steamcommunity.com/mobileconf/getlist?p=${encodeURIComponent(SteamTotp.getDeviceID(steamID))}&a=${steamID}&k=${encodeURIComponent(key)}&t=${time}&m=react&tag=conf`;
    const res = await fetch(url, { headers: { Cookie: cookieStr } });
    const j: any = await res.json().catch(() => null);
    if (j?.needauth) return { outcome: "fail", detail: "needauth" };
    if (!j?.success)
      return { outcome: "fail", detail: `success=false: ${j?.message ?? j?.detail}` };
    return { outcome: "ok", detail: `${Array.isArray(j.conf) ? j.conf.length : 0} pending` };
  });

  // ── report ────────────────────────────────────────────────────────────────────────────
  const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" };
  let lastGroup = "";
  console.log("─".repeat(90));
  for (const r of results) {
    if (r.group !== lastGroup) {
      console.log(`\n${r.group}`);
      lastGroup = r.group;
    }
    console.log(`  ${icon[r.outcome]} ${r.name.padEnd(40)} ${r.detail}`);
  }
  console.log(`\n${"─".repeat(90)}`);
  const ok = results.filter((r) => r.outcome === "ok").length;
  const warn = results.filter((r) => r.outcome === "warn").length;
  const fail = results.filter((r) => r.outcome === "fail").length;
  console.log(`  ✅ ${ok} works   ⚠️  ${warn} account-state   ❌ ${fail} blocked\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
