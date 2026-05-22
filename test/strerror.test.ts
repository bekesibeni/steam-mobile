import { describe, expect, it } from "vitest";
import { EResult } from "../src/core/enums.js";
import { OfferLimitError, SteamError, TradeBanError } from "../src/core/errors.js";
import { parseStrError } from "../src/trade/strError.js";

describe("parseStrError", () => {
  it("maps a trade ban (full upstream phrase) to TradeBanError + cause", () => {
    const err = parseStrError("You cannot trade with PlayerX because they have a trade ban. (15)");
    expect(err).toBeInstanceOf(TradeBanError);
    expect(err.cause).toBe("TradeBan");
  });

  it("maps an offer limit to OfferLimitError + cause", () => {
    const err = parseStrError("You have sent too many trade offers (25)");
    expect(err).toBeInstanceOf(OfferLimitError);
    expect((err as OfferLimitError).eresult).toBe(EResult.LimitExceeded);
    expect(err.cause).toBe("OfferLimitExceeded");
  });

  it("classifies a new-device login", () => {
    const err = parseStrError("You have logged in from a new device. (88)");
    expect(err).toBeInstanceOf(SteamError);
    expect(err.cause).toBe("NewDevice");
    expect(err.eresult).toBe(88);
  });

  it("classifies a target-cannot-trade error", () => {
    const err = parseStrError(
      "PlayerX is not available to trade. More information will be shown to PlayerX.",
    );
    expect(err.cause).toBe("TargetCannotTrade");
  });

  it("falls back to ServiceUnavailable for item-server errors", () => {
    const err = parseStrError(
      "There was an error accepting this trade offer. " +
        "The Steam Community is currently unable to contact the game's item server.",
    );
    expect(err.eresult).toBe(EResult.ServiceUnavailable);
    expect(err.cause).toBe("ItemServerUnavailable");
  });

  it("extracts a trailing eresult for unclassified errors", () => {
    const err = parseStrError("Some other failure (26)");
    expect(err.eresult).toBe(26);
    expect(err.cause).toBeUndefined();
  });
});
