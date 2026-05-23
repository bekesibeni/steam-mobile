export const LANG = { l: "english", language: "en" } as const;

export const URLS = {
  community: "https://steamcommunity.com",
  store: "https://store.steampowered.com",
  help: "https://help.steampowered.com",
  api: "https://api.steampowered.com",
} as const;

export const DEFAULT_CONTEXTID = "2";

export const ACCESS_TOKEN_RENEW_THRESHOLD_SECONDS = 300;
// When the refresh token is within this window of expiry, mint with renew=true to rotate it
// (the MobileApp self-renew path) so an active client's credential never lapses.
export const REFRESH_TOKEN_RENEW_THRESHOLD_SECONDS = 30 * 86_400;
