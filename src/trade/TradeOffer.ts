import SteamID from "steamid";
import type { ConfirmationManager } from "../community/confirmations.js";
import { URLS } from "../core/constants.js";
import { EConfirmationMethod, ETradeOfferState } from "../core/enums.js";
import { ConfirmationError, SteamError, SteamSessionExpiredError } from "../core/errors.js";
import type { OfferTarget, RawAsset, RawCEconTradeOffer, TradeItem } from "../core/types.js";
import { httpError } from "../http/checkers.js";
import type { HttpClient } from "../http/HttpClient.js";
import { buildItem, type EconItem, type RawDescription } from "../models/EconItem.js";
import type { SessionManager } from "../session/SessionManager.js";
import type { ExchangeDetails } from "./exchange.js";
import { parseStrError } from "./strError.js";
import type { TradeNamespace } from "./TradeNamespace.js";

export type SendResult = "sent" | "needs_confirmation";
export type AcceptResult = "accepted" | "escrow" | "needs_confirmation";

const TWO_WEEKS_MS = 1_209_600_000;

export interface TradeOfferDeps {
  http: HttpClient;
  session: SessionManager;
  confirmations: ConfirmationManager;
  trade: TradeNamespace;
}

interface RawSendResponse {
  tradeofferid?: string;
  needs_mobile_confirmation?: boolean;
  needs_email_confirmation?: boolean;
  strError?: string;
}

interface RawAcceptResponse {
  tradeid?: string;
  needs_mobile_confirmation?: boolean;
  needs_email_confirmation?: boolean;
  strError?: string;
}

interface RawCancelResponse {
  tradeofferid?: string;
  strError?: string;
}

export class TradeOffer {
  id: string | undefined;
  readonly partner: SteamID;
  token: string | undefined;
  message = "";
  state: ETradeOfferState = ETradeOfferState.Invalid;
  itemsToGive: TradeItem[] = [];
  itemsToReceive: TradeItem[] = [];
  isOurOffer = true;
  tradeID: string | undefined;
  confirmationMethod: EConfirmationMethod = EConfirmationMethod.None;
  escrowEnds: Date | undefined;
  created: Date | undefined;
  updated: Date | undefined;
  expires: Date | undefined;
  fromRealTimeTrade = false;
  // Offer with missing item names (descriptions not ready) or no items; polling must not advance its cutoff past it.
  glitched = false;
  private countering: string | undefined;

  constructor(
    private readonly deps: TradeOfferDeps,
    init: { partner: SteamID; token?: string; id?: string },
  ) {
    this.partner = init.partner;
    this.token = init.token;
    this.id = init.id;
  }

  // `descriptions` (from get_descriptions=1) enriches each item into a full EconItem; glitch detection needs the names.
  static fromData(
    deps: TradeOfferDeps,
    raw: RawCEconTradeOffer,
    descriptions?: Map<string, RawDescription>,
  ): TradeOffer {
    if (!raw.accountid_other) {
      throw new SteamError(`Trade offer ${raw.tradeofferid} is missing a partner accountid`);
    }
    const partner = SteamID.fromIndividualAccountID(raw.accountid_other);
    const offer = new TradeOffer(deps, { partner, id: raw.tradeofferid });
    offer.message = raw.message ?? "";
    offer.state = raw.trade_offer_state;
    offer.isOurOffer = raw.is_our_offer;
    offer.fromRealTimeTrade = raw.from_real_time_trade ?? false;
    const mapItem = (a: RawAsset): TradeItem =>
      descriptions
        ? buildItem(a, descriptions.get(`${a.appid}_${a.classid}_${a.instanceid}`), [], a.contextid)
        : toTradeItem(a);
    offer.itemsToGive = (raw.items_to_give ?? []).map(mapItem);
    offer.itemsToReceive = (raw.items_to_receive ?? []).map(mapItem);
    offer.confirmationMethod = raw.confirmation_method ?? EConfirmationMethod.None;
    if (raw.tradeid) offer.tradeID = raw.tradeid;
    if (raw.escrow_end_date) offer.escrowEnds = new Date(raw.escrow_end_date * 1000);
    if (raw.time_created) offer.created = new Date(raw.time_created * 1000);
    if (raw.time_updated) offer.updated = new Date(raw.time_updated * 1000);
    if (raw.expiration_time) offer.expires = new Date(raw.expiration_time * 1000);

    const allItems = [...offer.itemsToGive, ...offer.itemsToReceive];
    offer.glitched =
      allItems.length === 0 ||
      (descriptions !== undefined && allItems.some((i) => !(i as EconItem).name));
    return offer;
  }

  // Faithful to upstream itemEquals: same appid + contextid + assetid.
  containsItem(item: { appid: number; contextid: string; assetid: string }): boolean {
    return [...this.itemsToGive, ...this.itemsToReceive].some(
      (i) => i.appid === item.appid && i.contextid === item.contextid && i.assetid === item.assetid,
    );
  }

  give(items: TradeItem[]): this {
    this.itemsToGive.push(...items);
    return this;
  }

  receive(items: TradeItem[]): this {
    this.itemsToReceive.push(...items);
    return this;
  }

  setMessage(message: string): this {
    if (this.id) throw new SteamError("Cannot set a message on an already-sent offer");
    this.message = message.slice(0, 128);
    return this;
  }

  async send(): Promise<SendResult> {
    if (this.id) throw new SteamError("This offer has already been sent");
    if (this.itemsToGive.length + this.itemsToReceive.length === 0) {
      throw new SteamError("Cannot send an empty trade offer");
    }

    await this.deps.session.getAccessToken();
    const sessionid = await this.deps.http.getSessionId();
    // Acknowledge the 2025 trade-protection notice so send isn't blocked; tolerate ack failures but not an expired session.
    await this.deps.confirmations.acknowledgeTradeProtection().catch((err) => {
      if (err instanceof SteamSessionExpiredError) throw err;
    });

    const offerdata = {
      newversion: true,
      version: this.itemsToGive.length + this.itemsToReceive.length + 1,
      me: { assets: this.itemsToGive.map(toAsset), currency: [], ready: false },
      them: { assets: this.itemsToReceive.map(toAsset), currency: [], ready: false },
    };
    const createParams: Record<string, string> = {};
    if (this.token) createParams.trade_offer_access_token = this.token;

    const res = await this.deps.http.post<RawSendResponse>(
      `${URLS.community}/tradeoffer/new/send`,
      {
        responseType: "json",
        referer: this.newOfferReferer(),
        form: {
          sessionid,
          serverid: 1,
          partner: this.partner.getSteamID64(),
          tradeoffermessage: this.message,
          json_tradeoffer: JSON.stringify(offerdata),
          captcha: "",
          trade_offer_create_params: JSON.stringify(createParams),
          ...(this.countering ? { tradeofferid_countered: this.countering } : {}),
        },
      },
    );

    if (res.statusCode === 401) throw new SteamSessionExpiredError();
    const body = res.body;
    // Steam often returns strError on a non-200; surface the typed error first.
    if (body?.strError) throw parseStrError(body.strError);
    if (res.statusCode !== 200) throw httpError(res);
    if (!body) throw new SteamError("Malformed JSON response");

    if (body.tradeofferid) {
      this.id = body.tradeofferid;
      this.state = ETradeOfferState.Active;
      this.created = new Date();
      this.updated = new Date();
      this.expires = new Date(Date.now() + TWO_WEEKS_MS);
    }
    this.confirmationMethod = EConfirmationMethod.None;
    if (body.needs_email_confirmation) {
      this.state = ETradeOfferState.CreatedNeedsConfirmation;
      this.confirmationMethod = EConfirmationMethod.Email;
    }
    if (body.needs_mobile_confirmation) {
      this.state = ETradeOfferState.CreatedNeedsConfirmation;
      this.confirmationMethod = EConfirmationMethod.MobileApp;
    }

    if (this.state === ETradeOfferState.CreatedNeedsConfirmation) return "needs_confirmation";
    if (body.tradeofferid) return "sent";
    throw new SteamError("Unknown response sending trade offer");
  }

  async accept(): Promise<AcceptResult> {
    if (!this.id) throw new SteamError("Cannot accept an unsent offer");
    if (this.state !== ETradeOfferState.Active) {
      throw new SteamError(`Offer #${this.id} is not active, so it may not be accepted`);
    }
    if (this.isOurOffer) throw new SteamError(`Cannot accept our own offer #${this.id}`);

    await this.deps.session.getAccessToken();
    const sessionid = await this.deps.http.getSessionId();
    const res = await this.deps.http.post<RawAcceptResponse>(
      `${URLS.community}/tradeoffer/${this.id}/accept`,
      {
        responseType: "json",
        referer: `${URLS.community}/tradeoffer/${this.id}/`,
        form: {
          sessionid,
          serverid: 1,
          tradeofferid: this.id,
          partner: this.partner.getSteamID64(),
          captcha: "",
        },
      },
    );

    if (res.statusCode === 403) throw new SteamSessionExpiredError();
    const body = res.body;
    if (body?.strError) throw parseStrError(body.strError);
    if (res.statusCode !== 200) throw httpError(res);
    if (!body) throw new SteamError("Malformed JSON response");

    if (body.tradeid) this.tradeID = body.tradeid;
    if (body.needs_mobile_confirmation || body.needs_email_confirmation) {
      this.confirmationMethod = body.needs_mobile_confirmation
        ? EConfirmationMethod.MobileApp
        : EConfirmationMethod.Email;
      return "needs_confirmation";
    }

    // The accept response doesn't flag escrow; re-read to distinguish a held trade from a settled one.
    this.state = ETradeOfferState.Accepted;
    try {
      const refreshed = await this.deps.trade.getTradeOffer(this.id);
      this.state = refreshed.state;
      this.escrowEnds = refreshed.escrowEnds;
    } catch {
      // keep optimistic Accepted; caller can reconcile via getTradeOffer
    }
    return this.state === ETradeOfferState.InEscrow ? "escrow" : "accepted";
  }

  async cancel(): Promise<void> {
    if (!this.id) throw new SteamError("Cannot cancel or decline an unsent offer");
    if (
      this.state !== ETradeOfferState.Active &&
      this.state !== ETradeOfferState.CreatedNeedsConfirmation
    ) {
      throw new SteamError(
        `Offer #${this.id} is not active, so it may not be cancelled or declined`,
      );
    }

    await this.deps.session.getAccessToken();
    const sessionid = await this.deps.http.getSessionId();
    const action = this.isOurOffer ? "cancel" : "decline";
    const res = await this.deps.http.post<RawCancelResponse>(
      `${URLS.community}/tradeoffer/${this.id}/${action}`,
      {
        responseType: "json",
        referer: this.offerReferer(),
        form: { sessionid },
      },
    );

    if (res.statusCode === 401) throw new SteamSessionExpiredError();
    const body = res.body;
    if (body?.strError) throw parseStrError(body.strError);
    if (res.statusCode !== 200) throw httpError(res);
    if (!body) throw new SteamError("Malformed JSON response");
    if (body.tradeofferid !== this.id) throw new SteamError("Wrong response cancelling offer");

    this.state = this.isOurOffer ? ETradeOfferState.Canceled : ETradeOfferState.Declined;
    this.updated = new Date();
  }

  decline(): Promise<void> {
    return this.cancel();
  }

  async confirm(): Promise<void> {
    if (!this.id) throw new ConfirmationError("Cannot confirm an unsent offer");
    await this.deps.confirmations.acceptConfirmationForObject(this.id);
  }

  counter(): TradeOffer {
    if (!this.id) throw new SteamError("Cannot counter an unsent offer");
    if (this.state !== ETradeOfferState.Active) {
      throw new SteamError(`Offer #${this.id} is not active, so it may not be countered`);
    }
    const next = new TradeOffer(this.deps, {
      partner: this.partner,
      ...(this.token ? { token: this.token } : {}),
    });
    next.countering = this.id;
    next.isOurOffer = true;
    // Deep-copy items so editing the counter doesn't mutate the original offer.
    next.itemsToGive = this.itemsToGive.map((i) => ({ ...i }));
    next.itemsToReceive = this.itemsToReceive.map((i) => ({ ...i }));
    next.message = this.message;
    return next;
  }

  // Settlement details once accepted (needs tradeID, set on accept / on a fetched accepted offer).
  getTradeStatus(): Promise<ExchangeDetails> {
    if (!this.tradeID) {
      throw new SteamError("No trade ID — getTradeStatus needs an accepted offer");
    }
    return this.deps.trade.getTradeStatus({ tradeId: this.tradeID });
  }

  getPartnerInventory(
    appid: number,
    contextid?: string,
    tradableOnly?: boolean,
  ): Promise<EconItem[]> {
    const target = this.partnerTarget();
    return this.deps.trade.getInventory(
      target,
      appid,
      contextid,
      tradableOnly !== undefined ? { tradableOnly } : {},
    );
  }

  private partnerTarget(): OfferTarget {
    const steamId = this.partner.getSteamID64();
    return this.token ? { steamId, token: this.token } : { steamId };
  }

  private newOfferReferer(): string {
    const token = this.token ? `&token=${this.token}` : "";
    return `${URLS.community}/tradeoffer/${this.id ?? "new"}/?partner=${this.partner.accountid}${token}`;
  }

  private offerReferer(): string {
    const token = this.token ? `&token=${this.token}` : "";
    return `${URLS.community}/tradeoffer/${this.id}/?partner=${this.partner.accountid}${token}`;
  }
}

function toAsset(item: TradeItem): {
  appid: number;
  contextid: string;
  amount: number;
  assetid: string;
} {
  return {
    appid: item.appid,
    contextid: item.contextid,
    amount: item.amount && item.amount > 0 ? item.amount : 1,
    assetid: item.assetid,
  };
}

function toTradeItem(raw: RawAsset): TradeItem {
  return {
    appid: raw.appid,
    contextid: raw.contextid,
    assetid: raw.assetid,
    amount: Number(raw.amount) || 1,
  };
}
