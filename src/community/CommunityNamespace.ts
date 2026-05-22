import { DEFAULT_CONTEXTID, LANG, URLS } from "../core/constants.js";
import { SteamError } from "../core/errors.js";
import { type Page, paginate } from "../core/paginate.js";
import { RETRY_AFTER } from "../core/rateLimits.js";
import { httpError } from "../http/checkers.js";
import type { HttpClient } from "../http/HttpClient.js";
import { type EconItem, parseInventory, type RawInventoryResponse } from "../models/EconItem.js";
import type { SessionManager } from "../session/SessionManager.js";

const INVENTORY_PAGE_SIZE = 2000;

export interface GetInventoryOptions {
  steamId?: string;
  tradableOnly?: boolean;
}

export class CommunityNamespace {
  constructor(
    private readonly http: HttpClient,
    private readonly session: SessionManager,
  ) {}

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
