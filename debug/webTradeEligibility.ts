import { login } from "./login.js";

// Run Steam's web-trade eligibility check (bot.community.getWebTradeEligibility).
// Hits /market/eligibilitycheck/ and decodes the `webTradeEligibility` cookie Steam leaves behind.
async function main(): Promise<void> {
  console.log("\n=== community.getWebTradeEligibility ===\n");

  const { bot } = await login();

  const e = await bot.community.getWebTradeEligibility();
  console.log(e);

  const ts = (s: number) => (s ? new Date(s * 1000).toISOString() : "—");
  console.log(`\nallowed:              ${e.allowed === 1 ? "yes" : "no"} (${e.allowed})`);
  console.log(`reason:               ${e.reason}`);
  console.log(`allowed at:           ${ts(e.allowed_at_time)}`);
  console.log(`steamguard req days:  ${e.steamguard_required_days}`);
  console.log(`new-device cooldown:  ${e.new_device_cooldown_days} days`);
  console.log(`checked at:           ${ts(e.time_checked)}`);
  console.log(`expires:              ${ts(e.expiration)}`);

  await bot.shutdown();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ webTradeEligibility FAIL:", (e as Error)?.message ?? e);
  process.exit(1);
});
