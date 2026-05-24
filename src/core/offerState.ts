import { ETradeOfferState } from "./enums.js";

// States where the offer can still change (pruning must not drop these).
const NON_TERMINAL: ReadonlySet<ETradeOfferState> = new Set([
  ETradeOfferState.Active,
  ETradeOfferState.CreatedNeedsConfirmation,
  ETradeOfferState.InEscrow,
]);

export function isTerminalState(state: ETradeOfferState): boolean {
  return !NON_TERMINAL.has(state);
}
