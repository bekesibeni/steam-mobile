import SteamID from "steamid";
import { DEFAULT_CONTEXTID, LANG, URLS } from "../core/constants.js";
import { SteamError } from "../core/errors.js";
import { type Page, paginate } from "../core/paginate.js";
import { RETRY_AFTER } from "../core/rateLimits.js";
import { resolveTarget } from "../core/target.js";
import type { OfferTarget } from "../core/types.js";
import { checkCommunityError, httpError } from "../http/checkers.js";
import type { HttpClient } from "../http/HttpClient.js";
import { type EconItem, parseInventory, type RawInventoryResponse } from "../models/EconItem.js";
import type { SessionManager } from "../session/SessionManager.js";
import type { ConfirmationManager } from "./confirmations.js";

const INVENTORY_PAGE_SIZE = 2000;

export interface GetInventoryOptions {
  steamId?: string;
  tradableOnly?: boolean;
}

export interface UserCheck {
  escrowDays: number;
  myEscrowDays: number;
  theirEscrowDays: number;
  probation: boolean;
  contexts: Record<string, unknown> | null;
}

export class CommunityNamespace {
  constructor(
    private readonly http: HttpClient,
    private readonly session: SessionManager,
    private readonly confirmations: ConfirmationManager,
  ) {}

  // Escrow hold + probation, scraped from the trade page (the mobile token can't use
  // GetTradeHoldDurations — it returns AccessDenied).
  async checkUser(target: OfferTarget): Promise<UserCheck> {
    await this.session.getAccessToken();
    const { steamId, token } = resolveTarget(target);
    const accountId = new SteamID(steamId).accountid;
    const url = `${URLS.community}/tradeoffer/new/?partner=${accountId}${token ? `&token=${token}` : ""}`;
    const res = await this.http.get<string>(url, {
      responseType: "text",
      headers: { Referer: `${URLS.community}/profiles/${steamId}` },
    });
    if (res.statusCode !== 200) throw httpError(res);
    const html = res.body;
    checkCommunityError(html);

    if (!html.includes("g_rgAppContextData")) {
      throw new SteamError("Failed to load the trade page for this user");
    }

    const myEscrowDays = matchInt(html, /var g_daysMyEscrow = (\d+);/);
    const theirEscrowDays = matchInt(html, /var g_daysTheirEscrow = (\d+);/);
    // The trade page always inlines both escrow vars; if we can't read them, fail loudly
    // rather than report a misleading 0 (callers trust 0 to mean "no hold").
    if (myEscrowDays === null || theirEscrowDays === null) {
      throw new SteamError("Failed to parse escrow durations from the trade page");
    }

    return {
      escrowDays: Math.max(myEscrowDays, theirEscrowDays),
      myEscrowDays,
      theirEscrowDays,
      probation: /g_bTradePartnerProbation\s*=\s*(?:true|1)\b/.test(html),
      contexts: matchJson(html, /g_rgPartnerAppContextData\s*=\s*(\{.*\});/),
    };
  }

  async acknowledgeTradeProtection(): Promise<void> {
    await this.confirmations.acknowledgeTradeProtection();
  }

  async getInventory(
    appid: number,
    contextid: string = DEFAULT_CONTEXTID,
    options: GetInventoryOptions = {},
  ): Promise<EconItem[]> {
    await this.session.getAccessToken();
    const steamId = options.steamId ?? this.session.steamID.getSteamID64();
    const url = `${URLS.community}/inventory/${steamId}/${appid}/${contextid}`;
    const tradableOnly = options.tradableOnly ?? false;

    return paginate<EconItem, string>(async (startAssetId): Promise<Page<EconItem, string>> => {
      const res = await this.http.get<RawInventoryResponse>(url, {
        responseType: "json",
        searchParams: {
          l: LANG.l,
          count: INVENTORY_PAGE_SIZE,
          raw_asset_properties: 1,
          preserve_bbcode: 1,
          start_assetid: startAssetId,
        },
        headers: { Referer: `${URLS.community}/profiles/${steamId}/inventory` },
      });
      const body = res.body;

      if (res.statusCode === 403 && !body) throw new SteamError("This profile is private.");
      if (res.statusCode === 500 && body?.error) throw parseInventoryError(body.error);
      if (res.statusCode !== 200) throw httpError(res, RETRY_AFTER.inventory);

      if (!body?.success) {
        throw new SteamError(body?.error ?? body?.Error ?? "Malformed inventory response");
      }
      // Empty inventory (any app): Steam returns success with no assets. Upstream returns [].
      if (!body.assets) return { items: [], next: undefined };

      return {
        items: parseInventory(body, contextid, tradableOnly),
        next: body.more_items && body.last_assetid ? body.last_assetid : undefined,
      };
    });
  }
}

function parseInventoryError(error: string): SteamError {
  const match = error.match(/^(.+) \((\d+)\)$/);
  if (match?.[1]) return new SteamError(match[1], { eresult: Number(match[2]) });
  return new SteamError(error);
}

function matchInt(html: string, re: RegExp): number | null {
  const m = html.match(re);
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null;
}

function matchJson(html: string, re: RegExp): Record<string, unknown> | null {
  const m = html.match(re);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
