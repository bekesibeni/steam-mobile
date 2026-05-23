import { type EconItem, ETradeOfferState } from "../src/index.js";
import { login } from "./login.js";

// Destructive trade lifecycle test. Read-only unless SEND=1. Needs a NON-limited bot + a partner.
//   PARTNER_TRADE_URL=https://…   checkUser target + send target
//   SEND=1                        actually send → confirm → verify Active → cancel → verify Canceled
//   GIVE_APPID / GIVE_CONTEXTID / GIVE_ASSETID   item to give (defaults: 730 / 2 / auto-pick)
const stateName = (s: number) => ETradeOfferState[s] ?? String(s);

async function main(): Promise<void> {
  console.log("\n=== trade: send -> confirm -> verify -> cancel ===\n");
  const partnerTradeUrl = process.env.PARTNER_TRADE_URL;
  const doSend = process.env.SEND === "1";
  const giveAppId = Number(process.env.GIVE_APPID ?? 730);
  const giveContextId = process.env.GIVE_CONTEXTID ?? "2";

  const { bot } = await login();
  console.log(`bot: ${bot.steamID.getSteamID64()}  identitySecret: ${bot.identitySecret ? "set" : "MISSING"}`);

  if (partnerTradeUrl) {
    console.log("checkUser:", JSON.stringify(await bot.community.checkUser({ tradeUrl: partnerTradeUrl })));
  } else {
    console.log("checkUser: skipped (set PARTNER_TRADE_URL)");
  }

  if (!doSend) {
    console.log("\nsend/confirm/cancel: skipped (set SEND=1 PARTNER_TRADE_URL=…)\n");
    await bot.shutdown();
    process.exit(0);
  }
  if (!partnerTradeUrl) throw new Error("SEND=1 needs PARTNER_TRADE_URL");

  let giveAssetId = process.env.GIVE_ASSETID;
  if (!giveAssetId) {
    const inv = await bot.community.getInventory(giveAppId, giveContextId, { tradableOnly: true });
    const pick = inv[0] as EconItem | undefined;
    if (!pick) throw new Error(`no tradable item in bot ${giveAppId}/${giveContextId} inventory`);
    giveAssetId = pick.assetid;
    console.log(`auto-picked give item: ${pick.market_hash_name} (assetid=${giveAssetId})`);
  }

  const offer = bot.trade
    .createOffer({ tradeUrl: partnerTradeUrl })
    .give([{ appid: giveAppId, contextid: giveContextId, assetid: giveAssetId }])
    .setMessage("steam-mobile trade test");

  const result = await offer.send();
  console.log(`send: ${result} (offerId=${offer.id}, state=${stateName(offer.state)})`);
  if (result === "needs_confirmation") {
    await offer.confirm();
    console.log("confirm: ok");
  }

  const afterConfirm = await bot.trade.getTradeOffer(offer.id as string);
  const activeOk = afterConfirm.state === ETradeOfferState.Active;
  console.log(`after confirm: state=${stateName(afterConfirm.state)}`);

  await offer.cancel();
  const afterCancel = await bot.trade.getTradeOffer(offer.id as string);
  const canceledOk = afterCancel.state === ETradeOfferState.Canceled;
  console.log(`after cancel:  state=${stateName(afterCancel.state)}`);

  const pass = activeOk && canceledOk;
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} (Active=${activeOk}, Canceled=${canceledOk})\n`);
  await bot.shutdown();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("\n❌ trade FAIL:", (e as Error)?.message ?? e);
  process.exit(1);
});
