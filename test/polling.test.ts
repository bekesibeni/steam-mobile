import SteamID from "steamid";
import { beforeEach, describe, expect, it } from "vitest";
import { EOfferFilter, ETradeOfferState } from "../src/core/enums.js";
import { RateLimitError } from "../src/core/errors.js";
import type { PollData, PollDataStore, PollSource, TradeEvents } from "../src/index.js";
import { Poller } from "../src/index.js";
import { TradeOffer, type TradeOfferDeps } from "../src/trade/TradeOffer.js";

class FakeStore implements PollDataStore {
  saved: PollData | undefined;
  loads = 0;
  saves = 0;
  constructor(private readonly initial?: PollData) {}
  async load(): Promise<PollData | undefined> {
    this.loads++;
    return this.saved ?? this.initial;
  }
  async save(data: PollData): Promise<void> {
    this.saves++;
    this.saved = structuredClone(data);
  }
}

const PARTNER = SteamID.fromIndividualAccountID(46143802);

function makeOffer(o: {
  id: string;
  state: ETradeOfferState;
  isOurOffer?: boolean;
  glitched?: boolean;
  updated?: Date;
}): TradeOffer {
  const offer = new TradeOffer({} as unknown as TradeOfferDeps, { partner: PARTNER, id: o.id });
  offer.state = o.state;
  offer.isOurOffer = o.isOurOffer ?? false;
  offer.glitched = o.glitched ?? false;
  offer.created = new Date(1_700_000_000_000);
  offer.updated = o.updated ?? new Date(1_700_000_000_000);
  return offer;
}

class FakeSource implements PollSource {
  events: { name: keyof TradeEvents; args: unknown[] }[] = [];
  filters: EOfferFilter[] = [];
  private queue: { sent: TradeOffer[]; received: TradeOffer[] }[] = [];
  private err: Error | undefined;

  queueResult(r: { sent?: TradeOffer[]; received?: TradeOffer[] }): void {
    this.queue.push({ sent: r.sent ?? [], received: r.received ?? [] });
  }
  failNext(e: Error): void {
    this.err = e;
  }
  async getOffers(filter: EOfferFilter): Promise<{ sent: TradeOffer[]; received: TradeOffer[] }> {
    this.filters.push(filter);
    if (this.err) {
      const e = this.err;
      this.err = undefined;
      throw e;
    }
    return this.queue.shift() ?? { sent: [], received: [] };
  }
  emit<K extends keyof TradeEvents>(event: K, ...args: TradeEvents[K]): void {
    this.events.push({ name: event, args });
  }
  emitted(name: keyof TradeEvents): { name: keyof TradeEvents; args: unknown[] }[] {
    return this.events.filter((e) => e.name === name);
  }
  reset(): void {
    this.events = [];
  }
}

describe("Poller", () => {
  let src: FakeSource;
  beforeEach(() => {
    src = new FakeSource();
  });

  it("seeds pollData and emits newOffer / unknownOfferSent on the first poll", async () => {
    src.queueResult({
      sent: [makeOffer({ id: "200", state: ETradeOfferState.Active, isOurOffer: true })],
      received: [makeOffer({ id: "100", state: ETradeOfferState.Active })],
    });
    const poller = new Poller(src);

    await poller.poll();

    expect(src.emitted("newOffer")).toHaveLength(1);
    expect(src.emitted("unknownOfferSent")).toHaveLength(1);
    expect(poller.pollData.received["100"]).toBe(ETradeOfferState.Active);
    expect(poller.pollData.sent["200"]).toBe(ETradeOfferState.Active);
    expect(src.emitted("pollSuccess")).toHaveLength(1);
    expect(src.emitted("pollData")).toHaveLength(1);
  });

  it("does not re-emit when a second poll sees no change", async () => {
    const offers = {
      sent: [makeOffer({ id: "200", state: ETradeOfferState.Active, isOurOffer: true })],
      received: [makeOffer({ id: "100", state: ETradeOfferState.Active })],
    };
    const poller = new Poller(src);
    src.queueResult(offers);
    await poller.poll();
    src.reset();

    src.queueResult(offers);
    await poller.poll();

    expect(src.emitted("newOffer")).toHaveLength(0);
    expect(src.emitted("sentOfferChanged")).toHaveLength(0);
    expect(src.emitted("pollData")).toHaveLength(0);
  });

  it("emits sentOfferChanged exactly once with the previous state", async () => {
    const poller = new Poller(src);
    src.queueResult({
      sent: [makeOffer({ id: "200", state: ETradeOfferState.Active, isOurOffer: true })],
    });
    await poller.poll();
    src.reset();

    src.queueResult({
      sent: [
        makeOffer({
          id: "200",
          state: ETradeOfferState.Accepted,
          isOurOffer: true,
          updated: new Date(1_700_000_500_000),
        }),
      ],
    });
    await poller.poll();

    const changed = src.emitted("sentOfferChanged");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.args[1]).toBe(ETradeOfferState.Active);
    expect(poller.pollData.sent["200"]).toBe(ETradeOfferState.Accepted);
  });

  it("a glitched offer blocks cutoff advancement and suppresses the change event", async () => {
    const saved: PollData = {
      offersSince: 1000,
      sent: { "200": ETradeOfferState.Active },
      received: {},
      timestamps: {},
    };
    const poller = new Poller(src, { pollData: saved });
    src.queueResult({
      sent: [
        makeOffer({
          id: "200",
          state: ETradeOfferState.Accepted,
          isOurOffer: true,
          glitched: true,
          updated: new Date(5_000_000),
        }),
      ],
    });

    await poller.poll();

    expect(src.emitted("sentOfferChanged")).toHaveLength(0);
    expect(poller.pollData.offersSince).toBe(1000);
    expect(poller.pollData.sent["200"]).toBe(ETradeOfferState.Active);
  });

  it("does not re-emit known offers when resuming from saved pollData", async () => {
    const saved: PollData = {
      offersSince: 2000,
      sent: { "200": ETradeOfferState.Active },
      received: { "100": ETradeOfferState.Active },
      timestamps: {},
    };
    const poller = new Poller(src, { pollData: saved });
    src.queueResult({
      sent: [makeOffer({ id: "200", state: ETradeOfferState.Active, isOurOffer: true })],
      received: [makeOffer({ id: "100", state: ETradeOfferState.Active })],
    });

    await poller.poll();

    expect(src.emitted("newOffer")).toHaveLength(0);
    expect(src.emitted("unknownOfferSent")).toHaveLength(0);
    expect(src.emitted("receivedOfferChanged")).toHaveLength(0);
  });

  it("backs off until the bucket unlocks on a rate limit, and keeps the loop alive", async () => {
    const poller = new Poller(src, { pollInterval: 15_000 });
    src.failNext(new RateLimitError({ retryAfterMs: 60_000, eresult: 84 }));

    const delay = await poller.poll();

    expect(src.emitted("pollFailure")).toHaveLength(1);
    expect(delay).toBeGreaterThanOrEqual(59_000);
    expect(delay).toBeLessThanOrEqual(61_000);
  });

  it("returns the configured interval after a normal poll", async () => {
    const poller = new Poller(src, { pollInterval: 12_345 });
    src.queueResult({});
    expect(await poller.poll()).toBe(12_345);
  });
});

describe("Poller.pollOnce", () => {
  let src: FakeSource;
  beforeEach(() => {
    src = new FakeSource();
  });

  it("loads the store, returns the diff, and saves the snapshot", async () => {
    const store = new FakeStore();
    const poller = new Poller(src, { store });
    src.queueResult({ received: [makeOffer({ id: "100", state: ETradeOfferState.Active })] });

    const { changes, pollData } = await poller.pollOnce();

    expect(store.loads).toBe(1);
    expect(store.saves).toBe(1);
    expect(changes).toContainEqual(expect.objectContaining({ type: "newOffer" }));
    expect(pollData.received["100"]).toBe(ETradeOfferState.Active);
    expect(store.saved?.received["100"]).toBe(ETradeOfferState.Active);
  });

  it("resumes from the stored snapshot without re-emitting known offers", async () => {
    const store = new FakeStore({
      offersSince: 0,
      sent: {},
      received: { "100": ETradeOfferState.Active },
      timestamps: {},
    });
    const poller = new Poller(src, { store });
    src.queueResult({ received: [makeOffer({ id: "100", state: ETradeOfferState.Active })] });

    const { changes } = await poller.pollOnce();

    expect(store.loads).toBe(1);
    expect(changes).toHaveLength(0);
  });

  it("does not save on an unchanged active-only tick", async () => {
    const store = new FakeStore({
      offersSince: 1,
      sent: {},
      received: {},
      timestamps: {},
      lastFullUpdate: Date.now(),
    });
    const poller = new Poller(src, { store, pollFullUpdateInterval: 300_000 });
    src.queueResult({});
    await poller.pollOnce();
    expect(store.saves).toBe(0);
  });

  it("persists lastFullUpdate so a fresh instance sharing the store skips the full sweep", async () => {
    const store = new FakeStore();
    src.queueResult({});
    await new Poller(src, { store, pollFullUpdateInterval: 300_000 }).pollOnce();
    src.queueResult({});
    await new Poller(src, { store, pollFullUpdateInterval: 300_000 }).pollOnce();
    expect(src.filters).toEqual([EOfferFilter.All, EOfferFilter.ActiveOnly]);
  });
});

describe("Poller pruning", () => {
  let src: FakeSource;
  beforeEach(() => {
    src = new FakeSource();
  });

  it("prunes terminal offers older than the retention window, keeping active and recent ones", async () => {
    const old = Math.floor((Date.now() - 60 * 86_400_000) / 1000); // 60d ago, past the ~44d cutoff
    const recent = Math.floor(Date.now() / 1000);
    const saved: PollData = {
      offersSince: 1,
      sent: {
        "900": ETradeOfferState.Accepted, // terminal + old → pruned
        "901": ETradeOfferState.Active, // non-terminal → kept despite age
        "902": ETradeOfferState.Accepted, // terminal but recent → kept
      },
      received: {},
      timestamps: { "900": old, "901": old, "902": recent },
    };
    const poller = new Poller(src, { pollData: saved });
    src.queueResult({}); // nothing returned this cycle, so "900" is not "seen"

    await poller.poll();

    expect(poller.pollData.sent["900"]).toBeUndefined();
    expect(poller.pollData.timestamps["900"]).toBeUndefined();
    expect(poller.pollData.sent["901"]).toBe(ETradeOfferState.Active);
    expect(poller.pollData.sent["902"]).toBe(ETradeOfferState.Accepted);
  });

  it("does not prune an old terminal offer that was seen this cycle", async () => {
    const old = Math.floor((Date.now() - 60 * 86_400_000) / 1000);
    const saved: PollData = {
      offersSince: 1,
      sent: { "900": ETradeOfferState.Active },
      received: {},
      timestamps: { "900": old },
    };
    const poller = new Poller(src, { pollData: saved });
    src.queueResult({
      sent: [
        makeOffer({
          id: "900",
          state: ETradeOfferState.Accepted,
          isOurOffer: true,
          updated: new Date(),
        }),
      ],
    });

    await poller.poll();

    expect(poller.pollData.sent["900"]).toBe(ETradeOfferState.Accepted);
  });
});
