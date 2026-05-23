import { login } from "./login.js";
import { dumpOffer } from "./offerDump.js";

// Live event watcher: logs the bot's trade URL, polls, and dumps every trade event in full.
// Send the bot a trade (and cancel it) to see newOffer / receivedOfferChanged fire.
async function main(): Promise<void> {
  console.log("\n=== watch: live trade events ===\n");
  const { bot } = await login();
  bot.on("debug", (m) => console.log("[debug]", m));
  bot.trade.on("newOffer", (o) => dumpOffer("🔔 newOffer", o));
  bot.trade.on("receivedOfferChanged", (o, old) => {
    console.log(`🔁 receivedOfferChanged #${o.id} ${old} -> ${o.state}`);
    dumpOffer("  full", o);
  });
  bot.trade.on("sentOfferChanged", (o, old) => {
    console.log(`🔁 sentOfferChanged #${o.id} ${old} -> ${o.state}`);
    dumpOffer("  full", o);
  });
  bot.trade.on("unknownOfferSent", (o) => dumpOffer("unknownOfferSent", o));
  bot.trade.on("pollFailure", (e) => console.log("[pollFailure]", e.message));
  bot.trade.on("pollData", (d) => console.log(`[pollData] offersSince=${d.offersSince}`));

  const { url } = await bot.community.getTradeURL();
  console.log(`\nBot trade URL: ${url}\nSend the bot a trade at that URL, then cancel it.\n`);
  bot.trade.startPolling();

  const seconds = Number(process.env.WATCH_SECONDS ?? 300);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  bot.trade.stopPolling();
  await bot.shutdown();
  console.log("\n✅ watch window ended\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ watch FAIL:", (e as Error)?.message ?? e);
  process.exit(1);
});
