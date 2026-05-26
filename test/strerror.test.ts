import { describe, expect, it } from "vitest";
import { EResult } from "../src/core/enums.js";
import {
  ItemServerUnavailableError,
  NewDeviceError,
  OfferLimitError,
  PrivateInventoryError,
  SteamError,
  TargetCannotTradeError,
  TradeBanError,
} from "../src/core/errors.js";
import { parseStrError } from "../src/core/parseStrError.js";

describe("parseStrError", () => {
  it("maps a trade ban to TradeBanError", () => {
    const err = parseStrError("You cannot trade with PlayerX because they have a trade ban. (15)");
    expect(err).toBeInstanceOf(TradeBanError);
  });

  it("maps an offer limit to OfferLimitError with LimitExceeded eresult", () => {
    const err = parseStrError("You have sent too many trade offers (25)");
    expect(err).toBeInstanceOf(OfferLimitError);
    expect((err as OfferLimitError).eresult).toBe(EResult.LimitExceeded);
  });

  it("maps a new-device login to NewDeviceError", () => {
    const err = parseStrError("You have logged in from a new device. (88)");
    expect(err).toBeInstanceOf(NewDeviceError);
    expect(err.eresult).toBe(88);
  });

  it("maps a target-cannot-trade message to TargetCannotTradeError", () => {
    const err = parseStrError(
      "PlayerX is not available to trade. More information will be shown to PlayerX.",
    );
    expect(err).toBeInstanceOf(TargetCannotTradeError);
  });

  it("maps an item-server outage to ItemServerUnavailableError with ServiceUnavailable eresult", () => {
    const err = parseStrError(
      "There was an error accepting this trade offer. " +
        "The Steam Community is currently unable to contact the game's item server.",
    );
    expect(err).toBeInstanceOf(ItemServerUnavailableError);
    expect(err.eresult).toBe(EResult.ServiceUnavailable);
  });

  it("maps a trade-page privacy message to PrivateInventoryError", () => {
    const err = parseStrError(
      "They don't understand's inventory privacy is set to \"Private\". They are unable to receive trade offers.",
    );
    expect(err).toBeInstanceOf(PrivateInventoryError);
  });

  it("maps the legacy 'inventory is currently private' phrase to PrivateInventoryError", () => {
    const err = parseStrError("This user's inventory is currently private.");
    expect(err).toBeInstanceOf(PrivateInventoryError);
  });

  it("extracts a trailing eresult for unclassified errors", () => {
    const err = parseStrError("Some other failure (26)");
    expect(err.constructor).toBe(SteamError);
    expect(err.eresult).toBe(26);
  });
});
