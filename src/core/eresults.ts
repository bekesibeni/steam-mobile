import { EResult } from "./enums.js";

export const TRANSIENT_ERESULTS: ReadonlySet<number> = new Set([
  EResult.ServiceUnavailable,
  EResult.Busy,
  EResult.Timeout,
  EResult.TryAnotherCM,
  EResult.RemoteCallFailed,
]);

export function isTransientEResult(eresult: number | undefined): boolean {
  return eresult !== undefined && TRANSIENT_ERESULTS.has(eresult);
}

// Confirmed-dead-token eresults; anything else is treated as transient so a blip never re-bootstraps.
export const TERMINAL_AUTH_ERESULTS: ReadonlySet<number> = new Set([
  EResult.InvalidPassword,
  EResult.AccessDenied,
  EResult.Revoked,
  EResult.Expired,
]);

export function isTerminalAuthEResult(eresult: number | undefined): boolean {
  return eresult !== undefined && TERMINAL_AUTH_ERESULTS.has(eresult);
}
