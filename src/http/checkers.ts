import {
  FamilyViewError,
  HttpStatusError,
  SteamError,
  SteamSessionExpiredError,
} from "../errors.js";
import type { HttpResponse } from "./HttpClient.js";

function locationHeader(res: HttpResponse<unknown>): string {
  const loc = res.headers.location;
  return Array.isArray(loc) ? (loc[0] ?? "") : (loc ?? "");
}

export function checkHttpError(res: HttpResponse<unknown>): void {
  const { statusCode } = res;

  if (statusCode >= 300 && statusCode <= 399 && locationHeader(res).includes("/login")) {
    throw new SteamSessionExpiredError();
  }

  if (
    statusCode === 403 &&
    typeof res.body === "string" &&
    /<div id="parental_notice_instructions">/.test(res.body)
  ) {
    throw new FamilyViewError();
  }

  if (statusCode >= 400) {
    throw new HttpStatusError(statusCode, undefined, res.body);
  }
}

export function checkCommunityError(html: unknown): void {
  if (typeof html !== "string") return;

  const sorry = html.match(/<h1>Sorry!<\/h1>/);
  if (sorry) {
    const match = html.match(/<h3>(.+)<\/h3>/);
    throw new SteamError(match?.[1] ?? "Unknown error occurred");
  }

  if (html.includes("g_steamID = false;") && html.includes("<title>Sign In</title>")) {
    throw new SteamSessionExpiredError();
  }
}

export function checkTradeError(html: unknown): void {
  if (typeof html !== "string") return;
  const match = html.match(/<div id="error_msg">\s*([^<]+)\s*<\/div>/);
  if (match?.[1]) throw new SteamError(match[1].trim());
}

export function checkJsonSessionExpired(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const obj = body as Record<string, unknown>;
  if (obj.needsauth === true || obj.logged_in === false) {
    throw new SteamSessionExpiredError();
  }
}
