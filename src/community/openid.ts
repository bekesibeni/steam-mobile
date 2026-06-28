import type { Cookie } from "tough-cookie";
import { URLS } from "../core/constants.js";
import { OpenIdError } from "../core/errors.js";
import type { HttpClient, HttpResponse, MultipartField } from "../http/HttpClient.js";

const STEAM_OPENID_URL = `${URLS.community}/openid/login`;
const DEFAULT_MAX_REDIRECTS = 10;
// got sends no Accept on web requests; a browser does, and a relying party's /login may negotiate on it.
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export interface OpenidConfirmation {
  // The signed assertion redirect Steam issues back to the relying party (carries the openid.* id_res params).
  location: string;
  params: Record<string, string>;
  steamId: string;
}

export interface OpenidCookie {
  name: string;
  value: string;
}

export interface OpenidLoginResult {
  steamId: string;
  // Where the relying party left us once it consumed the assertion.
  finalUrl: string;
  // Cookies the relying party set, scoped to its host - carry these into your own HTTP client.
  cookies: OpenidCookie[];
}

export interface OpenidLoginOptions {
  // The relying party's "Sign in through Steam" entry URL (a plain GET that 302-chains to Steam).
  initiateUrl: string;
  // Host whose cookies to return; defaults to the host we land on.
  cookieHost?: string;
  maxRedirects?: number;
}

function locationOf(res: HttpResponse<string>): string | undefined {
  const loc = res.headers.location;
  return (Array.isArray(loc) ? loc[0] : loc) || undefined;
}

function isRedirect(res: HttpResponse<string>): boolean {
  return res.statusCode >= 300 && res.statusCode < 400 && locationOf(res) !== undefined;
}

function queryParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(url).searchParams) out[k] = v;
  return out;
}

// Decode the HTML entities that occur in form attribute values (&amp; last, so &amp;quot; survives).
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Steam's /openid/login interstitial submits multipart/form-data (urlencoded -> "Invalid Params").
export function parseOpenidForm(html: string): { action: string; fields: MultipartField[] } | null {
  const form = [...html.matchAll(/<form\b([^>]*?)>([\s\S]*?)<\/form>/gi)].find((m) =>
    /openid\/login/i.test(m[1] ?? ""),
  );
  const action = form?.[1]?.match(/\baction=["']([^"']+)["']/i)?.[1];
  if (!form || !action) return null;
  const fields: MultipartField[] = [];
  for (const tag of (form[2] ?? "").match(/<input\b[^>]*>/gi) ?? []) {
    const name = tag.match(/\bname=["']([^"']*)["']/i)?.[1];
    if (!name) continue;
    const value = decodeEntities(tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "");
    fields.push({ name, value });
  }
  return { action: new URL(decodeEntities(action), STEAM_OPENID_URL).toString(), fields };
}

// Confirm a Steam OpenID assertion from an interstitial page you've already loaded (the session must be
// authenticated) and return the signed redirect Steam issues to the relying party. This is the
// protocol-universal leg; consuming `location` (the relying party's own callback) is the caller's concern.
export async function confirmOpenid(
  http: HttpClient,
  interstitialHtml: string,
  referer?: string,
): Promise<OpenidConfirmation> {
  const form = parseOpenidForm(interstitialHtml);
  if (!form) {
    throw new OpenIdError("no Steam OpenID form in the page; the web session is not authenticated");
  }
  const res = await http.post<string>(form.action, {
    multipart: form.fields,
    headers: { Accept: BROWSER_ACCEPT },
    ...(referer ? { referer } : {}),
  });
  const location = isRedirect(res) ? locationOf(res) : undefined;
  if (!location) {
    throw new OpenIdError(`Steam returned no OpenID assertion redirect (HTTP ${res.statusCode})`);
  }
  const params = queryParams(location);
  const claimed = params["openid.claimed_id"] ?? params["openid.identity"] ?? "";
  const steamId = claimed.match(/\/id\/(\d{17})/)?.[1];
  if (!steamId) throw new OpenIdError("OpenID assertion carried no steamid");
  return { location, params, steamId };
}

// Log into a third-party relying party that offers "Sign in through Steam", spending the live web
// session in `http`'s jar. Drives entry -> Steam confirm -> relying-party callback, then returns the
// cookies the site set. Site-specific gates (Cloudflare, device headers, etc.) are the caller's job.
export async function steamOpenidLogin(
  http: HttpClient,
  options: OpenidLoginOptions,
): Promise<OpenidLoginResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  await http.getSessionId(); // a sessionid cookie must accompany steamLoginSecure on the handshake
  const get = (u: string) => http.get<string>(u, { headers: { Accept: BROWSER_ACCEPT } });

  let url = options.initiateUrl;
  let res = await get(url);
  for (let i = 0; i < maxRedirects && isRedirect(res); i++) {
    url = new URL(locationOf(res) as string, url).toString();
    res = await get(url);
  }

  const confirmation = await confirmOpenid(http, res.body, url);

  url = confirmation.location;
  res = await get(url);
  for (let i = 0; i < maxRedirects && isRedirect(res); i++) {
    url = new URL(locationOf(res) as string, url).toString();
    res = await get(url);
  }

  const cookieHost = options.cookieHost ? `https://${options.cookieHost}` : new URL(url).origin;
  const cookies = (await http.jar.getCookies(cookieHost)).map((c: Cookie) => ({
    name: c.key,
    value: c.value,
  }));
  return { steamId: confirmation.steamId, finalUrl: url, cookies };
}
