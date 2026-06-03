import type { RawDescription } from "../models/EconItem.js";

export type OfferTarget =
  | { tradeUrl: string; steamId?: never; token?: never }
  | { steamId: string; token?: string; tradeUrl?: never };

export interface TradeItem {
  appid: number;
  contextid: string;
  assetid: string;
  amount?: number;
}

export interface RawAsset {
  appid: number;
  contextid: string;
  assetid: string;
  classid: string;
  instanceid: string;
  amount: string;
  missing?: boolean;
  est_usd?: string;
  [key: string]: unknown;
}

export interface RawCEconTradeOffer {
  tradeofferid: string;
  accountid_other: number;
  message?: string;
  expiration_time: number;
  trade_offer_state: number;
  items_to_give?: RawAsset[];
  items_to_receive?: RawAsset[];
  is_our_offer: boolean;
  time_created: number;
  time_updated: number;
  tradeid?: string;
  from_real_time_trade: boolean;
  escrow_end_date: number;
  confirmation_method: number;
  eresult?: number;
  // Trade-protection (2025) hold; settlement_date (== time_settlement) is 0 until Accepted.
  delay_settlement?: boolean;
  settlement_date?: number;
  [key: string]: unknown;
}

export interface RawGetTradeOffersResponse {
  trade_offers_sent?: RawCEconTradeOffer[];
  trade_offers_received?: RawCEconTradeOffer[];
  descriptions?: RawDescription[];
  next_cursor?: number;
}

// IEconService/GetTradeStatus assets carry where each item LANDED post-trade (new_assetid/contextid).
export interface RawExchangeAsset {
  appid: number;
  contextid: string;
  assetid: string;
  classid: string;
  instanceid: string;
  amount: string;
  new_assetid?: string;
  new_contextid?: string;
  rollback_new_assetid?: string;
  rollback_new_contextid?: string;
  currencyid?: string;
  [key: string]: unknown;
}

export interface RawTradeStatus {
  tradeid: string;
  steamid_other?: string;
  time_init: number;
  time_settlement?: number;
  status: number;
  assets_received?: RawExchangeAsset[];
  assets_given?: RawExchangeAsset[];
  time_mod?: number;
  [key: string]: unknown;
}

export interface RawGetTradeStatusResponse {
  trades?: RawTradeStatus[];
  descriptions?: RawDescription[];
}

// Verdict from /market/eligibilitycheck/, decoded from the `webTradeEligibility` cookie it sets.
// allowed: 1 = can trade now, 0 = blocked. reason is a bitmask; the *_days/*_at_time fields detail
// the active Steam Guard / new-device holds. All times are unix seconds.
export interface WebTradeEligibility {
  allowed: number;
  reason: number;
  allowed_at_time: number;
  steamguard_required_days: number;
  new_device_cooldown_days: number;
  expiration: number;
  time_checked: number;
  [key: string]: unknown;
}
