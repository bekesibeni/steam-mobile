import { EConfirmationMethod, ETradeOfferState, type TradeOffer } from "../src/index.js";

// Plain, fully-detailed view of an offer (items expand to full EconItems: names, props, stickers…).
export function offerToPlain(o: TradeOffer): Record<string, unknown> {
  return {
    id: o.id,
    partner: o.partner.getSteamID64(),
    state: `${ETradeOfferState[o.state] ?? o.state} (${o.state})`,
    isOurOffer: o.isOurOffer,
    message: o.message,
    tradeID: o.tradeID,
    confirmationMethod: `${EConfirmationMethod[o.confirmationMethod] ?? o.confirmationMethod} (${o.confirmationMethod})`,
    token: o.token,
    glitched: o.glitched,
    fromRealTimeTrade: o.fromRealTimeTrade,
    created: o.created,
    updated: o.updated,
    expires: o.expires,
    escrowEnds: o.escrowEnds,
    itemsToReceive: o.itemsToReceive,
    itemsToGive: o.itemsToGive,
  };
}

export function dumpOffer(label: string, o: TradeOffer): void {
  console.log(`\n${label} #${o.id} from ${o.partner.getSteamID64()}`);
  console.log(JSON.stringify(offerToPlain(o), null, 2));
}
