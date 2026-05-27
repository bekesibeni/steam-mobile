import { EOfferFilter, ETradeOfferState } from "../core/enums.js";
import { RateLimitError } from "../core/errors.js";
import { isTerminalState } from "../core/offerState.js";
import type { PollChange, PollData, PollDataStore, PollOptions, TradeEvents } from "./pollTypes.js";
import type { TradeOffer } from "./TradeOffer.js";

export const DEFAULT_POLL_INTERVAL = 10_000;
export const DEFAULT_POLL_FULL_UPDATE_INTERVAL = 300_000;
export const DEFAULT_POLL_MAX_AGE_MS = 2_592_000_000; // 30 days
// Steam backdates offer update times; re-ask 30 min before our last-seen mark so we don't miss one.
const POLL_BACKDATING_BUFFER = 1800;
const MINIMUM_POLL_INTERVAL = 1000;
// Offers expire ~14d after creation; this margin makes prune-by-creation safe against sweep resurrection.
const OFFER_MAX_LIFETIME_MS = 1_209_600_000;

export interface PollSource {
  getTradeOffers(
    filter: EOfferFilter,
    historicalCutoff: Date,
  ): Promise<{ sent: TradeOffer[]; received: TradeOffer[] }>;
  emit<K extends keyof TradeEvents>(event: K, ...args: TradeEvents[K]): void;
}

function emptyPollData(): PollData {
  return { offersSince: 0, sent: {}, received: {}, timestamps: {} };
}

export class Poller {
  pollData: PollData;
  private readonly pollInterval: number;
  private readonly fullInterval: number;
  private readonly maxAgeMs: number;
  private readonly cancelTime: number | undefined;
  private readonly store: PollDataStore | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = true;
  private loaded = false;

  constructor(
    private readonly source: PollSource,
    options: PollOptions = {},
  ) {
    this.pollInterval = Math.max(
      options.pollInterval ?? DEFAULT_POLL_INTERVAL,
      MINIMUM_POLL_INTERVAL,
    );
    this.fullInterval = options.pollFullUpdateInterval ?? DEFAULT_POLL_FULL_UPDATE_INTERVAL;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_POLL_MAX_AGE_MS;
    this.cancelTime = options.cancelTime;
    this.store = options.store;
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

  // Timer cycle. Never throws; returns the delay (ms) until the next poll. Loads the store once on start.
  async poll(forceFull = false): Promise<number> {
    if (this.running) return this.pollInterval;
    this.running = true;
    try {
      if (this.store && !this.loaded) await this.loadFromStore();
      let result: { changes: PollChange[]; changed: boolean };
      try {
        result = await this.runCycle(forceFull);
      } catch (err) {
        const error = err as Error;
        this.source.emit("debug", `Trade offer poll failed: ${error.message}`);
        this.source.emit("pollFailure", error);
        return this.backoffDelay(error);
      }
      if (this.store && result.changed) await this.persist();
      return this.pollInterval;
    } finally {
      this.running = false;
    }
  }

  // Timer-less single cycle for an external scheduler; throws on fetch error (unlike the timer loop).
  async pollOnce(forceFull = false): Promise<{ changes: PollChange[]; pollData: PollData }> {
    if (this.store) await this.loadFromStore();
    const { changes, changed } = await this.runCycle(forceFull);
    if (this.store && changed) await this.persist();
    return { changes, pollData: this.pollData };
  }

  private async loadFromStore(): Promise<void> {
    const loaded = await this.store?.load();
    if (loaded) this.pollData = loaded;
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    try {
      await this.store?.save(this.pollData);
    } catch (err) {
      this.source.emit("debug", `pollData store save failed: ${(err as Error).message}`);
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
      const wait = err.unlockAt - Date.now();
      if (wait > this.pollInterval) return Math.max(wait, MINIMUM_POLL_INTERVAL);
    }
    return this.pollInterval;
  }

  private async runCycle(forceFull: boolean): Promise<{ changes: PollChange[]; changed: boolean }> {
    // Capture before touching lastFullUpdate so an offer-less full sweep still persists the advanced cadence.
    const before = JSON.stringify(this.pollData);
    const sinceBase = this.pollData.offersSince
      ? this.pollData.offersSince - POLL_BACKDATING_BUFFER
      : 0;
    let fullUpdate = forceFull;
    let cutoff = sinceBase;
    if (forceFull || Date.now() - (this.pollData.lastFullUpdate ?? 0) >= this.fullInterval) {
      fullUpdate = true;
      this.pollData.lastFullUpdate = Date.now();
      cutoff = this.sweepCutoffSeconds();
    }
    this.source.emit(
      "debug",
      `Polling trade offers since ${cutoff}${fullUpdate ? " (full update)" : ""}`,
    );

    const result = await this.source.getTradeOffers(
      fullUpdate ? EOfferFilter.All : EOfferFilter.ActiveOnly,
      new Date(cutoff * 1000),
    );
    const changes = this.process(result.sent, result.received, fullUpdate);
    if (this.cancelTime !== undefined) this.autoCancel(result.sent, this.cancelTime);
    this.prune(seenIds(result.sent, result.received));
    const changed = JSON.stringify(this.pollData) !== before;

    this.source.emit("pollSuccess");
    if (changed) this.source.emit("pollData", this.pollData);
    return { changes, changed };
  }

  // Auto-cancel sent offers still Active past cancelTime since their last update (McKay's cancelTime).
  // Fire-and-forget like the upstream; the resulting state change surfaces on a later poll.
  private autoCancel(sentList: TradeOffer[], cancelTime: number): void {
    const now = Date.now();
    for (const offer of sentList) {
      if (offer.state !== ETradeOfferState.Active || !offer.updated) continue;
      if (now - offer.updated.getTime() < cancelTime) continue;
      void offer.cancel().then(
        () => this.source.emit("sentOfferCanceled", offer, "cancelTime"),
        (err: Error) =>
          this.source.emit("debug", `Can't auto-cancel offer #${offer.id}: ${err.message}`),
      );
    }
  }

  // Bound the full sweep to the retention window so it stays cheap and can't return already-pruned offers.
  private sweepCutoffSeconds(): number {
    return Math.max(1, Math.floor((Date.now() - this.maxAgeMs) / 1000));
  }

  private process(
    sentList: TradeOffer[],
    receivedList: TradeOffer[],
    fullUpdate: boolean,
  ): PollChange[] {
    const changes: PollChange[] = [];
    const { sent, received, timestamps } = this.pollData;
    let hasGlitched = false;

    for (const offer of sentList) {
      if (!offer.id) continue;
      const known = sent[offer.id];
      if (known === undefined) {
        // Unknown sent offer: record + announce regardless of glitch (matches steam-tradeoffer-manager).
        // Skipping these strands the cutoff at 0 and re-announces them on every poll.
        this.record(changes, { type: "unknownOfferSent", offer });
      } else if (offer.state !== known) {
        if (offer.glitched) {
          // Defer a glitched state change so it's re-polled with full item data; blocks cutoff advance.
          hasGlitched = true;
          continue;
        }
        this.record(changes, { type: "sentOfferChanged", offer, oldState: known });
      }
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
        this.record(changes, { type: "newOffer", offer });
      } else if (known !== undefined && offer.state !== known) {
        this.record(changes, { type: "receivedOfferChanged", offer, oldState: known });
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
      // A full sweep observes all state up to now, so floor offersSince to now even when no offers
      // come back. Otherwise it stays 0 and active polls send time_historical_cutoff=0, which Steam
      // answers erratically (misses declines, resurfaces old offers as "new"). Our sweep is bounded
      // to maxAgeMs, so unlike McKay's epoch sweep it can legitimately return nothing.
      if (fullUpdate) latest = Math.max(latest, Math.floor(Date.now() / 1000));
      this.pollData.offersSince = latest;
    }
    return changes;
  }

  // Record a change and emit it as both its specific named event and the unified offerUpdate event.
  private record(changes: PollChange[], change: PollChange): void {
    changes.push(change);
    switch (change.type) {
      case "newOffer":
        this.source.emit("newOffer", change.offer);
        break;
      case "unknownOfferSent":
        this.source.emit("unknownOfferSent", change.offer);
        break;
      case "sentOfferChanged":
        this.source.emit("sentOfferChanged", change.offer, change.oldState);
        break;
      case "receivedOfferChanged":
        this.source.emit("receivedOfferChanged", change.offer, change.oldState);
        break;
    }
    const previousState = "oldState" in change ? change.oldState : undefined;
    this.source.emit("offerUpdate", {
      offer: change.offer,
      ...(previousState !== undefined ? { previousState } : {}),
    });
  }

  // Drop terminal offers older than the retention window; never prune one seen this cycle.
  private prune(seen: Set<string>): void {
    const cutoff = Math.floor((Date.now() - this.maxAgeMs - OFFER_MAX_LIFETIME_MS) / 1000);
    this.pruneMap(this.pollData.sent, seen, cutoff);
    this.pruneMap(this.pollData.received, seen, cutoff);
  }

  private pruneMap(map: Record<string, ETradeOfferState>, seen: Set<string>, cutoff: number): void {
    for (const id of Object.keys(map)) {
      const state = map[id];
      const created = this.pollData.timestamps[id];
      if (
        !seen.has(id) &&
        state !== undefined &&
        isTerminalState(state) &&
        created !== undefined &&
        created > 0 &&
        created < cutoff
      ) {
        delete map[id];
        delete this.pollData.timestamps[id];
      }
    }
  }

  private stamp(timestamps: Record<string, number>, offer: TradeOffer): void {
    if (offer.id && offer.created)
      timestamps[offer.id] = Math.floor(offer.created.getTime() / 1000);
  }
}

function seenIds(sent: TradeOffer[], received: TradeOffer[]): Set<string> {
  const ids = new Set<string>();
  for (const offer of [...sent, ...received]) if (offer.id) ids.add(offer.id);
  return ids;
}
