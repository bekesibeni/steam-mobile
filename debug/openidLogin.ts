import { login } from "./login.js";

// Smoke test for Steam OpenID relying-party login. Pass the site's "Sign in through Steam" entry URL
// (and optionally the host whose cookies to print):
//   pnpm openid-login -- "https://csgoempire.com/login?page_url=%2Fprofile" csgoempire.com
async function main(): Promise<void> {
  const initiateUrl = process.argv[2];
  if (!initiateUrl) throw new Error("usage: tsx debug/openidLogin.ts <initiateUrl> [cookieHost]");
  const cookieHost = process.argv[3];

  console.log("\n=== smoke: openid relying-party login ===\n");
  const { bot, steamID } = await login();
  console.log(`bot: ${steamID}\n`);

  const result = await bot.openidLogin({
    initiateUrl,
    ...(cookieHost ? { cookieHost } : {}),
  });
  console.log(`✅ steamId:  ${result.steamId} (match=${result.steamId === steamID})`);
  console.log(`✅ finalUrl: ${result.finalUrl}`);
  console.log(`✅ cookies:  ${result.cookies.map((c) => c.name).join(", ") || "(none)"}`);

  await bot.shutdown();
  console.log("\n✅ openid smoke done\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ openid smoke FAIL:", (e as Error)?.message ?? e);
  process.exit(1);
});
