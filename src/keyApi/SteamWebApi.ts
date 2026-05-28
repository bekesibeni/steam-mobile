import { URLS } from "../core/constants.js";
import { SteamError } from "../core/errors.js";
import { resolveMobileProfile } from "../core/mobileProfile.js";
import { httpError } from "../http/checkers.js";
import { HttpClient } from "../http/HttpClient.js";

// Steam's documented caps on these endpoints.
const GET_PLAYER_BANS_BATCH = 100;
const GET_PLAYER_SUMMARIES_BATCH = 100;

export interface SteamWebApiOptions {
  apiKey: string;
  proxy?: string;
  http?: HttpClient;
}

// ISteamUser/GetPlayerBans/v1.
export interface PlayerBans {
  SteamId: string;
  CommunityBanned: boolean;
  VACBanned: boolean;
  NumberOfVACBans: number;
  DaysSinceLastBan: number;
  NumberOfGameBans: number;
  EconomyBan: string;
  [key: string]: unknown;
}

// ISteamUser/GetPlayerSummaries/v2.
export interface PlayerSummary {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarmedium: string;
  avatarfull: string;
  avatarhash: string;
  personastate: number;
  communityvisibilitystate: number;
  profilestate?: number;
  lastlogoff?: number;
  commentpermission?: number;
  realname?: string;
  primaryclanid?: string;
  timecreated?: number;
  personastateflags?: number;
  gameid?: string;
  gameserverip?: string;
  gameextrainfo?: string;
  loccountrycode?: string;
  locstatecode?: string;
  loccityid?: number;
  [key: string]: unknown;
}

// IPlayerService/GetBadges/v1.
export interface Badge {
  badgeid: number;
  level: number;
  completion_time: number;
  xp: number;
  scarcity: number;
  appid?: number;
  communityitemid?: string;
  border_color?: number;
  [key: string]: unknown;
}

export interface PlayerBadges {
  badges: Badge[];
  player_xp: number;
  player_level: number;
  player_xp_needed_to_level_up: number;
  player_xp_needed_current_level: number;
  [key: string]: unknown;
}

// Standalone Web-API client authenticated by developer key (no SteamMobile, no login, no session).
export class SteamWebApi {
  private readonly http: HttpClient;
  private readonly apiKey: string;

  constructor(options: SteamWebApiOptions) {
    this.apiKey = options.apiKey;
    this.http =
      options.http ??
      new HttpClient({
        ...(options.proxy ? { proxy: options.proxy } : {}),
        profile: resolveMobileProfile(),
      });
  }

  // Auto-batches into 100-id requests; preserves caller order across batches.
  async getPlayerBans(steamIds: readonly string[]): Promise<PlayerBans[]> {
    if (steamIds.length === 0) return [];
    const out: PlayerBans[] = [];
    for (let i = 0; i < steamIds.length; i += GET_PLAYER_BANS_BATCH) {
      const chunk = steamIds.slice(i, i + GET_PLAYER_BANS_BATCH);
      const res = await this.http.get<{ players?: PlayerBans[] }>(
        `${URLS.api}/ISteamUser/GetPlayerBans/v1/`,
        {
          responseType: "json",
          searchParams: { key: this.apiKey, steamids: chunk.join(",") },
        },
      );
      if (res.statusCode !== 200) throw httpError(res);
      const players = res.body?.players;
      if (!Array.isArray(players)) {
        throw new SteamError("Invalid GetPlayerBans response", { body: res.body });
      }
      out.push(...players);
    }
    return out;
  }

  // Auto-batches into 100-id requests; preserves caller order across batches.
  async getPlayerSummaries(steamIds: readonly string[]): Promise<PlayerSummary[]> {
    if (steamIds.length === 0) return [];
    const out: PlayerSummary[] = [];
    for (let i = 0; i < steamIds.length; i += GET_PLAYER_SUMMARIES_BATCH) {
      const chunk = steamIds.slice(i, i + GET_PLAYER_SUMMARIES_BATCH);
      const res = await this.http.get<{ response?: { players?: PlayerSummary[] } }>(
        `${URLS.api}/ISteamUser/GetPlayerSummaries/v2/`,
        {
          responseType: "json",
          searchParams: { key: this.apiKey, steamids: chunk.join(",") },
        },
      );
      if (res.statusCode !== 200) throw httpError(res);
      const players = res.body?.response?.players;
      if (!Array.isArray(players)) {
        throw new SteamError("Invalid GetPlayerSummaries response", { body: res.body });
      }
      out.push(...players);
    }
    return out;
  }

  async getBadges(steamId: string): Promise<PlayerBadges> {
    const res = await this.http.get<{ response?: PlayerBadges }>(
      `${URLS.api}/IPlayerService/GetBadges/v1/`,
      {
        responseType: "json",
        searchParams: { key: this.apiKey, steamid: steamId },
      },
    );
    if (res.statusCode !== 200) throw httpError(res);
    const response = res.body?.response;
    if (!response || !Array.isArray(response.badges)) {
      throw new SteamError("Invalid GetBadges response", { body: res.body });
    }
    return response;
  }
}
