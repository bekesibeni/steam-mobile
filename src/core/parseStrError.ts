import { EResult } from "./enums.js";
import {
  ItemServerUnavailableError,
  NewDeviceError,
  OfferLimitError,
  PrivateInventoryError,
  SteamError,
  TargetCannotTradeError,
  TradeBanError,
} from "./errors.js";

// Classify a Steam-supplied error string (sendOffer `strError`, accept-offer body, or scraped trade-page
// <div id="error_msg">) into the right typed error. Mirrors steam-tradeoffer-manager's makeAnError
// taxonomy plus the inventory-privacy case Steam shows on the trade page.
export function parseStrError(message: string): SteamError {
  const match = message.match(/\((\d+)\)$/);
  const eresult = match?.[1] !== undefined ? Number(match[1]) : undefined;
  const opts = eresult !== undefined ? { eresult } : undefined;

  if (/You cannot trade with .* because they have a trade ban\./.test(message)) {
    return new TradeBanError(message);
  }
  if (/sent too many trade offers/.test(message)) {
    return new OfferLimitError(message);
  }
  if (/You have logged in from a new device/.test(message)) {
    return new NewDeviceError(message, opts);
  }
  if (/is not available to trade\. More information will be shown to/.test(message)) {
    return new TargetCannotTradeError(message, opts);
  }
  if (/unable to contact the game's item server/.test(message)) {
    return new ItemServerUnavailableError(message, {
      eresult: eresult ?? EResult.ServiceUnavailable,
    });
  }
  if (
    /inventory privacy is set to|inventory is (?:currently )?private|profile's inventory is private/i.test(
      message,
    )
  ) {
    return new PrivateInventoryError(message);
  }
  return new SteamError(message, opts);
}
