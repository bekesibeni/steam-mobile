import { writeFileSync } from "node:fs";
import { loginWithCredentials, SteamMobile } from "../src/index.js";
import { decodeJwt } from "../src/session/tokens.js";
import { STEAM } from "./env.js";

// First-time setup: credential login (username + password + TOTP) → save ./bot.refreshtoken,
// which every other debug script reuses. Run this when you have no token, or it was revoked.
async function main(): Promise<void> {
  console.log("\n=== bootstrap: credential login ===\n");
  const r = await loginWithCredentials({
    username: STEAM.username,
    password: STEAM.password,
    sharedSecret: STEAM.sharedSecret,
    ...(STEAM.proxy ? { proxy: STEAM.proxy } : {}),
  });
  writeFileSync("./bot.refreshtoken", r.refreshToken);
  const aud = (decodeJwt(r.refreshToken)?.aud ?? []) as string[];
  console.log(`logged in as ${r.username} (${r.steamId})`);
  console.log(`refresh token aud=[${aud.join(",")}] — saved to ./bot.refreshtoken`);
  if (!aud.includes("mobile")) throw new Error("token is not MobileApp-audience");

  const bot = await new SteamMobile({
    refreshToken: r.refreshToken,
    ...(STEAM.proxy ? { proxy: STEAM.proxy } : {}),
  }).login();
  const { sent, received } = await bot.trade.getTradeOffers();
  console.log(
    `mint OK — getTradeOffers returned ${sent.length} sent + ${received.length} received`,
  );
  await bot.shutdown();
  console.log("\n✅ bootstrap done\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ bootstrap FAIL:", (e as Error)?.message ?? e);
  process.exit(1);
});
