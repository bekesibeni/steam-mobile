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

// Steam OpenID relying-party login failed (no interstitial form, missing assertion redirect, etc.).
export class OpenIdError extends SteamError {
  constructor(message: string) {
    super(message);
    this.name = "OpenIdError";
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

// Steam blocks the action because we logged in from a new device recently.
export class NewDeviceError extends SteamError {
  constructor(message = "You have logged in from a new device", options?: { eresult?: number }) {
    super(message, options);
    this.name = "NewDeviceError";
  }
}

// Target account is not in a state where it can complete trades (limited, escrow-only, etc.).
export class TargetCannotTradeError extends SteamError {
  constructor(message = "This user is not available to trade", options?: { eresult?: number }) {
    super(message, options);
    this.name = "TargetCannotTradeError";
  }
}

// The game's item server (its Game Coordinator) is unreachable — transient, per-app, retry later.
export class ItemServerUnavailableError extends SteamError {
  constructor(
    message = "Steam is currently unable to contact the game's item server",
    options?: { eresult?: number },
  ) {
    super(message, { eresult: options?.eresult ?? 102 });
    this.name = "ItemServerUnavailableError";
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

// Partner/profile inventory is private (or friends-only and we're not friends).
// A trade URL/token does NOT bypass inventory privacy — only inventory privacy does.
export class PrivateInventoryError extends SteamError {
  constructor(message = "This profile's inventory is private.") {
    super(message);
    this.name = "PrivateInventoryError";
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

// sharedSecret was supplied but the account has no mobile authenticator attached, so TOTP can't
// answer the guard challenge. Use steamGuardCode / onSteamGuardRequired with an email code instead.
export class NoMobileAuthenticatorError extends LoginError {
  constructor(
    message = "account has no mobile authenticator attached; sharedSecret cannot be used (account uses email Steam Guard)",
  ) {
    super(message);
    this.name = "NoMobileAuthenticatorError";
  }
}
