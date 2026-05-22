import { existsSync, readFileSync } from "node:fs";
import { SteamMobile } from "../src/index.js";

// Loads ./.env (KEY=VALUE) so IDENTITY_SECRET etc. are available without a runner flag.
function loadEnv(): void {
  if (!existsSync("./.env")) return;
  for (const line of readFileSync("./.env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m?.[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    }
  }
}

async function main() {
  console.log("\n=== M3: TradeOffer lifecycle (read-only unless flagged) ===\n");
  loadEnv();
  if (!existsSync("./bot.refreshtoken")) throw new Error("missing ./bot.refreshtoken");
  const refreshToken = readFileSync("./bot.refreshtoken", "utf8").trim();

  const identitySecret = process.env.IDENTITY_SECRET;
  const partnerTradeUrl = process.env.PARTNER_TRADE_URL; // for checkUser + send target
  const offerId = process.env.OFFER_ID; // for getTradeOffer
  const doSend = process.env.SEND === "1"; // destructive: requires PARTNER_TRADE_URL + GIVE_ASSETID
  const doConfirm = process.env.CONFIRM === "1"; // confirm the just-sent offer
  const doCancel = process.env.CANCEL === "1"; // cancel the just-sent offer

  const bot = await SteamMobile.fromRefreshToken(refreshToken, {
    ...(identitySecret ? { identitySecret } : {}),
  });
  bot.on("debug", (m) => console.log("[debug]", m));

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
      `getTradeOffer #${offer.id}: state=${offer.state} ours=${offer.isOurOffer} ` +
        `give=${offer.itemsToGive.length} receive=${offer.itemsToReceive.length}`,
    );
  } else {
    console.log("getTradeOffer: skipped (set OFFER_ID)");
  }

  // --- send / confirm / cancel — DESTRUCTIVE, opt-in ---
  if (doSend) {
    if (!partnerTradeUrl) throw new Error("SEND=1 needs PARTNER_TRADE_URL");
    const giveAssetId = process.env.GIVE_ASSETID;
    const giveAppId = Number(process.env.GIVE_APPID ?? 730);
    const giveContextId = process.env.GIVE_CONTEXTID ?? "2";
    if (!giveAssetId) throw new Error("SEND=1 needs GIVE_ASSETID");

    const offer = bot.trade.createOffer({ tradeUrl: partnerTradeUrl });
    offer
      .give([{ appid: giveAppId, contextid: giveContextId, assetid: giveAssetId }])
      .setMessage("steam-mobile M3 live test");
    const result = await offer.send();
    console.log(`send: ${result} (offerId=${offer.id})`);

    if (result === "needs_confirmation" && doConfirm) {
      await offer.confirm();
      console.log("confirm: ok");
    }
    if (doCancel) {
      await offer.cancel();
      console.log("cancel: ok");
    }
  } else {
    console.log("send/confirm/cancel: skipped (set SEND=1 GIVE_ASSETID …)");
  }

  console.log("\n✅ M3 live script done\n");
  await bot.shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ M3 FAIL:", err?.message ?? err);
  process.exit(1);
});
