import SteamID from "steamid";
import { URLS } from "../core/constants.js";
import type { SteamError } from "../core/errors.js";
import { parseStrError } from "../core/parseStrError.js";
import type { HttpClient } from "./HttpClient.js";

// Scrape <div id="error_msg">…</div> from the trade page — the richer "their inventory is private",
// "trade-banned", "limited account" etc. message Steam shows the user. Regex matches McKay's
// `[^<]+` — text-only, no nested markup.
export async function fetchTradePageErrorMessage(
  http: HttpClient,
  steamId: string,
  token?: string | undefined,
): Promise<string | undefined> {
  const accountId = new SteamID(steamId).accountid;
  const url = `${URLS.community}/tradeoffer/new/?partner=${accountId}${token ? `&token=${token}` : ""}`;
  const res = await http.get<string>(url, {
    responseType: "text",
    headers: { Referer: `${URLS.community}/profiles/${steamId}` },
  });
  if (res.statusCode !== 200) return undefined;
  const match = res.body.match(/<div id="error_msg">\s*([^<]+)\s*<\/div>/);
  return match?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

// Resolve the best error to throw when an inventory endpoint reports a failure. Loads the trade page
// for the richer Steam-rendered message, then classifies (private / trade-ban / new device / etc.).
// Falls back to the JSON body's error string if the page has nothing useful.
export async function inventoryFailureError(
  http: HttpClient,
  steamId: string,
  token: string | undefined,
  bodyMessage: string | undefined,
): Promise<SteamError> {
  const scraped = await fetchTradePageErrorMessage(http, steamId, token).catch(() => undefined);
  const message = scraped ?? bodyMessage ?? "Failed to load inventory";
  return parseStrError(message);
}
