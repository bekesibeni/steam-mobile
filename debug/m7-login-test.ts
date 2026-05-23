/**
 * M7 Phase 2 live gate: credential login with our own (steam-session-free) auth layer.
 *
 *   1. loginWithCredentials({ accountName, password, sharedSecret })  → refresh token
 *   2. assert the refresh token's JWT aud includes "mobile"
 *   3. feed it into new SteamMobile({ refreshToken }) → login() → getTradeOffers() returns 200
 *
 * Run:  npm run m7
 */
import { loginWithCredentials, SteamMobile } from "../src/index.js";
import { decodeJwt } from "../src/session/tokens.js";
import { STEAM } from "./env.js";

async function main(): Promise<void> {
  console.log("\n=== M7: credential login (no steam-session) ===\n");

  const result = await loginWithCredentials({
    accountName: STEAM.username,
    password: STEAM.password,
    sharedSecret: STEAM.sharedSecret,
    ...(STEAM.proxy ? { proxy: STEAM.proxy } : {}),
  });

  const aud = decodeJwt(result.refreshToken)?.aud ?? [];
  console.log(`logged in as ${result.accountName} (${result.steamId})`);
  console.log(`refresh token aud=[${(aud as string[]).join(",")}]`);
  if (!(aud as string[]).includes("mobile")) {
    throw new Error("refresh token aud does NOT include 'mobile'");
  }
  console.log("✅ refresh token is MobileApp-audience");

  const bot = new SteamMobile({
    refreshToken: result.refreshToken,
    ...(STEAM.proxy ? { proxy: STEAM.proxy } : {}),
  });
  await bot.login();
  console.log(`minted access token aud=[${decodeJwt(bot.accessToken ?? "")?.aud ?? ""}]`);

  const offers = await bot.trade.getTradeOffers();
  console.log(`getTradeOffers OK — ${offers.length} offer(s)`);

  // Phase 3: list in-progress auth sessions (login-approval flows; usually 0). The gate is that it
  // returns a decoded protobuf array without error, not a particular count.
  const sessions = await bot.session.listSessions();
  console.log(`listSessions OK — ${sessions.length} pending auth session(s)`);
  if (!Array.isArray(sessions)) throw new Error("expected an array of client ids");

  // Phase 4: revoke THIS (throwaway) refresh token, then prove the session is dead.
  await bot.session.logout();
  console.log("logout OK — refresh token revoked");
  let blocked = false;
  try {
    await bot.session.getAccessToken();
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error("expected access to be blocked after logout");
  console.log("✅ post-logout access is blocked");

  await bot.shutdown();
  console.log("\n✅ M7 PHASES 2-4 PASS — login + listSessions + logout, no steam-session\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ FATAL:", err);
  process.exit(1);
});
