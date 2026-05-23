import { EventEmitter } from "node:events";
import SteamID from "steamid";
import type { ConfirmationManager } from "../community/confirmations.js";
import { DEFAULT_CONTEXTID, LANG, URLS } from "../core/constants.js";
import { EOfferFilter } from "../core/enums.js";
import { SteamError } from "../core/errors.js";
import { type Page, paginate } from "../core/paginate.js";
import { RETRY_AFTER } from "../core/rateLimits.js";
import { resolveTarget } from "../core/target.js";
import type { OfferTarget, RawAsset, RawCEconTradeOffer } from "../core/types.js";
import { httpError } from "../http/checkers.js";
import type { HttpClient } from "../http/HttpClient.js";
import type { WebApiClient } from "../http/webApi.js";
import {
  buildDescriptionMap,
  type EconItem,
  parsePartnerInventory,
  type RawPartnerInventoryResponse,
} from "../models/EconItem.js";
import type { SessionManager } from "../session/SessionManager.js";
import { Poller } from "./polling.js";
import type { PollData, PollOptions, TradeEvents } from "./pollTypes.js";
import { TradeOffer, type TradeOfferDeps } from "./TradeOffer.js";

const FUTURE_CUTOFF_MS = 31_536_000_000; // 1 year ahead = "no historical offers"

export class TradeNamespace extends EventEmitter<TradeEvents> {
  private poller: Poller | undefined;

  constructor(
    private readonly api: WebApiClient,
    private readonly http: HttpClient,
    private readonly session: SessionManager,
    private readonly confirmations: ConfirmationManager,
  ) {
    super();
  }

  private offerDeps(): TradeOfferDeps {
    return {
      http: this.http,
      session: this.session,
      confirmations: this.confirmations,
      trade: this,
    };
  }

  // Local only — no network until send().
  createOffer(target: OfferTarget): TradeOffer {
    const { steamId, token } = resolveTarget(target);
    return new TradeOffer(this.offerDeps(), {
      partner: new SteamID(steamId),
      ...(token ? { token } : {}),
    });
  }

  async getTradeOffer(id: string): Promise<TradeOffer> {
    const body = await this.api.call<{
      response?: {
        offer?: RawCEconTradeOffer;
        descriptions?: Parameters<typeof buildDescriptionMap>[0];
      };
    }>({
      httpMethod: "GET",
      iface: "IEconService",
      method: "GetTradeOffer",
      retryAfterMs: RETRY_AFTER.GetTradeOffer,
      input: { tradeofferid: id, get_descriptions: 1, ...LANG },
    });
    const raw = body.response?.offer;
    if (!raw) throw new SteamError(`Trade offer ${id} not found`);
    return TradeOffer.fromData(
      this.offerDeps(),
      raw,
      buildDescriptionMap(body.response?.descriptions),
    );
  }

  // Cursor-paginates all pages; rejects the wholly-malformed "data temporarily unavailable" glitch.
  async getOffers(
    filter: EOfferFilter = EOfferFilter.ActiveOnly,
    historicalCutoff?: Date,
  ): Promise<{ sent: TradeOffer[]; received: TradeOffer[] }> {
    const cutoff = historicalCutoff ?? new Date(Date.now() + FUTURE_CUTOFF_MS);

    const sentRaw: RawCEconTradeOffer[] = [];
    const receivedRaw: RawCEconTradeOffer[] = [];
    const descriptions: NonNullable<Parameters<typeof buildDescriptionMap>[0]> = [];
    let cursor = 0;

    do {
      const body = await this.api.call<{
        response?: {
          trade_offers_sent?: RawCEconTradeOffer[];
          trade_offers_received?: RawCEconTradeOffer[];
          descriptions?: NonNullable<Parameters<typeof buildDescriptionMap>[0]>;
          next_cursor?: number;
        };
      }>({
        httpMethod: "GET",
        iface: "IEconService",
        method: "GetTradeOffers",
        retryAfterMs: RETRY_AFTER.GetTradeOffers,
        input: {
          get_sent_offers: 1,
          get_received_offers: 1,
          get_descriptions: 1,
          active_only: filter === EOfferFilter.ActiveOnly ? 1 : 0,
          historical_only: filter === EOfferFilter.HistoricalOnly ? 1 : 0,
          time_historical_cutoff: Math.floor(cutoff.getTime() / 1000),
          cursor,
          ...LANG,
        },
      });
      const response = body.response ?? {};
      sentRaw.push(...(response.trade_offers_sent ?? []));
      receivedRaw.push(...(response.trade_offers_received ?? []));
      descriptions.push(...(response.descriptions ?? []));
      const next = response.next_cursor ?? 0;
      if (next !== 0 && next === cursor) break; // cursor not advancing — stop rather than loop forever
      cursor = next;
      if (cursor) this.emit("debug", `GetTradeOffers with cursor ${cursor}`);
    } while (cursor);

    const all = [...sentRaw, ...receivedRaw];
    if (all.length > 0 && (all.every(offerMalformed) || all.some(offerSuperMalformed))) {
      throw new SteamError("Data temporarily unavailable");
    }

    const descMap = buildDescriptionMap(descriptions);
    const build = (raw: RawCEconTradeOffer): TradeOffer =>
      TradeOffer.fromData(this.offerDeps(), sanitizeRawOffer(raw), descMap);
    return { sent: sentRaw.map(build), received: receivedRaw.map(build) };
  }

  async getTradeOffers(filter: EOfferFilter = EOfferFilter.ActiveOnly): Promise<TradeOffer[]> {
    const { sent, received } = await this.getOffers(filter);
    return [...sent, ...received];
  }

  // Re-read known offers by id; missing/errored ids are skipped so one can't fail the batch.
  async reconcile(ids: string[]): Promise<Map<string, TradeOffer>> {
    const results = await Promise.allSettled(ids.map((id) => this.getTradeOffer(id)));
    const map = new Map<string, TradeOffer>();
    results.forEach((res, i) => {
      const id = ids[i];
      if (id !== undefined && res.status === "fulfilled") map.set(id, res.value);
    });
    return map;
  }

  async getOffersContainingItems(
    items: { appid: number; contextid: string; assetid: string }[],
    includeInactive = false,
  ): Promise<TradeOffer[]> {
    const { sent, received } = await this.getOffers(
      includeInactive ? EOfferFilter.All : EOfferFilter.ActiveOnly,
    );
    return [...sent, ...received].filter((offer) =>
      items.every((item) => offer.containsItem(item)),
    );
  }

  startPolling(options: PollOptions = {}): void {
    this.poller?.stop();
    this.poller = new Poller(this, options);
    this.poller.start();
  }

  stopPolling(): void {
    this.poller?.stop();
    this.poller = undefined;
  }

  get pollData(): PollData | undefined {
    return this.poller?.pollData;
  }

  async getInventory(
    target: OfferTarget,
    appid: number,
    contextid: string = DEFAULT_CONTEXTID,
    options: { tradableOnly?: boolean } = {},
  ): Promise<EconItem[]> {
    const tradableOnly = options.tradableOnly ?? false;
    await this.session.getAccessToken();
    const { steamId, token } = resolveTarget(target);
    const sessionid = await this.http.getSessionId();
    const accountId = new SteamID(steamId).accountid;
    const referer = `${URLS.community}/tradeoffer/new/?partner=${accountId}${token ? `&token=${token}` : ""}`;

    return paginate<EconItem, number>(async (start): Promise<Page<EconItem, number>> => {
      const res = await this.http.get<RawPartnerInventoryResponse>(
        `${URLS.community}/tradeoffer/new/partnerinventory/`,
        {
          responseType: "json",
          searchParams: {
            sessionid,
            partner: steamId,
            appid,
            contextid,
            ...(token ? { token } : {}),
            ...(start !== undefined ? { start } : {}),
            l: LANG.l,
          },
          headers: { Referer: referer },
        },
      );

      if (res.statusCode !== 200) throw httpError(res, RETRY_AFTER.partnerInventory);
      const body = res.body;
      if (!body?.success) throw new SteamError(body?.error ?? "Failed to load partner inventory");

      // Continue only when more_start actually advances, else a stuck cursor loops forever.
      const next =
        body.more && typeof body.more_start === "number" && body.more_start > (start ?? 0)
          ? body.more_start
          : undefined;
      return { items: parsePartnerInventory(body, contextid, tradableOnly), next };
    });
  }
}

function itemMalformed(item: RawAsset): boolean {
  return !item.appid || !item.contextid || !item.assetid;
}

function offerSuperMalformed(offer: RawCEconTradeOffer): boolean {
  return !offer.accountid_other;
}

function offerMalformed(offer: RawCEconTradeOffer): boolean {
  return (
    offerSuperMalformed(offer) ||
    ((offer.items_to_give ?? []).length === 0 && (offer.items_to_receive ?? []).length === 0) ||
    (offer.items_to_give ?? []).some(itemMalformed) ||
    (offer.items_to_receive ?? []).some(itemMalformed)
  );
}

function sanitizeRawOffer(offer: RawCEconTradeOffer): RawCEconTradeOffer {
  return {
    ...offer,
    ...(offer.items_to_give
      ? { items_to_give: offer.items_to_give.filter((i) => !itemMalformed(i)) }
      : {}),
    ...(offer.items_to_receive
      ? { items_to_receive: offer.items_to_receive.filter((i) => !itemMalformed(i)) }
      : {}),
  };
}
