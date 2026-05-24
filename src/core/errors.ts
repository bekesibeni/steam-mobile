import { isTransientEResult } from "./eresults.js";

// Fallback so every RateLimitError has a concrete unlockAt (Steam never sends Retry-After).
export const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;

export class SteamError extends Error {
  readonly eresult?: number;
  readonly body?: unknown;

  constructor(message: string, options?: { eresult?: number; body?: unknown; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SteamError";
    if (options?.eresult !== undefined) this.eresult = options.eresult;
    if (options?.body !== undefined) this.body = options.body;
  }
}

export class ProxyError extends SteamError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProxyError";
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
  readonly retryAfterMs: number;
  readonly unlockAt: number;

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
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RATE_LIMIT_RETRY_MS;
    this.unlockAt = Date.now() + this.retryAfterMs;
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

// Credential-login failures; carries Steam's extended_error_message when present.
export class LoginError extends SteamError {
  readonly extendedErrorMessage: string | undefined;
  readonly isTransient: boolean;

  constructor(
    message: string,
    options?: { eresult?: number; body?: unknown; extendedErrorMessage?: string },
  ) {
    super(message, options);
    this.name = "LoginError";
    this.extendedErrorMessage = options?.extendedErrorMessage;
    this.isTransient = isTransientEResult(options?.eresult);
  }
}
