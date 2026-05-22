import SteamID from "steamid";
import { SteamError } from "./errors.js";
import type { OfferTarget } from "./types.js";

export interface ResolvedTarget {
  steamId: string;
  token: string | undefined;
}

export function resolveTarget(target: OfferTarget): ResolvedTarget {
  if ("tradeUrl" in target && target.tradeUrl) {
    const params = new URL(target.tradeUrl).searchParams;
    const partner = params.get("partner");
    if (!partner) throw new SteamError("invalid trade URL: missing partner");
    const accountId = Number(partner);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new SteamError(`invalid trade URL: non-numeric partner '${partner}'`);
    }
    return {
      steamId: SteamID.fromIndividualAccountID(accountId).getSteamID64(),
      token: params.get("token") ?? undefined,
    };
  }
  if ("steamId" in target && target.steamId) {
    return { steamId: target.steamId, token: target.token };
  }
  throw new SteamError("invalid target: provide tradeUrl or steamId");
}
