import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loginWithCredentials, SteamMobile } from "../src/index.js";
import { STEAM } from "./env.js";

const REFRESH_TOKEN_FILE = "./bot.refreshtoken";

export interface DebugLogin {
  bot: SteamMobile;
  steamID: string;
  accessToken: string;
  refreshToken: string;
  cookieHeader: string;
}

// Shared debug login (the single place that knows how to authenticate). Reuses a saved refresh
// token if present, otherwise credential-logs-in via our own auth layer (TOTP from the shared
// secret) and saves it. Returns a ready SteamMobile plus the bits raw-fetch probes need:
// access token, steamID, and a steamcommunity cookie header.
export async function login(): Promise<DebugLogin> {
  let refreshToken = "";
  if (existsSync(REFRESH_TOKEN_FILE)) {
    refreshToken = readFileSync(REFRESH_TOKEN_FILE, "utf8").trim();
  }

  if (refreshToken) {
    console.log("[login] using saved refresh token");
  } else {
    const r = await loginWithCredentials({
      username: STEAM.username,
      password: STEAM.password,
      sharedSecret: STEAM.sharedSecret,
      ...(STEAM.proxy ? { proxy: STEAM.proxy } : {}),
    });
    refreshToken = r.refreshToken;
    writeFileSync(REFRESH_TOKEN_FILE, refreshToken);
    console.log("[login] credential login OK — refresh token saved");
  }

  const bot = new SteamMobile({
    refreshToken,
    ...(STEAM.proxy ? { proxy: STEAM.proxy } : {}),
    ...(STEAM.identitySecret ? { identitySecret: STEAM.identitySecret } : {}),
  });
  await bot.login();
  await bot.http.getSessionId(); // ensure a sessionid cookie for steamcommunity endpoints
  const cookieHeader = await bot.http.jar.getCookieString("https://steamcommunity.com");

  return {
    bot,
    steamID: bot.steamID.getSteamID64(),
    accessToken: bot.accessToken ?? "",
    refreshToken: bot.refreshToken,
    cookieHeader,
  };
}


login().catch((e) => {
  console.error("\n❌ partnerInventory FAIL:", (e as Error)?.message ?? e);
  process.exit(1);
});
