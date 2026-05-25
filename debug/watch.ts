import type { TradeOffer } from "../src/index.js";
import { ETradeOfferState } from "../src/index.js";
import { login } from "./login.js";

// Live trade-update watcher using the library's integrated poller + events.
//
// Cold-start note: like steam-tradeoffer-manager, the first full poll announces EVERY pre-existing
// offer (empty pollData = nothing is "known" yet). McKay's cure is persisting pollData across runs.
// Here we instead seed a silent baseline with one pollOnce() BEFORE subscribing, so only changes
// from this point on are reported. DEBUG_HTTP=1 logs raw URLs; WATCH_SECONDS bounds the run.
const POLL_INTERVAL_MS = 5_000;
const FULL_UPDATE_MS = 30_000;

const stateName = (s: ETradeOfferState): string => `${ETradeOfferState[s] ?? "Unknown"} (${s})`;
const tag = (o: TradeOffer): string =>
  `#${o.id} ${o.isOurOffer ? "sent" : "recv"} partner=${o.partner.getSteamID64()}`;

async function main(): Promise<void> {
  console.log("\n=== watch: live trade updates (integrated poller, 5s) ===\n");
  const { bot, steamID } = await login();
  console.log(`[login] steamID=${steamID}`);

  const { url } = await bot.community.getTradeURL();
  console.log(`\nBot trade URL: ${url}`);

  // Silent baseline: record all current offers without emitting (no listeners attached yet).
  console.log("[watch] seeding baseline — existing offers won't be announced…");
  const { pollData } = await bot.trade.pollOnce({
    forceFull: true,
    pollInterval: POLL_INTERVAL_MS,
    pollFullUpdateInterval: FULL_UPDATE_MS,
  });
  const known = Object.keys(pollData.sent).length + Object.keys(pollData.received).length;
  console.log(`[watch] baseline established (${known} existing offers ignored)`);

  // One handler for every change, new or updated (collapsed via the unified offerUpdate event).
  bot.trade.on("offerUpdate", ({ offer, previousState }) => {
    if (previousState === undefined) {
      console.log(`🔔 NEW ${tag(offer)} state=${stateName(offer.state)}`);
    } else {
      console.log(`🔁 ${tag(offer)} ${stateName(previousState)} -> ${stateName(offer.state)}`);
    }
  });
  bot.trade.on("debug", (m) => console.log("[poll]", m));
  bot.trade.on("pollFailure", (e) => console.log("[pollFailure]", e.message));

  console.log(`Polling every ${POLL_INTERVAL_MS / 1000}s — send/cancel a trade to see updates.\n`);
  bot.trade.startPolling({
    pollInterval: POLL_INTERVAL_MS,
    pollFullUpdateInterval: FULL_UPDATE_MS,
    pollData,
  });

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
