import { existsSync, readFileSync } from "node:fs";
import { SteamMobile } from "../src/index.js";
import { dumpOffer } from "./offerDump.js";

// Read-only receive-side verification: poll for incoming offers and log every event with full detail.
// You send the bot a trade, it logs [newOffer]; you cancel it, it logs [receivedOfferChanged].
async function main() {
  console.log("\n=== Incoming-trade watcher (read-only) ===\n");
  if (!existsSync("./bot.refreshtoken")) throw new Error("missing ./bot.refreshtoken");
  const refreshToken = readFileSync("./bot.refreshtoken", "utf8").trim();

  // Construct first, wire listeners, THEN login — nothing is missed once polling starts.
  const bot = new SteamMobile({ refreshToken });
  bot.on("debug", (m) => console.log("[debug]", m));

  bot.trade.on("newOffer", (o) => dumpOffer("🔔 [newOffer]", o));
  bot.trade.on("receivedOfferChanged", (o, old) => {
    console.log(`🔁 [receivedOfferChanged] #${o.id} ${old} -> ${o.state}`);
    dumpOffer("  full", o);
  });
  bot.trade.on("sentOfferChanged", (o, old) => {
    console.log(`🔁 [sentOfferChanged] #${o.id} ${old} -> ${o.state}`);
    dumpOffer("  full", o);
  });
  bot.trade.on("unknownOfferSent", (o) => dumpOffer("[unknownOfferSent]", o));
  bot.trade.on("pollFailure", (e) => console.log("[pollFailure]", e.message));
  bot.trade.on("pollData", (d) => console.log(`[pollData] offersSince=${d.offersSince}`));

  await bot.login();
  console.log(`\nBot steamID: ${bot.steamID.getSteamID64()}`);
  const { url } = await bot.community.getTradeURL();
  console.log(`Bot trade URL: ${url}`);
  console.log("\nPolling every 10s — send the bot a trade at the URL above, then cancel it.\n");
  bot.trade.startPolling();

  const seconds = Number(process.env.WATCH_SECONDS ?? 300);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  bot.trade.stopPolling();
  console.log("\n✅ watch window ended\n");
  await bot.shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ FAIL:", err?.message ?? err);
  process.exit(1);
});
