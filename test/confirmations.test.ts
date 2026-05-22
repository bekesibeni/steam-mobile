import SteamID from "steamid";
import { describe, expect, it } from "vitest";
import { ConfirmationManager } from "../src/community/confirmations.js";
import { EConfirmationType } from "../src/core/enums.js";
import { ConfirmationError } from "../src/core/errors.js";
import type { HttpClient } from "../src/http/HttpClient.js";

interface Recorded {
  url: string;
  searchParams: Record<string, unknown> | undefined;
}

class FakeHttp {
  calls: Recorded[] = [];
  private body: unknown = {};

  setBody(body: unknown): void {
    this.body = body;
  }

  async getSessionId(): Promise<string> {
    return "sess";
  }

  async get(url: string, opts: { searchParams?: Record<string, unknown> }) {
    this.calls.push({ url, searchParams: opts.searchParams });
    return { statusCode: 200, headers: {}, body: this.body };
  }
}

const STEAM_ID = new SteamID("76561198000000000");

describe("ConfirmationManager.getConfirmations", () => {
  it("parses the getlist response and sets request params", async () => {
    const http = new FakeHttp();
    http.setBody({
      success: true,
      conf: [
        {
          id: "12345",
          type: EConfirmationType.Trade,
          creator_id: "9001",
          nonce: "nonceval",
          type_name: "Trade Offer",
          headline: "With PlayerX",
          summary: ["You give 2 items", "You receive 1 item"],
          creation_time: 1700000000,
          icon: "https://img",
        },
      ],
    });
    const mgr = new ConfirmationManager(http as unknown as HttpClient, STEAM_ID, "secret");

    const confs = await mgr.getConfirmations(1700000000, "thekey");
    expect(confs).toHaveLength(1);
    const c = confs[0]!;
    expect(c.id).toBe("12345");
    expect(c.creator).toBe("9001");
    expect(c.key).toBe("nonceval");
    expect(c.sending).toBe("You give 2 items");
    expect(c.receiving).toBe("You receive 1 item");
    expect(c.timestamp).toEqual(new Date(1700000000 * 1000));

    const params = http.calls[0]!.searchParams!;
    expect(http.calls[0]!.url).toBe("https://steamcommunity.com/mobileconf/getlist");
    expect(params.m).toBe("react");
    expect(params.tag).toBe("conf");
    expect(params.k).toBe("thekey");
    expect(params.t).toBe(1700000000);
    expect(params.a).toBe(STEAM_ID.getSteamID64());
    expect(String(params.p)).toMatch(/^android:/);
  });

  it("uses the tag from a key object", async () => {
    const http = new FakeHttp();
    http.setBody({ success: true, conf: [] });
    const mgr = new ConfirmationManager(http as unknown as HttpClient, STEAM_ID, "secret");
    await mgr.getConfirmations(123, { tag: "list", key: "k2" });
    expect(http.calls[0]!.searchParams!.tag).toBe("list");
    expect(http.calls[0]!.searchParams!.k).toBe("k2");
  });

  it("throws ConfirmationError when success is false", async () => {
    const http = new FakeHttp();
    http.setBody({ success: false, message: "Oops" });
    const mgr = new ConfirmationManager(http as unknown as HttpClient, STEAM_ID, "secret");
    await expect(mgr.getConfirmations(1, "k")).rejects.toThrow(/Oops/);
  });
});

describe("ConfirmationManager.acceptConfirmationForObject", () => {
  it("requires an identitySecret", async () => {
    const http = new FakeHttp();
    const mgr = new ConfirmationManager(http as unknown as HttpClient, STEAM_ID, undefined);
    await expect(mgr.acceptConfirmationForObject("999")).rejects.toBeInstanceOf(ConfirmationError);
    expect(http.calls).toHaveLength(0);
  });
});
