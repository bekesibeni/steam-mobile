// Per-endpoint rate-limit config, from live profiling (Steam doesn't send Retry-After). null = not measured yet.
//   window — `max` calls per `windowMs`.   bucket — `capacity` burst, 1 token refills every `refillMs`.
export type RateLimit =
  | { type: "window"; windowMs: number; max: number }
  | { type: "bucket"; capacity: number; refillMs: number };

export const RATE_LIMITS = {
  partnerInventory: { type: "window", windowMs: 120_000, max: 30 },
  inventory: null,
  GetTradeHistory: { type: "bucket", capacity: 25, refillMs: 15_000 },
  GetTradeOffer: { type: "bucket", capacity: 3750, refillMs: 5 },
  GetTradeOffers: { type: "bucket", capacity: 85, refillMs: 125 },
  GetTradeOffersSummary: { type: "bucket", capacity: 85, refillMs: 125 },
  GetTradeStatus: { type: "bucket", capacity: 25, refillMs: 2000 },
} as const satisfies Record<string, RateLimit | null>;

export type RateLimitedEndpoint = keyof typeof RATE_LIMITS;

function retryAfterMs(limit: RateLimit | null): number | null {
  if (!limit) return null;
  return limit.type === "bucket" ? limit.refillMs : limit.windowMs;
}

// Retry-after hint (ms) per endpoint: one token for a bucket, the full window otherwise.
export const RETRY_AFTER = Object.fromEntries(
  Object.entries(RATE_LIMITS).map(([key, limit]) => [key, retryAfterMs(limit)]),
) as Record<RateLimitedEndpoint, number | null>;
