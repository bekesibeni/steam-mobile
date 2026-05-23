import { LANG } from "../core/constants.js";
import type { ETradeStatus } from "../core/enums.js";
import { SteamError } from "../core/errors.js";
import { RETRY_AFTER } from "../core/rateLimits.js";
import type { RawExchangeAsset, RawTradeStatus } from "../core/types.js";
import type { WebApiClient } from "../http/webApi.js";
import {
  buildDescriptionMap,
  buildItem,
  type EconItem,
  type RawDescription,
} from "../models/EconItem.js";

// EconItem + where it landed after settlement. new_assetid/new_contextid: Rust populates, CS2 omits.
export interface ExchangeItem extends EconItem {
  new_assetid?: string;
  new_contextid?: string;
  rollback_new_assetid?: string;
  rollback_new_contextid?: string;
}

export interface ExchangeDetails {
  status: ETradeStatus;
  tradeInitTime: Date;
  settlementTime: Date | null;
  receivedItems: ExchangeItem[];
  sentItems: ExchangeItem[];
  usedInventoryFallback: boolean; // always false; inventory-diff reconcile is the server's job
}

export interface TradeHistoryEntry extends ExchangeDetails {
  tradeId: string;
  partnerSteamId: string | undefined;
}

export interface TradeHistory {
  trades: TradeHistoryEntry[];
  more: boolean;
  totalTrades: number | undefined;
}

export interface TradeHistoryOptions {
  maxTrades?: number;
  startAfterTime?: number;
  startAfterTradeId?: string;
  navigatingBack?: boolean;
  includeFailed?: boolean;
  includeTotal?: boolean;
}

export interface TradeOffersSummary {
  pending_received_count: number;
  new_received_count: number;
  updated_received_count: number;
  historical_received_count: number;
  pending_sent_count: number;
  newly_accepted_sent_count: number;
  updated_sent_count: number;
  historical_sent_count: number;
  escrow_received_count: number;
  escrow_sent_count: number;
}

function parseTrade(
  trade: RawTradeStatus,
  descriptions: Map<string, RawDescription>,
): ExchangeDetails {
  const toItem = (a: RawExchangeAsset): ExchangeItem =>
    buildItem(
      a,
      descriptions.get(`${a.appid}_${a.classid}_${a.instanceid ?? "0"}`),
      [],
      a.contextid,
    ) as ExchangeItem;
  return {
    status: trade.status,
    tradeInitTime: new Date(trade.time_init * 1000),
    settlementTime: trade.time_settlement ? new Date(trade.time_settlement * 1000) : null,
    receivedItems: (trade.assets_received ?? []).map(toItem),
    sentItems: (trade.assets_given ?? []).map(toItem),
    usedInventoryFallback: false,
  };
}

// Needs the tradeID (set on offer accept), not the offer id.
export async function getTradeStatus(api: WebApiClient, tradeId: string): Promise<ExchangeDetails> {
  const body = await api.call<{
    response?: { trades?: RawTradeStatus[]; descriptions?: RawDescription[] };
  }>({
    httpMethod: "GET",
    iface: "IEconService",
    method: "GetTradeStatus",
    retryAfterMs: RETRY_AFTER.GetTradeStatus,
    input: { tradeid: tradeId, get_descriptions: 1, ...LANG },
  });

  const trades = body.response?.trades ?? [];
  // ?? the lone trade on an id-format mismatch; never guess from a multi-trade response.
  const trade =
    trades.find((t) => t.tradeid === tradeId) ?? (trades.length === 1 ? trades[0] : undefined);
  if (!trade) throw new SteamError(`Trade ${tradeId} not found in GetTradeStatus response`);
  return parseTrade(trade, buildDescriptionMap(body.response?.descriptions));
}

// Past trades, newest first. Cursor-paginate via startAfterTime + startAfterTradeId while `more`.
export async function getTradeHistory(
  api: WebApiClient,
  opts: TradeHistoryOptions = {},
): Promise<TradeHistory> {
  const body = await api.call<{
    response?: {
      more?: boolean;
      total_trades?: number;
      trades?: RawTradeStatus[];
      descriptions?: RawDescription[];
    };
  }>({
    httpMethod: "GET",
    iface: "IEconService",
    method: "GetTradeHistory",
    retryAfterMs: RETRY_AFTER.GetTradeHistory,
    input: {
      max_trades: opts.maxTrades ?? 100,
      get_descriptions: 1,
      include_failed: opts.includeFailed ? 1 : 0,
      include_total: opts.includeTotal ? 1 : 0,
      ...(opts.startAfterTime !== undefined ? { start_after_time: opts.startAfterTime } : {}),
      ...(opts.startAfterTradeId !== undefined
        ? { start_after_tradeid: opts.startAfterTradeId }
        : {}),
      ...(opts.navigatingBack ? { navigating_back: 1 } : {}),
      ...LANG,
    },
  });

  const resp = body.response ?? {};
  const descriptions = buildDescriptionMap(resp.descriptions);
  const trades = (resp.trades ?? []).map((t) => ({
    ...parseTrade(t, descriptions),
    tradeId: t.tradeid,
    partnerSteamId: t.steamid_other,
  }));
  return { trades, more: resp.more ?? false, totalTrades: resp.total_trades };
}

export async function getTradeOffersSummary(api: WebApiClient): Promise<TradeOffersSummary> {
  const body = await api.call<{ response?: Partial<TradeOffersSummary> }>({
    httpMethod: "GET",
    iface: "IEconService",
    method: "GetTradeOffersSummary",
    retryAfterMs: RETRY_AFTER.GetTradeOffersSummary,
    input: { time_last_visit: 0 },
  });
  const r = body.response ?? {};
  return {
    pending_received_count: r.pending_received_count ?? 0,
    new_received_count: r.new_received_count ?? 0,
    updated_received_count: r.updated_received_count ?? 0,
    historical_received_count: r.historical_received_count ?? 0,
    pending_sent_count: r.pending_sent_count ?? 0,
    newly_accepted_sent_count: r.newly_accepted_sent_count ?? 0,
    updated_sent_count: r.updated_sent_count ?? 0,
    historical_sent_count: r.historical_sent_count ?? 0,
    escrow_received_count: r.escrow_received_count ?? 0,
    escrow_sent_count: r.escrow_sent_count ?? 0,
  };
}
