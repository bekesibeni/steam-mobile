import { existsSync, readFileSync } from "node:fs";
import { type EconItem, ETradeOfferState, SteamMobile } from "../src/index.js";

// Loads ./.env (KEY=VALUE) so STEAM_IDENTITY_SECRET etc. are available without a runner flag.
function loadEnv(): void {
  if (!existsSync("./.env")) return;
  for (const line of readFileSync("./.env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m?.[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    }
  }
}

const stateName = (s: number) => ETradeOfferState[s] ?? String(s);

async function main() {
  console.log("\n=== M3: TradeOffer dry-run (send -> confirm -> verify -> cancel) ===\n");
  loadEnv();
  if (!existsSync("./bot.refreshtoken")) throw new Error("missing ./bot.refreshtoken");
  const refreshToken = readFileSync("./bot.refreshtoken", "utf8").trim();

  const identitySecret = process.env.STEAM_IDENTITY_SECRET ?? process.env.IDENTITY_SECRET;
  const partnerTradeUrl = process.env.PARTNER_TRADE_URL; // checkUser + send target
  const offerId = process.env.OFFER_ID; // optional getTradeOffer read
  const doSend = process.env.SEND === "1"; // destructive opt-in (still cancels at the end)
  const giveAppId = Number(process.env.GIVE_APPID ?? 730);
  const giveContextId = process.env.GIVE_CONTEXTID ?? "2";

  const bot = await new SteamMobile({
    refreshToken,
    ...(identitySecret ? { identitySecret } : {}),
  }).login();
  bot.on("debug", (m) => console.log("[debug]", m));
  console.log(`bot steamID: ${bot.steamID.getSteamID64()}, identitySecret: ${identitySecret ? "set" : "MISSING"}`);

  // --- checkUser (escrow/probation scrape) — safe, read-only ---
  if (partnerTradeUrl) {
    const check = await bot.community.checkUser({ tradeUrl: partnerTradeUrl });
    console.log("checkUser:", JSON.stringify(check));
  } else {
    console.log("checkUser: skipped (set PARTNER_TRADE_URL)");
  }

  // --- getTradeOffer (read-by-id) — safe, read-only ---
  if (offerId) {
    const offer = await bot.trade.getTradeOffer(offerId);
    console.log(
      `getTradeOffer #${offer.id}: state=${stateName(offer.state)} ours=${offer.isOurOffer} ` +
        `give=${offer.itemsToGive.length} receive=${offer.itemsToReceive.length}`,
    );
  }

  // --- send -> confirm -> verify Active -> cancel -> verify Canceled — opt-in dry run ---
  if (doSend) {
    if (!partnerTradeUrl) throw new Error("SEND=1 needs PARTNER_TRADE_URL");

    let giveAssetId = process.env.GIVE_ASSETID;
    if (!giveAssetId) {
      const inv = await bot.community.getInventory(giveAppId, giveContextId, { tradableOnly: true });
      const pick = inv[0] as EconItem | undefined;
      if (!pick) throw new Error(`no tradable item in bot ${giveAppId}/${giveContextId} inventory`);
      giveAssetId = pick.assetid;
      console.log(`auto-picked give item: ${pick.market_hash_name} (assetid=${giveAssetId})`);
    }

    const offer = bot.trade.createOffer({ tradeUrl: partnerTradeUrl });
    offer
      .give([{ appid: giveAppId, contextid: giveContextId, assetid: giveAssetId }])
      .setMessage("steam-mobile M3 dry-run");

    const result = await offer.send();
    console.log(`\nsend: ${result} (offerId=${offer.id}, state=${stateName(offer.state)})`);

    if (result === "needs_confirmation") {
      await offer.confirm();
      console.log("confirm: ok");
    }

    // Read back the authoritative state — should be Active now.
    const afterConfirm = await bot.trade.getTradeOffer(offer.id as string);
    console.log(`read-back after confirm: state=${stateName(afterConfirm.state)}`);
    const activeOk = afterConfirm.state === ETradeOfferState.Active;

    await offer.cancel();
    console.log("cancel: ok");

    // Read back again — should be Canceled now.
    const afterCancel = await bot.trade.getTradeOffer(offer.id as string);
    console.log(`read-back after cancel:  state=${stateName(afterCancel.state)}`);
    const canceledOk = afterCancel.state === ETradeOfferState.Canceled;

    const pass = activeOk && canceledOk;
    console.log(`\n${pass ? "✅ M3 dry-run PASS" : "❌ M3 dry-run FAIL"} (Active=${activeOk}, Canceled=${canceledOk})\n`);
    await bot.shutdown();
    process.exit(pass ? 0 : 1);
  }

  console.log("\nsend/confirm/cancel: skipped (set SEND=1 PARTNER_TRADE_URL=…)\n");
  await bot.shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ M3 FAIL:", err?.message ?? err);
  process.exit(1);
});
