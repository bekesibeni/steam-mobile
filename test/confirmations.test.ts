import SteamID from "steamid";
import { describe, expect, it } from "vitest";
import { ConfirmationManager } from "../src/community/confirmations.js";
import { EConfirmationType } from "../src/core/enums.js";
import { ConfirmationError } from "../src/core/errors.js";
import { ANDROID_PROFILE, IOS_PROFILE } from "../src/core/mobileProfile.js";
import type { HttpClient } from "../src/http/HttpClient.js";

interface Recorded {
  url: string;
  searchParams: Record<string, unknown> | undefined;
  multipart?: { name: string; value: string }[] | undefined;
}

class FakeHttp {
  calls: Recorded[] = [];
  posts: Recorded[] = [];
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

  async post(
    url: string,
    opts: { searchParams?: Record<string, unknown>; multipart?: { name: string; value: string }[] },
  ) {
    this.posts.push({ url, searchParams: opts.searchParams, multipart: opts.multipart });
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
    const mgr = new ConfirmationManager(
      http as unknown as HttpClient,
      STEAM_ID,
      "secret",
      ANDROID_PROFILE,
    );

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

  it("sends a bare uppercase-UUID device id for the iOS profile", async () => {
    const http = new FakeHttp();
    http.setBody({ success: true, conf: [] });
    const mgr = new ConfirmationManager(
      http as unknown as HttpClient,
      STEAM_ID,
      "secret",
      IOS_PROFILE,
    );
    await mgr.getConfirmations(1, "k");
    expect(String(http.calls[0]!.searchParams!.p)).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
    );
  });

  it("uses the tag from a key object", async () => {
    const http = new FakeHttp();
    http.setBody({ success: true, conf: [] });
    const mgr = new ConfirmationManager(
      http as unknown as HttpClient,
      STEAM_ID,
      "secret",
      ANDROID_PROFILE,
    );
    await mgr.getConfirmations(123, { tag: "list", key: "k2" });
    expect(http.calls[0]!.searchParams!.tag).toBe("list");
    expect(http.calls[0]!.searchParams!.k).toBe("k2");
  });

  it("throws ConfirmationError when success is false", async () => {
    const http = new FakeHttp();
    http.setBody({ success: false, message: "Oops" });
    const mgr = new ConfirmationManager(
      http as unknown as HttpClient,
      STEAM_ID,
      "secret",
      ANDROID_PROFILE,
    );
    await expect(mgr.getConfirmations(1, "k")).rejects.toThrow(/Oops/);
  });
});

describe("ConfirmationManager.respondToConfirmation", () => {
  it("POSTs to multiajaxop with multipart cid[]/ck[] and op in the query", async () => {
    const http = new FakeHttp();
    http.setBody({ success: true });
    const mgr = new ConfirmationManager(
      http as unknown as HttpClient,
      STEAM_ID,
      "secret",
      IOS_PROFILE,
    );

    await mgr.respondToConfirmation("777", "nonce777", 123, { tag: "accept", key: "kk" }, true);

    expect(http.posts).toHaveLength(1);
    const post = http.posts[0]!;
    expect(post.url).toBe("https://steamcommunity.com/mobileconf/multiajaxop");
    expect(post.searchParams!.op).toBe("allow");
    expect(post.searchParams!.tag).toBe("accept");
    expect(post.multipart).toEqual([
      { name: "cid[]", value: "777" },
      { name: "ck[]", value: "nonce777" },
    ]);
  });

  it("throws ConfirmationError when the action fails", async () => {
    const http = new FakeHttp();
    http.setBody({ success: false, message: "nope" });
    const mgr = new ConfirmationManager(
      http as unknown as HttpClient,
      STEAM_ID,
      "secret",
      ANDROID_PROFILE,
    );
    await expect(
      mgr.respondToConfirmation("1", "k", 1, { tag: "cancel", key: "kk" }, false),
    ).rejects.toThrow(/nope/);
  });
});

describe("ConfirmationManager.acceptConfirmationForObject", () => {
  it("requires an identitySecret", async () => {
    const http = new FakeHttp();
    const mgr = new ConfirmationManager(
      http as unknown as HttpClient,
      STEAM_ID,
      undefined,
      ANDROID_PROFILE,
    );
    await expect(mgr.acceptConfirmationForObject("999")).rejects.toBeInstanceOf(ConfirmationError);
    expect(http.calls).toHaveLength(0);
  });
});
