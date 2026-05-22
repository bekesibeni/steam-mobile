import SteamID from "steamid";
import { describe, expect, it } from "vitest";
import { CommunityNamespace } from "../src/community/CommunityNamespace.js";
import type { ConfirmationManager } from "../src/community/confirmations.js";
import type { HttpClient } from "../src/http/HttpClient.js";
import type { SessionManager } from "../src/session/SessionManager.js";

const SELF = new SteamID("76561198000000000");
const PARTNER = SteamID.fromIndividualAccountID(46143802).getSteamID64();

class FakeHttp {
  calls: string[] = [];
  constructor(private readonly html: string) {}
  async get(url: string) {
    this.calls.push(url);
    return { statusCode: 200, headers: {}, body: this.html };
  }
}

function makeCommunity(html: string): { community: CommunityNamespace; http: FakeHttp } {
  const http = new FakeHttp(html);
  const session = {
    steamID: SELF,
    async getAccessToken() {},
  } as unknown as SessionManager;
  const community = new CommunityNamespace(
    http as unknown as HttpClient,
    session,
    {} as unknown as ConfirmationManager,
  );
  return { community, http };
}

const TRADE_PAGE = `
<html><body><script type="text/javascript">
var g_rgAppContextData = {"730":{"appid":730}};
var g_rgPartnerAppContextData = {"730":{"appid":730,"name":"Counter-Strike 2"}};
var g_daysMyEscrow = 0;
var g_daysTheirEscrow = 3;
var g_bTradePartnerProbation = false;
</script></body></html>`;

describe("CommunityNamespace.checkUser", () => {
  it("scrapes escrow days, probation, and partner contexts", async () => {
    const { community, http } = makeCommunity(TRADE_PAGE);
    const result = await community.checkUser({ steamId: PARTNER, token: "TOK" });

    expect(result.myEscrowDays).toBe(0);
    expect(result.theirEscrowDays).toBe(3);
    expect(result.escrowDays).toBe(3);
    expect(result.probation).toBe(false);
    expect((result.contexts?.["730"] as { name: string }).name).toBe("Counter-Strike 2");

    const url = http.calls[0]!;
    expect(url).toContain(`partner=${new SteamID(PARTNER).accountid}`);
    expect(url).toContain("token=TOK");
  });

  it("detects probation (boolean literal)", async () => {
    const html = TRADE_PAGE.replace(
      "g_bTradePartnerProbation = false",
      "g_bTradePartnerProbation = true",
    );
    const { community } = makeCommunity(html);
    const result = await community.checkUser({ steamId: PARTNER });
    expect(result.probation).toBe(true);
  });

  it("detects probation (numeric literal)", async () => {
    const html = TRADE_PAGE.replace(
      "g_bTradePartnerProbation = false",
      "g_bTradePartnerProbation = 1",
    );
    const { community } = makeCommunity(html);
    const result = await community.checkUser({ steamId: PARTNER });
    expect(result.probation).toBe(true);
  });

  it("throws rather than reporting escrow 0 when the escrow vars are unparseable", async () => {
    const html = TRADE_PAGE.replace("var g_daysTheirEscrow = 3;", "");
    const { community } = makeCommunity(html);
    await expect(community.checkUser({ steamId: PARTNER })).rejects.toThrow(/escrow/);
  });

  it("throws when the trade page didn't load", async () => {
    const { community } = makeCommunity("<html><body>nope</body></html>");
    await expect(community.checkUser({ steamId: PARTNER })).rejects.toThrow(/Failed to load/);
  });
});
