import { existsSync, readFileSync } from "node:fs";
import { decodeJwt, SteamMobile } from "../src/index.js";

async function main() {
  console.log("\n=== M1: live getTradeOffers through our own HttpClient ===\n");
  if (!existsSync("./bot.refreshtoken")) throw new Error("missing ./bot.refreshtoken");
  const refreshToken = readFileSync("./bot.refreshtoken", "utf8").trim();

  const bot = await new SteamMobile({ refreshToken }).login();
  bot.on("debug", (m) => console.log("[debug]", m));
  bot.on("refreshToken", () => console.log("[event] refreshToken emitted"));

  console.log(`steamID: ${bot.steamID.getSteamID64()}`);
  const aud = decodeJwt(bot.accessToken ?? "")?.aud ?? [];
  console.log(`access token aud: [${aud.join(",")}]`);

  const { sent, received } = await bot.trade.getOffers();
  console.log(`getOffers OK — sent=${sent.length} received=${received.length}`);

  const pass = aud.includes("web") && aud.includes("mobile") && Array.isArray(sent);
  console.log(`\n${pass ? "✅ M1 PASS" : "❌ M1 FAIL"}\n`);
  await bot.shutdown();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ M1 FAIL:", err?.message ?? err);
  process.exit(1);
});
