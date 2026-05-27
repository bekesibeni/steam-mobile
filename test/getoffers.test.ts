import { describe, expect, it } from "vitest";
import { EOfferFilter, ETradeOfferState } from "../src/core/enums.js";
import type { RawCEconTradeOffer } from "../src/core/types.js";
import type { HttpClient } from "../src/http/HttpClient.js";
import type { ApiCallParams, WebApiClient } from "../src/http/webApi.js";
import type { EconItem, RawDescription } from "../src/models/EconItem.js";
import type { SessionManager } from "../src/session/SessionManager.js";
import { TradeNamespace } from "../src/trade/TradeNamespace.js";

interface FakeResponse {
  response?: Record<string, unknown>;
}

class FakeApi {
  calls: ApiCallParams[] = [];
  private queue: FakeResponse[] = [];
  queueResponse(r: FakeResponse): void {
    this.queue.push(r);
  }
  async call<T>(params: ApiCallParams): Promise<T> {
    this.calls.push(params);
    return (this.queue.shift() ?? {}) as T;
  }
}

function makeTrade(api: FakeApi): TradeNamespace {
  return new TradeNamespace(
    api as unknown as WebApiClient,
    {} as unknown as HttpClient,
    { async getAccessToken() {} } as unknown as SessionManager,
    {} as never,
  );
}

function rawOffer(
  id: string,
  items = [
    { appid: 730, contextid: "2", assetid: `a${id}`, classid: "c1", instanceid: "0", amount: "1" },
  ],
): RawCEconTradeOffer {
  return {
    tradeofferid: id,
    accountid_other: 46143802,
    trade_offer_state: ETradeOfferState.Active,
    is_our_offer: false,
    from_real_time_trade: false,
    time_created: 1_700_000_000,
    time_updated: 1_700_000_000,
    expiration_time: 0,
    escrow_end_date: 0,
    confirmation_method: 0,
    items_to_give: items,
  } as unknown as RawCEconTradeOffer;
}

function desc(name: string): RawDescription {
  return { appid: 730, classid: "c1", instanceid: "0", name, market_hash_name: name };
}

describe("TradeNamespace.getOffers", () => {
  it("cursor-paginates and inlines descriptions onto items", async () => {
    const api = new FakeApi();
    api.queueResponse({
      response: {
        trade_offers_sent: [rawOffer("1")],
        descriptions: [desc("AK-47")],
        next_cursor: 5,
      },
    });
    api.queueResponse({
      response: { trade_offers_received: [rawOffer("2")], next_cursor: 0 },
    });
    const trade = makeTrade(api);

    const { sent, received } = await trade.getTradeOffers(EOfferFilter.All);

    expect(sent).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect((sent[0]!.itemsToGive[0] as EconItem).name).toBe("AK-47");
    expect((received[0]!.itemsToGive[0] as EconItem).name).toBe("AK-47");
    expect(sent[0]!.glitched).toBe(false);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.input?.cursor).toBe(5);
  });

  it("flags an offer as glitched when its item description is missing", async () => {
    const api = new FakeApi();
    api.queueResponse({ response: { trade_offers_sent: [rawOffer("3")], next_cursor: 0 } });
    const trade = makeTrade(api);

    const { sent } = await trade.getTradeOffers();
    expect(sent[0]!.glitched).toBe(true);
  });

  it("does not flag a terminal offer as glitched when its item description is missing", async () => {
    const api = new FakeApi();
    const declined = {
      ...rawOffer("7"),
      trade_offer_state: ETradeOfferState.Declined,
    } as unknown as RawCEconTradeOffer;
    api.queueResponse({ response: { trade_offers_sent: [declined], next_cursor: 0 } });
    const trade = makeTrade(api);

    const { sent } = await trade.getTradeOffers();
    // Steam omits descriptions for dead offers; deferring would strand the Active->Declined change.
    expect(sent[0]!.glitched).toBe(false);
  });

  it("throws on a wholly-malformed response (data temporarily unavailable)", async () => {
    const api = new FakeApi();
    const broken = { ...rawOffer("4"), accountid_other: 0 } as unknown as RawCEconTradeOffer;
    api.queueResponse({ response: { trade_offers_received: [broken], next_cursor: 0 } });
    const trade = makeTrade(api);

    await expect(trade.getTradeOffers()).rejects.toThrow(/temporarily unavailable/);
  });

  it("drops malformed items but keeps the offer (when the batch isn't wholly malformed)", async () => {
    const api = new FakeApi();
    const dirty = rawOffer("5", [
      { appid: 730, contextid: "2", assetid: "good", classid: "c1", instanceid: "0", amount: "1" },
      { appid: 0, contextid: "", assetid: "", classid: "c1", instanceid: "0", amount: "1" },
    ]);
    api.queueResponse({
      response: {
        trade_offers_sent: [dirty, rawOffer("6")], // a clean offer keeps the batch valid
        descriptions: [desc("AK-47")],
        next_cursor: 0,
      },
    });
    const trade = makeTrade(api);

    const { sent } = await trade.getTradeOffers();
    const offer5 = sent.find((o) => o.id === "5")!;
    expect(offer5.itemsToGive).toHaveLength(1);
    expect(offer5.itemsToGive[0]!.assetid).toBe("good");
  });
});

describe("TradeNamespace.getOffers settlement fields", () => {
  it("maps settlement_date/delay_settlement onto an accepted trade-protected offer", async () => {
    const api = new FakeApi();
    const accepted = {
      ...rawOffer("30"),
      trade_offer_state: ETradeOfferState.Accepted,
      tradeid: "732542373858598729",
      delay_settlement: true,
      settlement_date: 1_780_210_800,
    } as unknown as RawCEconTradeOffer;
    api.queueResponse({
      response: {
        trade_offers_received: [accepted],
        descriptions: [desc("AK-47")],
        next_cursor: 0,
      },
    });

    const { received } = await makeTrade(api).getTradeOffers();
    expect(received[0]!.delaySettlement).toBe(true);
    expect(received[0]!.settlementDate).toEqual(new Date(1_780_210_800 * 1000));
  });

  it("leaves settlementDate undefined when settlement_date is 0 (not yet settled / no protection)", async () => {
    const api = new FakeApi();
    const unsettled = {
      ...rawOffer("31"),
      delay_settlement: false,
      settlement_date: 0,
    } as unknown as RawCEconTradeOffer;
    api.queueResponse({
      response: { trade_offers_sent: [unsettled], descriptions: [desc("AK-47")], next_cursor: 0 },
    });

    const { sent } = await makeTrade(api).getTradeOffers();
    expect(sent[0]!.delaySettlement).toBe(false);
    expect(sent[0]!.settlementDate).toBeUndefined();
  });
});

describe("TradeNamespace.reconcile", () => {
  it("returns found offers and skips missing ones", async () => {
    const api = new FakeApi();
    api.queueResponse({ response: { offer: rawOffer("10") } });
    api.queueResponse({ response: {} }); // no offer → getTradeOffer throws → skipped
    const trade = makeTrade(api);

    const map = await trade.reconcile(["10", "11"]);
    expect(map.size).toBe(1);
    expect(map.get("10")?.id).toBe("10");
  });
});

describe("TradeNamespace.getOffersContainingItems", () => {
  it("returns only offers that contain every requested item", async () => {
    const api = new FakeApi();
    api.queueResponse({
      response: {
        trade_offers_sent: [rawOffer("20")], // contains a20
        trade_offers_received: [rawOffer("21")], // contains a21
        next_cursor: 0,
      },
    });
    const trade = makeTrade(api);

    const offers = await trade.getOffersContainingItems([
      { appid: 730, contextid: "2", assetid: "a20" },
    ]);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.id).toBe("20");
  });
});
