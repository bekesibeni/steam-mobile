import { existsSync, readFileSync } from "node:fs";
import { SteamMobile, decodeJwt } from "../src/index.js";

async function main() {
  console.log("\n=== M1: live getTradeOffers through our own HttpClient ===\n");
  if (!existsSync("./bot.refreshtoken")) throw new Error("missing ./bot.refreshtoken");
  const refreshToken = readFileSync("./bot.refreshtoken", "utf8").trim();

  const bot = await SteamMobile.fromRefreshToken(refreshToken);
  bot.on("debug", (m) => console.log("[debug]", m));
  bot.on("refreshToken", () => console.log("[event] refreshToken emitted"));

  console.log(`steamID: ${bot.steamID.getSteamID64()}`);
  const aud = decodeJwt(bot.accessToken ?? "")?.aud ?? [];
  console.log(`access token aud: [${aud.join(",")}]`);

  const offers = await bot.trade.getTradeOffers();
  const sent = offers.trade_offers_sent?.length ?? 0;
  const received = offers.trade_offers_received?.length ?? 0;
  console.log(`getTradeOffers OK — sent=${sent} received=${received}`);

  const pass = aud.includes("web") && aud.includes("mobile") && typeof offers === "object";
  console.log(`\n${pass ? "✅ M1 PASS" : "❌ M1 FAIL"}\n`);
  await bot.shutdown();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ M1 FAIL:", err?.message ?? err);
  process.exit(1);
});
