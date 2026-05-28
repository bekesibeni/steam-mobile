import { describe, expect, it, vi } from "vitest";
import { SteamError } from "../src/core/errors.js";
import type { HttpClient, HttpResponse } from "../src/http/HttpClient.js";
import {
  type PlayerBadges,
  type PlayerBans,
  type PlayerSummary,
  SteamWebApi,
} from "../src/keyApi/SteamWebApi.js";

const API_KEY = process.env.STEAM_API_KEY ?? "00000000000000000000000000000000";

function bans(steamId: string): PlayerBans {
  return {
    SteamId: steamId,
    CommunityBanned: false,
    VACBanned: false,
    NumberOfVACBans: 0,
    DaysSinceLastBan: 0,
    NumberOfGameBans: 0,
    EconomyBan: "none",
  };
}

function jsonResponse(body: unknown): HttpResponse<unknown> {
  return { statusCode: 200, headers: {}, body };
}

function makeApi() {
  const api = new SteamWebApi({ apiKey: API_KEY });
  const http = (api as unknown as { http: HttpClient }).http;
  const get = vi.spyOn(http, "get");
  return { api, get };
}

describe("SteamWebApi.getPlayerBans", () => {
  it("calls ISteamUser/GetPlayerBans with key + csv steamids", async () => {
    const { api, get } = makeApi();
    get.mockResolvedValueOnce(
      jsonResponse({ players: [bans("76561198735433360"), bans("76561199832377078")] }),
    );

    const result = await api.getPlayerBans(["76561198735433360", "76561199832377078"]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/", {
      responseType: "json",
      searchParams: {
        key: API_KEY,
        steamids: "76561198735433360,76561199832377078",
      },
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.SteamId).toBe("76561198735433360");
  });

  it("returns [] for an empty input without hitting the network", async () => {
    const { api, get } = makeApi();
    expect(await api.getPlayerBans([])).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("auto-batches above 100 ids and concatenates in order", async () => {
    const { api, get } = makeApi();
    const ids = Array.from({ length: 250 }, (_, i) => String(76561198000000000n + BigInt(i)));
    get.mockImplementation(async (_url, opts) => {
      const csv = (opts?.searchParams?.steamids ?? "") as string;
      return jsonResponse({ players: csv.split(",").map(bans) });
    });

    const result = await api.getPlayerBans(ids);

    expect(get).toHaveBeenCalledTimes(3);
    expect((get.mock.calls[0]?.[1]?.searchParams?.steamids as string).split(",")).toHaveLength(100);
    expect((get.mock.calls[2]?.[1]?.searchParams?.steamids as string).split(",")).toHaveLength(50);
    expect(result.map((p) => p.SteamId)).toEqual(ids);
  });

  it("throws SteamError on a malformed body", async () => {
    const { api, get } = makeApi();
    get.mockResolvedValueOnce(jsonResponse({ players: "nope" }));
    await expect(api.getPlayerBans(["76561198000000000"])).rejects.toBeInstanceOf(SteamError);
  });

  it("maps non-200 responses via httpError", async () => {
    const { api, get } = makeApi();
    get.mockResolvedValueOnce({ statusCode: 429, headers: {}, body: null });
    await expect(api.getPlayerBans(["76561198000000000"])).rejects.toMatchObject({
      name: "RateLimitError",
      statusCode: 429,
    });
  });
});

function summary(steamId: string): PlayerSummary {
  return {
    steamid: steamId,
    personaname: "test",
    profileurl: `https://steamcommunity.com/profiles/${steamId}/`,
    avatar: "a.jpg",
    avatarmedium: "a_medium.jpg",
    avatarfull: "a_full.jpg",
    avatarhash: "abc123",
    personastate: 0,
    communityvisibilitystate: 3,
  };
}

describe("SteamWebApi.getPlayerSummaries", () => {
  it("calls ISteamUser/GetPlayerSummaries with key + csv steamids and flattens response.players", async () => {
    const { api, get } = makeApi();
    get.mockResolvedValueOnce(
      jsonResponse({
        response: { players: [summary("76561198735433360"), summary("76561199832377078")] },
      }),
    );

    const result = await api.getPlayerSummaries(["76561198735433360", "76561199832377078"]);

    expect(get).toHaveBeenCalledWith(
      "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/",
      {
        responseType: "json",
        searchParams: { key: API_KEY, steamids: "76561198735433360,76561199832377078" },
      },
    );
    expect(result.map((p) => p.steamid)).toEqual(["76561198735433360", "76561199832377078"]);
  });

  it("auto-batches above 100 ids", async () => {
    const { api, get } = makeApi();
    const ids = Array.from({ length: 150 }, (_, i) => String(76561198000000000n + BigInt(i)));
    get.mockImplementation(async (_url, opts) => {
      const csv = (opts?.searchParams?.steamids ?? "") as string;
      return jsonResponse({ response: { players: csv.split(",").map(summary) } });
    });

    const result = await api.getPlayerSummaries(ids);

    expect(get).toHaveBeenCalledTimes(2);
    expect(result.map((p) => p.steamid)).toEqual(ids);
  });

  it("throws SteamError on a malformed body", async () => {
    const { api, get } = makeApi();
    get.mockResolvedValueOnce(jsonResponse({ response: {} }));
    await expect(api.getPlayerSummaries(["76561198000000000"])).rejects.toBeInstanceOf(SteamError);
  });
});

describe("SteamWebApi.getBadges", () => {
  it("calls IPlayerService/GetBadges and returns response payload", async () => {
    const { api, get } = makeApi();
    const payload: PlayerBadges = {
      badges: [
        { badgeid: 13, level: 3, completion_time: 1754423355, xp: 112, scarcity: 223009848 },
        {
          badgeid: 1,
          appid: 730,
          level: 5,
          completion_time: 1742761495,
          xp: 500,
          communityitemid: "33965416039",
          border_color: 0,
          scarcity: 9929504,
        },
      ],
      player_xp: 15444,
      player_level: 50,
      player_xp_needed_to_level_up: 156,
      player_xp_needed_current_level: 15000,
    };
    get.mockResolvedValueOnce(jsonResponse({ response: payload }));

    const result = await api.getBadges("76561199832377078");

    expect(get).toHaveBeenCalledWith("https://api.steampowered.com/IPlayerService/GetBadges/v1/", {
      responseType: "json",
      searchParams: { key: API_KEY, steamid: "76561199832377078" },
    });
    expect(result.player_level).toBe(50);
    expect(result.badges).toHaveLength(2);
    expect(result.badges[1]?.appid).toBe(730);
  });

  it("throws SteamError when response is missing", async () => {
    const { api, get } = makeApi();
    get.mockResolvedValueOnce(jsonResponse({}));
    await expect(api.getBadges("76561199832377078")).rejects.toBeInstanceOf(SteamError);
  });

  it("maps non-200 responses via httpError", async () => {
    const { api, get } = makeApi();
    get.mockResolvedValueOnce({ statusCode: 500, headers: {}, body: null });
    await expect(api.getBadges("76561199832377078")).rejects.toMatchObject({
      name: "HttpStatusError",
      statusCode: 500,
    });
  });
});
