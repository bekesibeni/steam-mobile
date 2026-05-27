import { login } from "./login.js";

const CONFIG = {
  appid: 730,
  contextid: "2",
  limit: 20,
};

async function main(): Promise<void> {
  console.log(`\n=== community.getInventory ${CONFIG.appid}/${CONFIG.contextid} ===\n`);

  const { bot } = await login();

  const items = await bot.community.getInventory(CONFIG.appid, CONFIG.contextid);

  console.log(
    `got ${items.length} items, printing first ${Math.min(CONFIG.limit, items.length)}:\n`,
  );
  console.log(items.slice(0, CONFIG.limit));

  await bot.shutdown();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ ownInventory FAIL:", (e as Error)?.message ?? e);
  process.exit(1);
});
