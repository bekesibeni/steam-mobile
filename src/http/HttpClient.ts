import got, { type Got } from "got";
import { ProxyAgent } from "proxy-agent";
import { type Cookie, CookieJar } from "tough-cookie";
import { URLS } from "../core/constants.js";
import type { MobileProfile } from "../core/mobileProfile.js";

// Hosts that share our session cookies. api is included because the mobile app sends them to the WebAPI host too.
const COOKIE_HOSTS = [URLS.community, URLS.store, URLS.help, URLS.api];

type Method = "GET" | "POST";
type ResponseType = "text" | "json" | "buffer";
type Scalar = string | number | boolean;

export interface HttpResponse<T = string> {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
}

// Ordered multipart fields; repeated names (e.g. cid[]/ck[]) are allowed and order-significant.
export interface MultipartField {
  name: string;
  value: string;
}

export interface RequestOptions {
  searchParams?: Record<string, Scalar | undefined>;
  form?: Record<string, Scalar | undefined>;
  multipart?: MultipartField[];
  headers?: Record<string, string>;
  responseType?: ResponseType;
  referer?: string;
}

function clean(input?: Record<string, Scalar | undefined>): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k] = String(v);
  }
  return out;
}

// Hand-built to match the Steam mobile app's mobileconf POSTs.
function buildMultipart(fields: MultipartField[], boundary: string): string {
  let out = "";
  for (const { name, value } of fields) {
    out += `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  return `${out}--${boundary}--\r\n`;
}

export class HttpClient {
  readonly jar: CookieJar;
  private readonly client: Got;
  private readonly profile: MobileProfile;

  constructor(opts: { proxy?: string; profile: MobileProfile }) {
    this.jar = new CookieJar();
    this.profile = opts.profile;
    const agent = opts.proxy
      ? (() => {
          const proxy = opts.proxy as string;
          const a = new ProxyAgent({ getProxyForUrl: () => proxy });
          return { http: a, https: a };
        })()
      : undefined;

    this.client = got.extend({
      cookieJar: this.jar,
      throwHttpErrors: false,
      followRedirect: false,
      decompress: true,
      retry: { limit: 0 },
      timeout: { request: 50000 },
      ...(agent ? { agent } : {}),
    });

    // Cookies that mark every request as coming from the Steam mobile app.
    for (const raw of [
      `mobileClient=${this.profile.mobileClient}`,
      `mobileClientVersion=${this.profile.mobileClientVersion}`,
      "Steam_Language=english",
    ]) {
      for (const host of COOKIE_HOSTS) this.jar.setCookieSync(raw, host);
    }
  }

  async request<T = string>(
    method: Method,
    url: string,
    opts: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const res = await this.perform<T>(method, url, opts);
    // Steam gates trade/market pages behind a one-time eligibility check (302 → /market/
    // eligibilitycheck/ → back). We don't auto-follow redirects, so visit it once to prime the
    // session, then retry. A genuinely limited account keeps redirecting and the retry surfaces it.
    const location = firstHeader(res.headers.location);
    if (
      res.statusCode >= 300 &&
      res.statusCode < 400 &&
      location?.includes("/market/eligibilitycheck")
    ) {
      await this.perform("GET", location, {});
      return this.perform<T>(method, url, opts);
    }
    return res;
  }

  private async perform<T = string>(
    method: Method,
    url: string,
    opts: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    // Native app calls (WebAPI + mobileconf) carry the native UA; webview pages carry the web UA (per iOS-app captures).
    const isNative = url.startsWith(URLS.api) || url.includes("/mobileconf/");
    const headers: Record<string, string> = {
      "User-Agent": isNative ? this.profile.apiUserAgent : this.profile.webUserAgent,
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (isNative) {
      // Native app transport: JSON accept, no browser Origin/Sec-Fetch headers.
      headers.Accept = "application/json, text/plain, */*";
    } else if (method !== "GET") {
      headers.Origin = URLS.community;
      if (opts.referer) headers.Referer = opts.referer;
    }
    let body: string | undefined;
    if (opts.multipart) {
      const boundary = `----steamMobile${randomSessionId()}`;
      body = buildMultipart(opts.multipart, boundary);
      headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    }
    Object.assign(headers, opts.headers); // explicit caller headers win

    const res = await this.client(url, {
      method,
      searchParams: clean(opts.searchParams),
      ...(opts.form ? { form: clean(opts.form) } : {}),
      ...(body !== undefined ? { body } : {}),
      headers,
      responseType: (opts.responseType ?? "text") as "text",
    });

    return {
      statusCode: res.statusCode,
      headers: res.headers,
      body: res.body as unknown as T,
    };
  }

  get<T = string>(url: string, opts?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("GET", url, opts);
  }

  post<T = string>(url: string, opts?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>("POST", url, opts);
  }

  async setCookie(rawCookie: string): Promise<void> {
    for (const host of COOKIE_HOSTS) {
      await this.jar.setCookie(rawCookie, host);
    }
  }

  async getSessionId(): Promise<string> {
    const cookies = await this.jar.getCookies(URLS.community);
    const existing = cookies.find((c: Cookie) => c.key === "sessionid");
    if (existing) return existing.value;
    const sessionId = randomSessionId();
    await this.setCookie(`sessionid=${sessionId}`);
    return sessionId;
  }
}

function randomSessionId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
