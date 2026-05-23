/**
 * Pin down whether IEconService/CancelTradeOffer works with our mobile token, by trying
 * several request shapes (the earlier 404 may just be access_token placement for POST).
 * Uses an INVALID tradeofferid (1) → no real side effect.
 *
 * Run:  npx tsx test-cancel.ts
 */

import { login } from "./login.js";

const ID = "1";

async function attempt(label: string, url: string, init?: RequestInit) {
  try {
    const res = await fetch(url, init);
    const eresult = res.headers.get("x-eresult");
    const ct = res.headers.get("content-type") ?? "";
    const text = (await res.text()).replace(/\s+/g, " ").slice(0, 90);
    console.log(
      `\n${label}\n  HTTP ${res.status}  eresult=${eresult ?? "-"}  ctype=${ct.split(";")[0]}\n  ↳ ${text}`,
    );
  } catch (err) {
    console.log(`\n${label}\n  FETCH FAIL: ${(err as Error).message}`);
  }
}

async function main() {
  const { accessToken: t } = await login();
  const base = "https://api.steampowered.com/IEconService/CancelTradeOffer/v1/";
  console.log("=== CancelTradeOffer request-shape probe ===");

  await attempt(
    "1) POST, access_token in QUERY, tradeofferid in body",
    `${base}?access_token=${t}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `tradeofferid=${ID}`,
    },
  );

  await attempt("2) POST, access_token + tradeofferid both in BODY", base, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `access_token=${t}&tradeofferid=${ID}`,
  });

  await attempt("3) POST, query + format=json", `${base}?access_token=${t}&format=json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `tradeofferid=${ID}`,
  });

  await attempt("4) GET, everything in query", `${base}?access_token=${t}&tradeofferid=${ID}`);

  console.log("\nNote: a JSON body or x-eresult header = method served (token accepted).");
  console.log(
    "      HTML '404 Not Found' on all shapes = not usable with our token → community POST.\n",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
