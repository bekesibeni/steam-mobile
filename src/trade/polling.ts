import { EOfferFilter, ETradeOfferState } from "../core/enums.js";
import { RateLimitError } from "../core/errors.js";
import type { PollData, PollOptions, TradeEvents } from "./pollTypes.js";
import type { TradeOffer } from "./TradeOffer.js";

export const DEFAULT_POLL_INTERVAL = 10_000;
export const DEFAULT_POLL_FULL_UPDATE_INTERVAL = 300_000;
// Steam backdates offer update times; re-ask 30 min before our last-seen mark so we don't miss one.
const POLL_BACKDATING_BUFFER = 1800;
const MINIMUM_POLL_INTERVAL = 1000;

export interface PollSource {
  getOffers(
    filter: EOfferFilter,
    historicalCutoff: Date,
  ): Promise<{ sent: TradeOffer[]; received: TradeOffer[] }>;
  emit<K extends keyof TradeEvents>(event: K, ...args: TradeEvents[K]): void;
}

function emptyPollData(): PollData {
  return { offersSince: 0, sent: {}, received: {}, timestamps: {} };
}

export class Poller {
  readonly pollData: PollData;
  private readonly pollInterval: number;
  private readonly fullInterval: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFullUpdate = 0;
  private running = false;
  private stopped = true;

  constructor(
    private readonly source: PollSource,
    options: PollOptions = {},
  ) {
    this.pollInterval = Math.max(
      options.pollInterval ?? DEFAULT_POLL_INTERVAL,
      MINIMUM_POLL_INTERVAL,
    );
    this.fullInterval = options.pollFullUpdateInterval ?? DEFAULT_POLL_FULL_UPDATE_INTERVAL;
    this.pollData = options.pollData ?? emptyPollData();
  }

  start(): void {
    this.stopped = false;
    this.schedule(0); // immediate first tick; also a full sweep since lastFullUpdate is 0
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // One poll cycle. Never throws; returns the delay (ms) until the next poll should run.
  async poll(forceFull = false): Promise<number> {
    if (this.running) return this.pollInterval;
    this.running = true;
    try {
      const sinceBase = this.pollData.offersSince
        ? this.pollData.offersSince - POLL_BACKDATING_BUFFER
        : 0;
      let fullUpdate = forceFull;
      let cutoff = sinceBase;
      if (forceFull || Date.now() - this.lastFullUpdate >= this.fullInterval) {
        fullUpdate = true;
        this.lastFullUpdate = Date.now();
        cutoff = 1;
      }
      this.source.emit(
        "debug",
        `Polling trade offers since ${cutoff}${fullUpdate ? " (full update)" : ""}`,
      );

      let result: { sent: TradeOffer[]; received: TradeOffer[] };
      try {
        result = await this.source.getOffers(
          fullUpdate ? EOfferFilter.All : EOfferFilter.ActiveOnly,
          new Date(cutoff * 1000),
        );
      } catch (err) {
        const error = err as Error;
        this.source.emit("debug", `Trade offer poll failed: ${error.message}`);
        this.source.emit("pollFailure", error);
        return this.backoffDelay(error);
      }

      this.process(result.sent, result.received);
      return this.pollInterval;
    } finally {
      this.running = false;
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.poll().then((delay) => this.schedule(delay));
      },
      Math.max(0, ms),
    );
  }

  // On a rate limit, wait until the bucket unlocks (if longer than our interval) to self-tune instead of hammering.
  private backoffDelay(err: Error): number {
    if (err instanceof RateLimitError) {
      const wait = err.unlockAt !== undefined ? err.unlockAt - Date.now() : err.retryAfterMs;
      if (typeof wait === "number" && wait > this.pollInterval) {
        return Math.max(wait, MINIMUM_POLL_INTERVAL);
      }
    }
    return this.pollInterval;
  }

  private process(sentList: TradeOffer[], receivedList: TradeOffer[]): void {
    const before = JSON.stringify(this.pollData);
    const { sent, received, timestamps } = this.pollData;
    let hasGlitched = false;

    for (const offer of sentList) {
      if (!offer.id) continue;
      if (offer.glitched) {
        hasGlitched = true;
        continue;
      }
      const known = sent[offer.id];
      if (known === undefined) this.source.emit("unknownOfferSent", offer);
      else if (offer.state !== known) this.source.emit("sentOfferChanged", offer, known);
      sent[offer.id] = offer.state;
      this.stamp(timestamps, offer);
    }

    for (const offer of receivedList) {
      if (!offer.id) continue;
      if (offer.glitched) {
        hasGlitched = true;
        continue;
      }
      const known = received[offer.id];
      if (known === undefined && offer.state === ETradeOfferState.Active) {
        this.source.emit("newOffer", offer);
      } else if (known !== undefined && offer.state !== known) {
        this.source.emit("receivedOfferChanged", offer, known);
      }
      received[offer.id] = offer.state;
      this.stamp(timestamps, offer);
    }

    // Advance the cutoff only when nothing was glitched, so incomplete offers get re-polled.
    if (!hasGlitched) {
      let latest = this.pollData.offersSince;
      for (const offer of [...sentList, ...receivedList]) {
        const updated = offer.updated ? Math.floor(offer.updated.getTime() / 1000) : 0;
        if (updated > latest) latest = updated;
      }
      this.pollData.offersSince = latest;
    }

    this.source.emit("pollSuccess");
    if (JSON.stringify(this.pollData) !== before) {
      this.source.emit("pollData", this.pollData);
    }
  }

  private stamp(timestamps: Record<string, number>, offer: TradeOffer): void {
    if (offer.id && offer.created)
      timestamps[offer.id] = Math.floor(offer.created.getTime() / 1000);
  }
}
