import type { ETradeOfferState } from "../core/enums.js";
import type { TradeOffer } from "./TradeOffer.js";

// Persisted between runs (via the `pollData` event) and passed back to startPolling so a restart doesn't re-emit known offers.
export interface PollData {
  // Unix seconds of the newest fully-processed offer update; active poll asks only for changes since this minus the backdating buffer.
  offersSince: number;
  sent: Record<string, ETradeOfferState>;
  received: Record<string, ETradeOfferState>;
  timestamps: Record<string, number>;
}

export interface PollOptions {
  // Active-only poll cadence (ms). GetTradeOffers is a token bucket (~85 burst, ~8/s), so aggressive intervals stay in budget.
  pollInterval?: number;
  // Full-sweep cadence (ms): re-reads all offers to catch backdated state changes.
  pollFullUpdateInterval?: number;
  pollData?: PollData;
}

export interface TradeEvents {
  newOffer: [offer: TradeOffer];
  // Second arg is the previous state.
  sentOfferChanged: [offer: TradeOffer, oldState: ETradeOfferState];
  receivedOfferChanged: [offer: TradeOffer, oldState: ETradeOfferState];
  // A sent offer we hadn't recorded (sent out-of-band, or the first cold poll).
  unknownOfferSent: [offer: TradeOffer];
  // The pollData snapshot changed — persist it.
  pollData: [data: PollData];
  pollSuccess: [];
  pollFailure: [error: Error];
  debug: [message: string];
}
