import { existsSync, readFileSync } from "node:fs";
import { type EconItem, SteamMobile } from "../src/index.js";

const PUBLIC_STEAMID = "76561199832377078";
const PARTNER_STEAMID = "76561199832930275";

const floatOf = (i: EconItem) => i.asset_properties.find((p) => p.propertyid === 2)?.float_value;
const seedOf = (i: EconItem) => i.asset_properties.find((p) => p.propertyid === 1)?.int_value;

async function main() {
  console.log("\n=== M2: live getInventory through our own HttpClient ===\n");
  if (!existsSync("./bot.refreshtoken")) throw new Error("missing ./bot.refreshtoken");
  const refreshToken = readFileSync("./bot.refreshtoken", "utf8").trim();

  const bot = await SteamMobile.fromRefreshToken(refreshToken);
  bot.on("debug", (m) => console.log("[debug]", m));

  const cs2 = await bot.community.getInventory(730, "2", { steamId: PUBLIC_STEAMID });
  const withFloat = cs2.filter((i) => floatOf(i) !== undefined);
  console.log(`CS2 730/2: ${cs2.length} items, ${withFloat.length} with float`);
  const sample = withFloat[0];
  if (sample) {
    console.log(`  e.g. ${sample.market_hash_name} — seed=${seedOf(sample)} float=${floatOf(sample)}`);
  }

  const rust = await bot.community.getInventory(252490, "2", { steamId: PUBLIC_STEAMID });
  console.log(
    `Rust 252490/2: ${rust.length} items (e.g. ${rust[0]?.market_hash_name} x${rust[0]?.amount})`,
  );

  const partner = await bot.trade.getInventory({ steamId: PARTNER_STEAMID }, 730, "2");
  const partnerFloat = partner.filter((i) => floatOf(i) !== undefined);
  console.log(`Partner 730/2 (via /partnerinventory/): ${partner.length} items, ${partnerFloat.length} with float`);
  const psample = partnerFloat[0];
  if (psample) console.log(`  e.g. ${psample.market_hash_name} — float=${floatOf(psample)}`);

  const pass = cs2.length > 0 && withFloat.length > 0 && partner.length > 0;
  console.log(`\n${pass ? "✅ M2 PASS" : "❌ M2 FAIL"}\n`);
  await bot.shutdown();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ M2 FAIL:", err?.message ?? err);
  process.exit(1);
});
