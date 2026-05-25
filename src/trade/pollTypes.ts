import type { ETradeOfferState } from "../core/enums.js";
import type { TradeOffer } from "./TradeOffer.js";

// Persisted between runs (via the `pollData` event) and passed back to startPolling so a restart doesn't re-emit known offers.
export interface PollData {
  // Unix seconds of the newest fully-processed offer update; active poll asks only for changes since this minus the backdating buffer.
  offersSince: number;
  sent: Record<string, ETradeOfferState>;
  received: Record<string, ETradeOfferState>;
  timestamps: Record<string, number>;
  lastFullUpdate?: number;
}

export interface PollDataStore {
  load(): Promise<PollData | undefined>;
  save(pollData: PollData): Promise<void>;
}

export type PollChange =
  | { type: "newOffer"; offer: TradeOffer }
  | { type: "sentOfferChanged"; offer: TradeOffer; oldState: ETradeOfferState }
  | { type: "receivedOfferChanged"; offer: TradeOffer; oldState: ETradeOfferState }
  | { type: "unknownOfferSent"; offer: TradeOffer };

export interface TradeOfferUpdate {
  offer: TradeOffer;
  previousState?: ETradeOfferState;
}

export interface PollOptions {
  // Active-only poll cadence (ms). GetTradeOffers is a token bucket (~85 burst, ~8/s), so aggressive intervals stay in budget.
  pollInterval?: number;
  // Full-sweep cadence (ms): re-reads all offers to catch backdated state changes.
  pollFullUpdateInterval?: number;
  pollData?: PollData;
  store?: PollDataStore;
  maxAgeMs?: number;
  // Auto-cancel a sent offer still Active this many ms after its last update (McKay's cancelTime).
  cancelTime?: number;
}

export interface TradeEvents {
  newOffer: [offer: TradeOffer];
  // Second arg is the previous state.
  sentOfferChanged: [offer: TradeOffer, oldState: ETradeOfferState];
  receivedOfferChanged: [offer: TradeOffer, oldState: ETradeOfferState];
  // A sent offer we hadn't recorded (sent out-of-band, or the first cold poll).
  unknownOfferSent: [offer: TradeOffer];
  // The poller auto-canceled a sent offer; reason is currently always "cancelTime".
  sentOfferCanceled: [offer: TradeOffer, reason: string];
  // Fires once for every offer change, in addition to the specific event above.
  offerUpdate: [update: TradeOfferUpdate];
  // The pollData snapshot changed — persist it.
  pollData: [data: PollData];
  pollSuccess: [];
  pollFailure: [error: Error];
  debug: [message: string];
}
