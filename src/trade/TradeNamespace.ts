import { LANG } from "../constants.js";
import { EOfferFilter } from "../enums.js";
import type { WebApiClient } from "../http/webApi.js";
import type { RawGetTradeOffersResponse } from "../types.js";

export class TradeNamespace {
  constructor(private readonly api: WebApiClient) {}

  async getTradeOffers(
    filter: EOfferFilter = EOfferFilter.ActiveOnly,
  ): Promise<RawGetTradeOffersResponse> {
    const body = await this.api.call<{ response?: RawGetTradeOffersResponse }>({
      httpMethod: "GET",
      iface: "IEconService",
      method: "GetTradeOffers",
      input: {
        get_sent_offers: 1,
        get_received_offers: 1,
        get_descriptions: 1,
        active_only: filter === EOfferFilter.ActiveOnly ? 1 : 0,
        historical_only: filter === EOfferFilter.HistoricalOnly ? 1 : 0,
        ...LANG,
      },
    });
    return body.response ?? {};
  }
}
