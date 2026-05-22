import got, { type Got } from "got";
import { ProxyAgent } from "proxy-agent";
import { type Cookie, CookieJar } from "tough-cookie";
import { URLS, USER_AGENT } from "../core/constants.js";

type Method = "GET" | "POST";
type ResponseType = "text" | "json" | "buffer";
type Scalar = string | number | boolean;

export interface HttpResponse<T = string> {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
}

export interface RequestOptions {
  searchParams?: Record<string, Scalar | undefined>;
  form?: Record<string, Scalar | undefined>;
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

export class HttpClient {
  readonly jar: CookieJar;
  private readonly client: Got;

  constructor(opts: { proxy?: string; userAgent?: string } = {}) {
    this.jar = new CookieJar();
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
      headers: { "User-Agent": opts.userAgent ?? USER_AGENT },
      ...(agent ? { agent } : {}),
    });
  }

  async request<T = string>(
    method: Method,
    url: string,
    opts: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (method !== "GET") {
      headers.Origin = URLS.community;
      if (opts.referer) headers.Referer = opts.referer;
    }

    const res = await this.client(url, {
      method,
      searchParams: clean(opts.searchParams),
      ...(opts.form ? { form: clean(opts.form) } : {}),
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
    for (const host of [URLS.community, URLS.store, URLS.help]) {
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
