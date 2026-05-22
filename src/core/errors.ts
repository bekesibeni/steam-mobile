export class SteamError extends Error {
  readonly eresult?: number;
  readonly body?: unknown;

  constructor(message: string, options?: { eresult?: number; body?: unknown }) {
    super(message);
    this.name = "SteamError";
    if (options?.eresult !== undefined) this.eresult = options.eresult;
    if (options?.body !== undefined) this.body = options.body;
  }
}

export class HttpStatusError extends SteamError {
  readonly statusCode: number;

  constructor(statusCode: number, message?: string, body?: unknown) {
    super(message ?? `HTTP error ${statusCode}`, { body });
    this.name = "HttpStatusError";
    this.statusCode = statusCode;
  }
}

export class SteamSessionExpiredError extends SteamError {
  constructor(message = "Not Logged In") {
    super(message);
    this.name = "SteamSessionExpiredError";
  }
}

export class RateLimitError extends SteamError {
  readonly statusCode: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly unlockAt: number | undefined;

  constructor(
    options: {
      message?: string;
      body?: unknown;
      retryAfterMs?: number;
      eresult?: number;
      statusCode?: number;
    } = {},
  ) {
    super(options.message ?? "Rate limit exceeded", {
      ...(options.eresult !== undefined ? { eresult: options.eresult } : {}),
      body: options.body,
    });
    this.name = "RateLimitError";
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    this.unlockAt =
      options.retryAfterMs !== undefined ? Date.now() + options.retryAfterMs : undefined;
  }
}

export class EscrowError extends SteamError {
  readonly escrowDays: number;

  constructor(escrowDays: number, message?: string) {
    super(message ?? `Trade would be held in escrow for ${escrowDays} days`);
    this.name = "EscrowError";
    this.escrowDays = escrowDays;
  }
}

export class TradeBanError extends SteamError {
  constructor(message = "Trade ban") {
    super(message);
    this.name = "TradeBanError";
  }
}

export class OfferLimitError extends SteamError {
  constructor(message = "Sent too many trade offers") {
    super(message, { eresult: 25 });
    this.name = "OfferLimitError";
  }
}

export class ConfirmationError extends SteamError {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationError";
  }
}

export class FamilyViewError extends SteamError {
  constructor(message = "Family View Restricted") {
    super(message);
    this.name = "FamilyViewError";
  }
}
