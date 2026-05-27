import SteamID from "steamid";
import { describe, expect, it } from "vitest";
import type { ConfirmationManager } from "../src/community/confirmations.js";
import { EConfirmationMethod, ETradeOfferState } from "../src/core/enums.js";
import { OfferLimitError, SteamError, TradeBanError } from "../src/core/errors.js";
import type { HttpClient } from "../src/http/HttpClient.js";
import type { SessionManager } from "../src/session/SessionManager.js";
import type { TradeNamespace } from "../src/trade/TradeNamespace.js";
import { TradeOffer, type TradeOfferDeps } from "../src/trade/TradeOffer.js";

interface Recorded {
  method: string;
  url: string;
  form: Record<string, unknown> | undefined;
  referer: string | undefined;
}

interface FakeResponse {
  statusCode?: number;
  body?: unknown;
}

class FakeHttp {
  calls: Recorded[] = [];
  private queue: FakeResponse[] = [];

  queueResponse(res: FakeResponse): void {
    this.queue.push(res);
  }

  async getSessionId(): Promise<string> {
    return "sess123";
  }

  async post(url: string, opts: { form?: Record<string, unknown>; referer?: string }) {
    // The 2025 trade-protection ack is a pass-through preflight; don't consume the queued response.
    if (url.endsWith("/trade/new/acknowledge")) {
      return { statusCode: 200, headers: {}, body: {} };
    }
    this.calls.push({ method: "POST", url, form: opts.form, referer: opts.referer });
    const res = this.queue.shift() ?? {};
    return { statusCode: res.statusCode ?? 200, headers: {}, body: res.body ?? {} };
  }
}

const PARTNER = SteamID.fromIndividualAccountID(46143802);

function makeDeps(http: FakeHttp, trade: Record<string, unknown> = {}): TradeOfferDeps {
  return {
    http: http as unknown as HttpClient,
    session: { async getAccessToken() {} } as unknown as SessionManager,
    confirmations: {
      async acknowledgeTradeProtection() {},
    } as unknown as ConfirmationManager,
    trade: trade as unknown as TradeNamespace,
  };
}

describe("TradeOffer.send", () => {
  it("builds the json_tradeoffer/form and returns 'sent'", async () => {
    const http = new FakeHttp();
    http.queueResponse({ body: { tradeofferid: "777" } });
    const offer = new TradeOffer(makeDeps(http), { partner: PARTNER, token: "AbCdEfG" });
    offer
      .give([{ appid: 730, contextid: "2", assetid: "111" }])
      .receive([{ appid: 730, contextid: "2", assetid: "222", amount: 3 }])
      .setMessage("gg");

    const result = await offer.send();
    expect(result).toBe("sent");
    expect(offer.id).toBe("777");
    expect(offer.state).toBe(ETradeOfferState.Active);

    const call = http.calls[0]!;
    expect(call.url).toBe("https://steamcommunity.com/tradeoffer/new/send");
    expect(call.referer).toContain(`partner=${PARTNER.accountid}`);
    expect(call.referer).toContain("token=AbCdEfG");
    expect(call.form?.partner).toBe(PARTNER.getSteamID64());
    expect(call.form?.tradeoffermessage).toBe("gg");

    const offerData = JSON.parse(call.form?.json_tradeoffer as string);
    expect(offerData.newversion).toBe(true);
    expect(offerData.version).toBe(3);
    expect(offerData.me.assets).toEqual([
      { appid: 730, contextid: "2", amount: 1, assetid: "111" },
    ]);
    expect(offerData.them.assets).toEqual([
      { appid: 730, contextid: "2", amount: 3, assetid: "222" },
    ]);

    const createParams = JSON.parse(call.form?.trade_offer_create_params as string);
    expect(createParams.trade_offer_access_token).toBe("AbCdEfG");
  });

  it("returns 'needs_confirmation' on mobile confirmation", async () => {
    const http = new FakeHttp();
    http.queueResponse({ body: { tradeofferid: "888", needs_mobile_confirmation: true } });
    const offer = new TradeOffer(makeDeps(http), { partner: PARTNER });
    offer.give([{ appid: 730, contextid: "2", assetid: "1" }]);

    expect(await offer.send()).toBe("needs_confirmation");
    expect(offer.state).toBe(ETradeOfferState.CreatedNeedsConfirmation);
    expect(offer.confirmationMethod).toBe(EConfirmationMethod.MobileApp);
  });

  it("rejects an empty offer without hitting the network", async () => {
    const http = new FakeHttp();
    const offer = new TradeOffer(makeDeps(http), { partner: PARTNER });
    await expect(offer.send()).rejects.toThrow(/empty/);
    expect(http.calls).toHaveLength(0);
  });

  it("maps a trade-ban strError to TradeBanError", async () => {
    const http = new FakeHttp();
    http.queueResponse({
      body: {
        strError: "You cannot trade with PlayerX because they have a trade ban. (15)",
      },
    });
    const offer = new TradeOffer(makeDeps(http), { partner: PARTNER });
    offer.give([{ appid: 730, contextid: "2", assetid: "1" }]);
    await expect(offer.send()).rejects.toBeInstanceOf(TradeBanError);
  });

  it("maps an offer-limit strError to OfferLimitError", async () => {
    const http = new FakeHttp();
    http.queueResponse({ body: { strError: "You have sent too many trade offers (25)" } });
    const offer = new TradeOffer(makeDeps(http), { partner: PARTNER });
    offer.give([{ appid: 730, contextid: "2", assetid: "1" }]);
    await expect(offer.send()).rejects.toBeInstanceOf(OfferLimitError);
  });
});

describe("TradeOffer.accept", () => {
  function received(http: FakeHttp, trade: Record<string, unknown>): TradeOffer {
    const offer = new TradeOffer(makeDeps(http, trade), { partner: PARTNER, id: "321" });
    offer.isOurOffer = false;
    offer.state = ETradeOfferState.Active;
    return offer;
  }

  it("returns 'accepted' when the re-fetch shows a settled trade", async () => {
    const http = new FakeHttp();
    http.queueResponse({ body: { tradeid: "t1" } });
    const offer = received(http, {
      async getTradeOffer() {
        return { state: ETradeOfferState.Accepted } as TradeOffer;
      },
    });
    expect(await offer.accept()).toBe("accepted");
    expect(offer.tradeID).toBe("t1");
    expect(http.calls[0]!.url).toBe("https://steamcommunity.com/tradeoffer/321/accept");
  });

  it("returns 'escrow' when the re-fetch shows a held trade", async () => {
    const http = new FakeHttp();
    http.queueResponse({ body: { tradeid: "t1" } });
    const offer = received(http, {
      async getTradeOffer() {
        return { state: ETradeOfferState.InEscrow, escrowEnds: new Date() } as TradeOffer;
      },
    });
    expect(await offer.accept()).toBe("escrow");
  });

  it("returns 'needs_confirmation' without re-fetching", async () => {
    const http = new FakeHttp();
    http.queueResponse({ body: { needs_mobile_confirmation: true } });
    let refetched = false;
    const offer = received(http, {
      async getTradeOffer() {
        refetched = true;
        return {} as TradeOffer;
      },
    });
    expect(await offer.accept()).toBe("needs_confirmation");
    expect(refetched).toBe(false);
  });

  it("falls back to 'accepted' if the re-fetch fails", async () => {
    const http = new FakeHttp();
    http.queueResponse({ body: { tradeid: "t1" } });
    const offer = received(http, {
      getTradeOffer(): Promise<TradeOffer> {
        return Promise.reject(new Error("network"));
      },
    });
    expect(await offer.accept()).toBe("accepted");
  });

  it("refuses to accept our own offer", async () => {
    const http = new FakeHttp();
    const offer = new TradeOffer(makeDeps(http), { partner: PARTNER, id: "321" });
    offer.isOurOffer = true;
    offer.state = ETradeOfferState.Active;
    await expect(offer.accept()).rejects.toThrow(/our own/);
    expect(http.calls).toHaveLength(0);
  });
});

describe("TradeOffer cancel/decline (community endpoint, always-on gate)", () => {
  it("our offer hits /cancel", async () => {
    const http = new FakeHttp();
    http.queueResponse({ body: { tradeofferid: "555" } });
    const offer = new TradeOffer(makeDeps(http), { partner: PARTNER, id: "555" });
    offer.isOurOffer = true;
    offer.state = ETradeOfferState.Active;

    await offer.cancel();
    expect(http.calls[0]!.url).toBe("https://steamcommunity.com/tradeoffer/555/cancel");
    expect(http.calls[0]!.form?.sessionid).toBe("sess123");
    expect(offer.state).toBe(ETradeOfferState.Canceled);
  });

  it("a received offer hits /decline", async () => {
    const http = new FakeHttp();
    http.queueResponse({ body: { tradeofferid: "555" } });
    const offer = new TradeOffer(makeDeps(http), { partner: PARTNER, id: "555" });
    offer.isOurOffer = false;
    offer.state = ETradeOfferState.Active;

    await offer.decline();
    expect(http.calls[0]!.url).toBe("https://steamcommunity.com/tradeoffer/555/decline");
    expect(offer.state).toBe(ETradeOfferState.Declined);
  });

  it("refuses to cancel an unsent offer", async () => {
    const http = new FakeHttp();
    const offer = new TradeOffer(makeDeps(http), { partner: PARTNER });
    await expect(offer.cancel()).rejects.toBeInstanceOf(SteamError);
    expect(http.calls).toHaveLength(0);
  });
});

describe("TradeOffer.fromData", () => {
  it("maps a raw received offer", () => {
    const http = new FakeHttp();
    const offer = TradeOffer.fromData(makeDeps(http), {
      tradeofferid: "9001",
      accountid_other: 46143802,
      message: "hi",
      expiration_time: 0,
      trade_offer_state: ETradeOfferState.Active,
      is_our_offer: false,
      time_created: 1700000000,
      time_updated: 1700000001,
      from_real_time_trade: false,
      escrow_end_date: 0,
      confirmation_method: 0,
      items_to_receive: [
        {
          appid: 730,
          contextid: "2",
          assetid: "42",
          classid: "1",
          instanceid: "0",
          amount: "1",
        },
      ],
    });
    expect(offer.id).toBe("9001");
    expect(offer.isOurOffer).toBe(false);
    expect(offer.partner.getSteamID64()).toBe(PARTNER.getSteamID64());
    expect(offer.itemsToReceive).toEqual([
      { appid: 730, contextid: "2", assetid: "42", amount: 1 },
    ]);
  });
});
