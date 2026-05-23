import { describe, expect, it } from "vitest";
import { ETradeStatus } from "../src/core/enums.js";
import type { WebApiClient } from "../src/http/webApi.js";
import { getTradeHistory, getTradeOffersSummary, getTradeStatus } from "../src/trade/exchange.js";

function fakeApi(body: unknown): WebApiClient {
  return { call: async () => body } as unknown as WebApiClient;
}

describe("getTradeStatus", () => {
  it("parses status/time/items and surfaces new_assetid from the descriptions map", async () => {
    const body = {
      response: {
        trades: [
          {
            tradeid: "T1",
            status: ETradeStatus.Complete,
            time_init: 1700000000,
            time_settlement: 1700086400,
            assets_received: [
              {
                appid: 252490,
                contextid: "2",
                assetid: "111",
                classid: "9",
                instanceid: "0",
                amount: "1",
                new_assetid: "999",
                new_contextid: "2",
              },
            ],
            assets_given: [
              {
                appid: 730,
                contextid: "2",
                assetid: "222",
                classid: "5",
                instanceid: "0",
                amount: "1",
              },
            ],
          },
        ],
        descriptions: [
          {
            appid: 252490,
            classid: "9",
            instanceid: "0",
            market_hash_name: "Metal Door",
            tradable: 1,
          },
          {
            appid: 730,
            classid: "5",
            instanceid: "0",
            market_hash_name: "AK-47 | Redline",
            tradable: 1,
          },
        ],
      },
    };

    const ex = await getTradeStatus(fakeApi(body), "T1");

    expect(ex.status).toBe(ETradeStatus.Complete);
    expect(ex.tradeInitTime).toEqual(new Date(1700000000 * 1000));
    expect(ex.settlementTime).toEqual(new Date(1700086400 * 1000));
    expect(ex.usedInventoryFallback).toBe(false);

    const r = ex.receivedItems[0]!;
    expect(r.market_hash_name).toBe("Metal Door");
    expect(r.assetid).toBe("111");
    expect(r.new_assetid).toBe("999");
    expect(r.new_contextid).toBe("2");

    const g = ex.sentItems[0]!;
    expect(g.market_hash_name).toBe("AK-47 | Redline");
    expect(g.new_assetid).toBeUndefined();
  });

  it("picks the matching tradeid when several are returned", async () => {
    const body = {
      response: {
        trades: [
          { tradeid: "OTHER", status: ETradeStatus.Failed, time_init: 1 },
          { tradeid: "T2", status: ETradeStatus.Complete, time_init: 2 },
        ],
      },
    };
    const ex = await getTradeStatus(fakeApi(body), "T2");
    expect(ex.status).toBe(ETradeStatus.Complete);
  });

  it("throws when no trade is returned", async () => {
    await expect(getTradeStatus(fakeApi({ response: { trades: [] } }), "T1")).rejects.toThrow(
      /not found/,
    );
  });
});

describe("getTradeHistory", () => {
  it("maps each trade with tradeId/partner + carries more/totalTrades", async () => {
    const body = {
      response: {
        more: true,
        total_trades: 42,
        trades: [
          {
            tradeid: "T9",
            steamid_other: "76561198000000001",
            status: ETradeStatus.Complete,
            time_init: 1700000000,
            assets_received: [
              {
                appid: 252490,
                contextid: "2",
                assetid: "1",
                classid: "9",
                instanceid: "0",
                amount: "1",
                new_assetid: "777",
              },
            ],
            assets_given: [],
          },
        ],
        descriptions: [
          { appid: 252490, classid: "9", instanceid: "0", market_hash_name: "Wood", tradable: 1 },
        ],
      },
    };
    const hist = await getTradeHistory(fakeApi(body), { maxTrades: 1, includeTotal: true });
    expect(hist.more).toBe(true);
    expect(hist.totalTrades).toBe(42);
    expect(hist.trades).toHaveLength(1);
    const t = hist.trades[0]!;
    expect(t.tradeId).toBe("T9");
    expect(t.partnerSteamId).toBe("76561198000000001");
    expect(t.status).toBe(ETradeStatus.Complete);
    expect(t.receivedItems[0]!.market_hash_name).toBe("Wood");
    expect(t.receivedItems[0]!.new_assetid).toBe("777");
  });

  it("defaults more=false and empty trades", async () => {
    const hist = await getTradeHistory(fakeApi({ response: {} }));
    expect(hist.more).toBe(false);
    expect(hist.trades).toEqual([]);
    expect(hist.totalTrades).toBeUndefined();
  });
});

describe("getTradeOffersSummary", () => {
  it("normalizes the count fields (missing → 0)", async () => {
    const s = await getTradeOffersSummary(
      fakeApi({ response: { pending_received_count: 3, pending_sent_count: 1 } }),
    );
    expect(s.pending_received_count).toBe(3);
    expect(s.pending_sent_count).toBe(1);
    expect(s.escrow_received_count).toBe(0);
    expect(s.historical_sent_count).toBe(0);
  });
});
