import { PrivateInventoryError } from "../src/index.js";
import { login } from "./login.js";

// Read partner inventory via /partnerinventory/ (bot.trade.getInventory).
//   PARTNER_TRADE_URL=https://…   required
//   APPID / CONTEXTID             defaults: 730 / 2
//   TRADABLE_ONLY=1               filter to tradable items only
//   LIMIT=20                      how many items to print (default 20)
async function main(): Promise<void> {
  const partnerTradeUrl = process.env.PARTNER_TRADE_URL;
  if (!partnerTradeUrl) throw new Error("set PARTNER_TRADE_URL");
  const appid = Number(process.env.APPID ?? 730);
  const contextid = process.env.CONTEXTID ?? "2";
  const tradableOnly = process.env.TRADABLE_ONLY === "1";
  const limit = Number(process.env.LIMIT ?? 20);

  console.log(`\n=== trade.getInventory ${appid}/${contextid}${tradableOnly ? " tradableOnly" : ""} ===\n`);
  const { bot } = await login();

  try {
    const items = await bot.trade.getInventory({ tradeUrl: partnerTradeUrl }, appid, contextid, { tradableOnly });
    console.log(items);
  } catch (e) {
    console.log(e)
    if (e instanceof PrivateInventoryError) {
      console.log(`partner inventory is private: ${e.message}`);
    } else {
      throw e;
    }
  }
  await bot.shutdown();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ partnerInventory FAIL:", (e as Error)?.message ?? e);
  process.exit(1);
});
