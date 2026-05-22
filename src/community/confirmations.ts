import SteamTotp from "steam-totp";
import type SteamID from "steamid";
import { URLS } from "../core/constants.js";
import { EConfirmationType } from "../core/enums.js";
import { ConfirmationError, SteamSessionExpiredError } from "../core/errors.js";
import { httpError } from "../http/checkers.js";
import type { HttpClient } from "../http/HttpClient.js";

export interface Confirmation {
  id: string;
  type: number;
  creator: string;
  key: string;
  title: string;
  receiving: string;
  sending: string;
  time: string;
  timestamp: Date;
  icon: string;
}

interface RawConfirmation {
  id: string | number;
  type: number;
  creator_id: string | number;
  nonce: string;
  type_name?: string;
  headline?: string;
  summary?: string[];
  creation_time: number;
  icon?: string;
}

interface RawConfListResponse {
  success?: boolean;
  conf?: RawConfirmation[];
  needauth?: boolean;
  message?: string;
  detail?: string;
}

interface RawConfActionResponse {
  success?: boolean;
  message?: string;
}

type ConfKey = string | { tag: string; key: string };

const TIME_OFFSET_TTL_MS = 12 * 60 * 60 * 1000;

export class ConfirmationManager {
  private timeOffset: number | undefined;
  private timeOffsetAt = 0;
  private readonly usedConfTimes: number[] = [];

  constructor(
    private readonly http: HttpClient,
    private readonly steamID: SteamID,
    private readonly identitySecret: string | undefined,
  ) {}

  async getConfirmations(time: number, key: ConfKey): Promise<Confirmation[]> {
    const { tag, k } = splitKey(key, "conf");
    const body = await this.request<RawConfListResponse>("getlist", k, time, tag, null, true);
    if (!body?.success) {
      if (body?.needauth) throw new SteamSessionExpiredError();
      throw new ConfirmationError(
        String(body?.message ?? body?.detail ?? "Failed to get confirmation list"),
      );
    }
    return (body.conf ?? []).map((c) => ({
      id: String(c.id),
      type: Number(c.type),
      creator: String(c.creator_id),
      key: String(c.nonce),
      title: `${c.type_name ?? "Confirm"} - ${c.headline ?? ""}`,
      receiving: Number(c.type) === EConfirmationType.Trade ? String(c.summary?.[1] ?? "") : "",
      sending: String(c.summary?.[0] ?? ""),
      time: new Date(Number(c.creation_time) * 1000).toISOString(),
      timestamp: new Date(Number(c.creation_time) * 1000),
      icon: String(c.icon ?? ""),
    }));
  }

  async respondToConfirmation(
    confID: string,
    confKey: string,
    time: number,
    key: ConfKey,
    accept: boolean,
  ): Promise<void> {
    const { tag, k } = splitKey(key, accept ? "allow" : "cancel");
    const op = accept ? "allow" : "cancel";
    const body = await this.request<RawConfActionResponse>(
      "ajaxop",
      k,
      time,
      tag,
      { op, cid: confID, ck: confKey },
      true,
    );
    if (body?.success) return;
    throw new ConfirmationError(String(body?.message ?? "Could not act on confirmation"));
  }

  // High-level: find the confirmation for an object (e.g. a trade offer id) and accept it.
  async acceptConfirmationForObject(objectID: string): Promise<void> {
    if (!this.identitySecret) {
      throw new ConfirmationError("identitySecret is required to respond to confirmations");
    }
    const offset = await this.getTimeOffset();
    const listTime = SteamTotp.time(offset);
    const listKey = SteamTotp.getConfirmationKey(this.identitySecret, listTime, "list");
    const confs = await this.getConfirmations(listTime, { tag: "list", key: listKey });

    const conf = confs.find((c) => c.creator === String(objectID));
    if (!conf) throw new ConfirmationError(`Could not find confirmation for object ${objectID}`);

    // Each HMAC needs a distinct timestamp; bump locally past any we just used.
    let time = SteamTotp.time(offset);
    let localOffset = 0;
    while (this.usedConfTimes.includes(time)) {
      time = SteamTotp.time(offset) + ++localOffset;
    }
    this.usedConfTimes.push(time);
    if (this.usedConfTimes.length > 60) {
      this.usedConfTimes.splice(0, this.usedConfTimes.length - 60);
    }

    const acceptKey = SteamTotp.getConfirmationKey(this.identitySecret, time, "accept");
    await this.respondToConfirmation(
      conf.id,
      conf.key,
      time,
      { tag: "accept", key: acceptKey },
      true,
    );
  }

  // 2025 trade-protection notice; Steam blocks send() until it's acknowledged once.
  async acknowledgeTradeProtection(): Promise<void> {
    const sessionid = await this.http.getSessionId();
    const res = await this.http.post<unknown>(`${URLS.community}/trade/new/acknowledge`, {
      form: { sessionid, message: 1 },
    });
    if (res.statusCode !== 200) throw httpError(res);
  }

  private async getTimeOffset(): Promise<number> {
    if (this.timeOffset !== undefined && Date.now() - this.timeOffsetAt < TIME_OFFSET_TTL_MS) {
      return this.timeOffset;
    }
    const offset = await new Promise<number>((resolve, reject) => {
      SteamTotp.getTimeOffset((err, off) => (err ? reject(err) : resolve(off ?? 0)));
    });
    this.timeOffset = offset;
    this.timeOffsetAt = Date.now();
    return offset;
  }

  private async request<T>(
    endpoint: string,
    key: string,
    time: number,
    tag: string,
    params: Record<string, string | number> | null,
    json: boolean,
  ): Promise<T> {
    const fullParams = {
      ...(params ?? {}),
      p: SteamTotp.getDeviceID(this.steamID.getSteamID64()),
      a: this.steamID.getSteamID64(),
      k: key,
      t: time,
      m: "react",
      tag,
    };
    const url = `${URLS.community}/mobileconf/${endpoint}`;
    const res = await this.http.get<T>(url, {
      responseType: json ? "json" : "text",
      searchParams: fullParams,
    });
    if (res.statusCode !== 200) throw httpError(res);
    return res.body;
  }
}

function splitKey(key: ConfKey, fallbackTag: string): { tag: string; k: string } {
  return typeof key === "object" ? { tag: key.tag, k: key.key } : { tag: fallbackTag, k: key };
}
