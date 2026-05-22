import { EResult } from "../core/enums.js";
import { OfferLimitError, SteamError, TradeBanError } from "../core/errors.js";

// Maps Steam's `strError` body string into a typed error, mirroring
// steam-tradeoffer-manager's makeAnError: trailing "(eresult)", known phrases, and the
// `cause` discriminator it attaches (kept so callers can branch the same way).
export function parseStrError(message: string): SteamError {
  const match = message.match(/\((\d+)\)$/);
  const eresult = match?.[1] !== undefined ? Number(match[1]) : undefined;
  const opts = eresult !== undefined ? { eresult } : undefined;

  if (/You cannot trade with .* because they have a trade ban\./.test(message)) {
    return tag(new TradeBanError(message), "TradeBan");
  }
  if (/sent too many trade offers/.test(message)) {
    return tag(new OfferLimitError(message), "OfferLimitExceeded");
  }
  if (/You have logged in from a new device/.test(message)) {
    return tag(new SteamError(message, opts), "NewDevice");
  }
  if (/is not available to trade\. More information will be shown to/.test(message)) {
    return tag(new SteamError(message, opts), "TargetCannotTrade");
  }
  if (/unable to contact the game's item server/.test(message)) {
    return tag(
      new SteamError(message, { eresult: eresult ?? EResult.ServiceUnavailable }),
      "ItemServerUnavailable",
    );
  }
  return new SteamError(message, opts);
}

function tag<T extends SteamError>(err: T, cause: string): T {
  (err as { cause?: unknown }).cause = cause;
  return err;
}
