import { login } from "./login.js";

// Read-only health check: exercises the whole read surface against the saved token. Nothing here
// mutates state, so it's safe to run anytime. (Auto-bootstraps via credentials if no saved token.)
function summarize(r: unknown): string {
  if (Array.isArray(r)) return `${r.length} item(s)`;
  if (typeof r === "number") return String(r);
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    if ("personaName" in o)
      return `${o.personaName} · isLimited=${o.isLimited} · ban=${o.tradeBanState}`;
    if ("url" in o) return String(o.url);
    if ("pending_received_count" in o)
      return `received pending=${o.pending_received_count}, sent pending=${o.pending_sent_count}`;
    if ("trades" in o)
      return `${(o.trades as unknown[]).length} trade(s), more=${o.more}, total=${o.totalTrades}`;
    return JSON.stringify(r).slice(0, 80);
  }
  return String(r);
}

async function main(): Promise<void> {
  console.log("\n=== smoke: read-only health check ===\n");
  const { bot, steamID } = await login();
  console.log(`bot: ${steamID}\n`);

  const checks: [string, () => Promise<unknown>][] = [
    ["getProfile", () => bot.community.getProfile()],
    ["getSteamLevel", () => bot.community.getSteamLevel()],
    ["getTradeURL", () => bot.community.getTradeURL()],
    ["getTradeOffersSummary", () => bot.trade.getTradeOffersSummary()],
    ["getTradeOffers", () => bot.trade.getTradeOffers()],
    ["getTradeHistory", () => bot.trade.getTradeHistory({ maxTrades: 3, includeTotal: true })],
    ["listSessions", () => bot.session.listSessions()],
    ["getInventory(730/2)", () => bot.community.getInventory(730, "2")],
    ["ensureApiKey", () => bot.ensureApiKey()],
  ];
  for (const [name, fn] of checks) {
    try {
      console.log(`✅ ${name}: ${summarize(await fn())}`);
    } catch (e) {
      console.log(`❌ ${name}: ${(e as Error).message}`);
    }
  }

  // Settlement read on the most recent trade, if any.
  try {
    const hist = await bot.trade.getTradeHistory({ maxTrades: 1 });
    const t = hist.trades[0];
    if (!t) console.log("·  getTradeStatus: no trade history to check");
    else {
      const ex = await bot.trade.getTradeStatus({ tradeId: t.tradeId });
      console.log(
        `✅ getTradeStatus(${t.tradeId}): status=${ex.status} recv=${ex.receivedItems.length} sent=${ex.sentItems.length}`,
      );
    }
  } catch (e) {
    console.log(`❌ getTradeStatus: ${(e as Error).message}`);
  }

  await bot.shutdown();
  console.log("\n✅ smoke done\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ smoke FAIL:", (e as Error)?.message ?? e);
  process.exit(1);
});
