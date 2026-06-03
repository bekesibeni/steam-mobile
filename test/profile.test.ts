import SteamID from "steamid";
import { describe, expect, it } from "vitest";
import { CommunityNamespace } from "../src/community/CommunityNamespace.js";
import type { ConfirmationManager } from "../src/community/confirmations.js";
import type { HttpClient } from "../src/http/HttpClient.js";
import type { WebApiClient } from "../src/http/webApi.js";
import type { SessionManager } from "../src/session/SessionManager.js";

const SELF = new SteamID("76561198000000000");

class FakeHttp {
  posts: { url: string; form: unknown }[] = [];
  gets: string[] = [];
  constructor(
    private readonly text: string,
    private readonly postBody: unknown = {},
    private readonly cookies: Record<string, string> = {},
  ) {}
  async get(url: string) {
    this.gets.push(url);
    return { statusCode: 200, headers: {}, body: this.text };
  }
  async post(url: string, opts: { form?: unknown }) {
    this.posts.push({ url, form: opts.form });
    return { statusCode: 200, headers: {}, body: this.postBody };
  }
  async getCookie(key: string) {
    return this.cookies[key];
  }
  async getSessionId() {
    return "sess";
  }
}

function makeCommunity(
  text: string,
  postBody?: unknown,
  cookies?: Record<string, string>,
): {
  community: CommunityNamespace;
  http: FakeHttp;
} {
  const http = new FakeHttp(text, postBody, cookies);
  const session = { steamID: SELF, async getAccessToken() {} } as unknown as SessionManager;
  const community = new CommunityNamespace(
    http as unknown as HttpClient,
    session,
    {} as unknown as ConfirmationManager,
    {} as unknown as WebApiClient,
  );
  return { community, http };
}

const PROFILE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<profile>
  <steamID64>76561198000000000</steamID64>
  <steamID><![CDATA[CoolBot]]></steamID>
  <avatarFull><![CDATA[https://avatars.steamstatic.com/abc_full.jpg]]></avatarFull>
  <vacBanned>0</vacBanned>
  <tradeBanState>None</tradeBanState>
  <isLimitedAccount>1</isLimitedAccount>
  <memberSince>June 5, 2015</memberSince>
  <privacyState>public</privacyState>
</profile>`;

describe("CommunityNamespace.getProfile", () => {
  it("parses persona/avatar/limited/ban/created from the XML (single request)", async () => {
    const { community } = makeCommunity(PROFILE_XML);
    const p = await community.getProfile();
    expect(p.steamId).toBe("76561198000000000");
    expect(p.personaName).toBe("CoolBot");
    expect(p.avatar).toBe("https://avatars.steamstatic.com/abc_full.jpg");
    expect(p.isLimited).toBe(true);
    expect(p.vacBanned).toBe(false);
    expect(p.tradeBanState).toBe("None");
    expect(p.privacyState).toBe("public");
    expect(p.accountCreated?.getUTCFullYear()).toBe(2015);
  });

  it("throws when the XML is not a profile", async () => {
    const { community } = makeCommunity("<response><error>Profile not found</error></response>");
    await expect(community.getProfile()).rejects.toThrow();
  });
});

describe("CommunityNamespace.getWebTradeEligibility", () => {
  const COOKIE =
    "%7B%22allowed%22%3A0%2C%22reason%22%3A65536%2C%22allowed_at_time%22%3A1782467980%2C%22steamguard_required_days%22%3A15%2C%22new_device_cooldown_days%22%3A0%2C%22expiration%22%3A1780482531%2C%22time_checked%22%3A1780482231%7D";

  it("decodes the webTradeEligibility cookie 1:1", async () => {
    const { community, http } = makeCommunity("", {}, { webTradeEligibility: COOKIE });
    const e = await community.getWebTradeEligibility();
    expect(http.gets[0]).toBe("https://steamcommunity.com/market/eligibilitycheck/");
    expect(e).toEqual({
      allowed: 0,
      reason: 65536,
      allowed_at_time: 1782467980,
      steamguard_required_days: 15,
      new_device_cooldown_days: 0,
      expiration: 1780482531,
      time_checked: 1780482231,
    });
  });

  it("throws when Steam sets no cookie", async () => {
    const { community } = makeCommunity("", {}, {});
    await expect(community.getWebTradeEligibility()).rejects.toThrow(/webTradeEligibility/);
  });
});

describe("CommunityNamespace.changeTradeURL", () => {
  it("parses { token } and builds the trade URL", async () => {
    const { community, http } = makeCommunity("", { token: "newtok123" });
    const { url, token } = await community.changeTradeURL();
    expect(token).toBe("newtok123");
    expect(url).toBe("https://steamcommunity.com/tradeoffer/new/?partner=39734272&token=newtok123");
    expect(http.posts[0]!.url).toBe(
      "https://steamcommunity.com/profiles/76561198000000000/tradeoffers/newtradeurl",
    );
  });

  it("also accepts a bare string token", async () => {
    const { community } = makeCommunity("", "bareTok");
    const { token } = await community.changeTradeURL();
    expect(token).toBe("bareTok");
  });
});
