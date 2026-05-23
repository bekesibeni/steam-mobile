import { existsSync, readFileSync } from "node:fs";
import { SteamMobile } from "../src/index.js";
import { dumpOffer } from "./offerDump.js";

// Read-only by default: starts the poll loop and prints events. reconcile runs if OFFER_IDS is set.
async function main() {
  console.log("\n=== M4: polling + reconcile + events (read-only) ===\n");
  if (!existsSync("./bot.refreshtoken")) throw new Error("missing ./bot.refreshtoken");
  const refreshToken = readFileSync("./bot.refreshtoken", "utf8").trim();

  // Construct first, wire all listeners, THEN login — so nothing is missed once polling starts.
  const bot = new SteamMobile({ refreshToken });
  bot.on("debug", (m) => console.log("[debug]", m));

  bot.trade.on("newOffer", (o) => dumpOffer("[newOffer]", o));
  bot.trade.on("sentOfferChanged", (o, old) => {
    console.log(`[sentOfferChanged] #${o.id} ${old} -> ${o.state}`);
    dumpOffer("  full", o);
  });
  bot.trade.on("receivedOfferChanged", (o, old) => {
    console.log(`[receivedOfferChanged] #${o.id} ${old} -> ${o.state}`);
    dumpOffer("  full", o);
  });
  bot.trade.on("unknownOfferSent", (o) => dumpOffer("[unknownOfferSent]", o));
  bot.trade.on("pollFailure", (e) => console.log("[pollFailure]", e.message));
  bot.trade.on("pollData", (d) => console.log(`[pollData] offersSince=${d.offersSince}`));

  await bot.login();

  // reconcile a known set of ids (authoritative, no polling window)
  const offerIds = (process.env.OFFER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (offerIds.length) {
    const map = await bot.trade.reconcile(offerIds);
    for (const id of offerIds) {
      const o = map.get(id);
      console.log(`reconcile #${id}: ${o ? `state=${o.state} ours=${o.isOurOffer}` : "not found"}`);
    }
  } else {
    console.log("reconcile: skipped (set OFFER_IDS=123,456)");
  }

  const seconds = Number(process.env.WATCH_SECONDS ?? 70);
  console.log(`\nStarting poll loop for ${seconds}s (Ctrl+C to stop early)…\n`);
  bot.trade.startPolling(); // default: 10s active / 5min full sweep

  await new Promise((r) => setTimeout(r, seconds * 1000));
  bot.trade.stopPolling();
  console.log("\n✅ M4 live watch done\n");
  await bot.shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ M4 FAIL:", err?.message ?? err);
  process.exit(1);
});
