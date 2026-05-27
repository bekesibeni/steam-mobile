import { EventEmitter } from "node:events";
import SteamID from "steamid";
import type { ConfirmationManager } from "../community/confirmations.js";
import {
  buildPartnerTradePageUrl,
  fetchUserDetails,
  type UserDetails,
} from "../community/userDetails.js";
import { DEFAULT_CONTEXTID, LANG, URLS } from "../core/constants.js";
import { EOfferFilter } from "../core/enums.js";
import { SteamError } from "../core/errors.js";
import { type Page, paginate } from "../core/paginate.js";
import { parseStrError } from "../core/parseStrError.js";
import { RETRY_AFTER } from "../core/rateLimits.js";
import { resolveTarget } from "../core/target.js";
import type { OfferTarget, RawAsset, RawCEconTradeOffer } from "../core/types.js";
import { httpError } from "../http/checkers.js";
import type { HttpClient } from "../http/HttpClient.js";
import { inventoryFailureError } from "../http/tradePageError.js";
import type { WebApiClient } from "../http/webApi.js";
import {
  buildDescriptionMap,
  type EconItem,
  parsePartnerInventory,
  type RawPartnerInventoryResponse,
} from "../models/EconItem.js";
import type { SessionManager } from "../session/SessionManager.js";
import {
  type ExchangeDetails,
  getTradeHistory as fetchTradeHistory,
  getTradeOffersSummary as fetchTradeOffersSummary,
  getTradeStatus as fetchTradeStatus,
  type TradeHistory,
  type TradeHistoryOptions,
  type TradeOffersSummary,
} from "./exchange.js";
import { Poller } from "./polling.js";
import type { PollChange, PollData, PollOptions, TradeEvents } from "./pollTypes.js";
import { TradeOffer, type TradeOfferDeps } from "./TradeOffer.js";

const FUTURE_CUTOFF_MS = 31_536_000_000; // 1 year ahead = "no historical offers"

export interface EscrowSide {
  escrow_end_duration_seconds: number;
}

export interface EscrowHold {
  me: EscrowSide;
  them: EscrowSide;
  both: EscrowSide;
}

interface RawEscrowResponse {
  my_escrow?: EscrowSide;
  their_escrow?: EscrowSide;
  both_escrow?: EscrowSide;
}

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
  async getTradeOffers(
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

  // Settlement details for a completed/escrowed trade (tradeID, not offer id).
  getTradeStatus(opts: { tradeId: string }): Promise<ExchangeDetails> {
    return fetchTradeStatus(this.api, opts.tradeId);
  }

  // Persona, contexts, escrow days, avatars, and partner probation for both sides — same trade-page
  // scrape as offer.getUserDetails(), but addressed by target instead of by an existing offer.
  async getUserDetails(target: OfferTarget): Promise<UserDetails> {
    await this.session.getAccessToken();
    const { steamId, token } = resolveTarget(target);
    const partnerAccountId = new SteamID(steamId).accountid;
    return fetchUserDetails(
      this.http,
      buildPartnerTradePageUrl(partnerAccountId, token),
      `${URLS.community}/profiles/${steamId}`,
      this.session.steamID.accountid,
      partnerAccountId,
    );
  }

  // Escrow hold (seconds) via IEconService/GetTradeHoldDurations — escrow-only, lightweight. For
  // everything together (escrow + persona + avatars + contexts), use offer.getUserDetails() instead.
  async getEscrow(target: OfferTarget): Promise<EscrowHold> {
    const { steamId, token } = resolveTarget(target);
    const body = await this.api.call<{ response?: RawEscrowResponse }>({
      httpMethod: "GET",
      iface: "IEconService",
      method: "GetTradeHoldDurations",
      retryAfterMs: RETRY_AFTER.GetTradeHoldDurations,
      input: {
        steamid_target: steamId,
        ...(token ? { trade_offer_access_token: token } : {}),
      },
    });
    const r = body.response ?? {};
    const zero: EscrowSide = { escrow_end_duration_seconds: 0 };
    return {
      me: r.my_escrow ?? zero,
      them: r.their_escrow ?? zero,
      both: r.both_escrow ?? zero,
    };
  }

  // Past trades (newest first); cursor-paginate with startAfterTime/startAfterTradeId while `more`.
  getTradeHistory(opts?: TradeHistoryOptions): Promise<TradeHistory> {
    return fetchTradeHistory(this.api, opts);
  }

  // Counts of pending/new/historical sent & received offers.
  getTradeOffersSummary(): Promise<TradeOffersSummary> {
    return fetchTradeOffersSummary(this.api);
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
    const { sent, received } = await this.getTradeOffers(
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

  async pollOnce(
    options: PollOptions & { forceFull?: boolean } = {},
  ): Promise<{ changes: PollChange[]; pollData: PollData }> {
    const { forceFull, ...pollOptions } = options;
    if (!this.poller) this.poller = new Poller(this, pollOptions);
    return this.poller.pollOnce(forceFull ?? false);
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

      const body = res.body;
      if (res.statusCode === 500 && body?.error) throw parseStrError(body.error);
      if (res.statusCode !== 200) throw httpError(res, RETRY_AFTER.partnerInventory);
      if (!body?.success) {
        throw await inventoryFailureError(this.http, steamId, token, body?.error ?? body?.Error);
      }

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
