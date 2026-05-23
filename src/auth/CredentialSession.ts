import { EventEmitter } from "node:events";
import SteamID from "steamid";
import { EAuthSessionGuardType } from "../core/enums.js";
import { LoginError } from "../core/errors.js";
import type { MobileProfile } from "../core/mobileProfile.js";
import { encryptPassword } from "../crypto/rsa.js";
import { getAuthCode } from "../crypto/steamTotp.js";
import type { HttpClient } from "../http/HttpClient.js";
import { ESessionPersistence } from "../protobufs/steammessages_auth_pb.js";
import { AuthClient } from "./AuthClient.js";
import { buildDeviceDetails } from "./deviceDetails.js";

export interface CredentialSessionEvents {
  debug: [message: string];
  authenticated: [];
  timeout: [];
  error: [error: Error];
  // No code could be supplied automatically; caller must submitSteamGuardCode().
  steamGuardRequired: [info: { type: EAuthSessionGuardType; message: string }];
  remoteInteraction: [];
  steamGuardMachineToken: [token: string];
}

export interface CredentialStartOptions {
  accountName: string;
  password: string;
  sharedSecret?: string; // answers DeviceCode automatically via TOTP
  steamGuardCode?: string;
  machineToken?: string;
}

const DEFAULT_POLL_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

// Drives one credential login (rsaKey -> encrypt -> begin -> answer guard -> poll) to a refresh token.
export class CredentialSession extends EventEmitter<CredentialSessionEvents> {
  private readonly auth: AuthClient;
  private clientId = 0n;
  private requestId: Uint8Array = new Uint8Array();
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private allowedConfirmations: EAuthSessionGuardType[] = [];
  private deadline = 0;
  private pollTimer: NodeJS.Timeout | undefined;
  private settled = false;
  private remoteInteractionEmitted = false;

  steamID: SteamID | undefined;
  accountName = "";
  accessToken: string | undefined;
  refreshToken: string | undefined;
  steamGuardMachineToken: string | undefined;

  constructor(
    http: HttpClient,
    private readonly profile: MobileProfile,
    private readonly pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  ) {
    super();
    this.auth = new AuthClient(http);
  }

  async start(opts: CredentialStartOptions): Promise<void> {
    this.accountName = opts.accountName;
    const rsa = await this.auth.getPasswordRSAPublicKey(opts.accountName);
    const encryptedPassword = encryptPassword(opts.password, rsa.publickeyMod, rsa.publickeyExp);

    // device_friendly_name and platform_type go only inside device_details, matching the iOS app.
    const begin = await this.auth.beginAuthSessionViaCredentials({
      accountName: opts.accountName,
      encryptedPassword,
      encryptionTimestamp: rsa.timestamp,
      rememberLogin: true,
      persistence: ESessionPersistence.k_ESessionPersistence_Persistent,
      websiteId: "Mobile",
      deviceDetails: buildDeviceDetails(this.profile),
      language: 0,
      ...(opts.machineToken ? { guardData: opts.machineToken } : {}),
    });

    // A successful begin always returns a request_id; its absence (not clientId, which can be 0n)
    // means Steam rejected the login.
    if (begin.requestId.length === 0) {
      throw new LoginError(begin.extendedErrorMessage || "login was rejected by Steam", {
        ...(begin.extendedErrorMessage ? { extendedErrorMessage: begin.extendedErrorMessage } : {}),
      });
    }

    this.clientId = begin.clientId;
    this.requestId = begin.requestId;
    if (begin.steamid) this.steamID = new SteamID(begin.steamid.toString());
    if (begin.interval > 0) this.pollIntervalMs = Math.round(begin.interval * 1000);
    this.allowedConfirmations = begin.allowedConfirmations.map((c) => Number(c.confirmationType));
    this.emit("debug", `begin OK: confirmations=[${this.allowedConfirmations.join(",")}]`);

    await this.answerConfirmations(opts);

    this.deadline = Date.now() + this.pollTimeoutMs;
    this.schedulePoll();
  }

  async submitSteamGuardCode(code: string): Promise<void> {
    const trimmed = code?.trim();
    if (!trimmed) throw new LoginError("a Steam Guard code is required");
    const codeType = this.allowedConfirmations.includes(EAuthSessionGuardType.DeviceCode)
      ? EAuthSessionGuardType.DeviceCode
      : EAuthSessionGuardType.EmailCode;
    await this.submitCode(trimmed, codeType);
  }

  stop(): void {
    this.settled = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async answerConfirmations(opts: CredentialStartOptions): Promise<void> {
    const allowed = this.allowedConfirmations;

    if (allowed.includes(EAuthSessionGuardType.DeviceCode) && opts.sharedSecret) {
      const code = getAuthCode(opts.sharedSecret);
      this.emit("debug", "answering DeviceCode with generated TOTP");
      await this.submitCode(code, EAuthSessionGuardType.DeviceCode);
      return;
    }

    if (opts.steamGuardCode) {
      const codeType = allowed.includes(EAuthSessionGuardType.DeviceCode)
        ? EAuthSessionGuardType.DeviceCode
        : EAuthSessionGuardType.EmailCode;
      await this.submitCode(opts.steamGuardCode, codeType);
      return;
    }

    if (
      allowed.includes(EAuthSessionGuardType.DeviceConfirmation) ||
      allowed.includes(EAuthSessionGuardType.EmailConfirmation)
    ) {
      this.emitRemoteInteraction();
      return;
    }

    const codeGuard = allowed.find(
      (t) => t === EAuthSessionGuardType.EmailCode || t === EAuthSessionGuardType.DeviceCode,
    );
    if (codeGuard !== undefined) {
      this.emit("steamGuardRequired", {
        type: codeGuard,
        message:
          codeGuard === EAuthSessionGuardType.EmailCode
            ? "an email Steam Guard code is required"
            : "a device (TOTP) Steam Guard code is required",
      });
    }
    // else (None, or only confirmations): fall through to polling.
  }

  private async submitCode(code: string, codeType: EAuthSessionGuardType): Promise<void> {
    if (!this.steamID) throw new LoginError("cannot submit Steam Guard code before begin");
    await this.auth.updateAuthSessionWithSteamGuardCode(
      this.clientId,
      BigInt(this.steamID.getSteamID64()),
      code,
      codeType,
    );
  }

  private schedulePoll(): void {
    if (this.settled) return;
    this.pollTimer = setTimeout(() => {
      this.poll().catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.settled) return;

    let res: Awaited<ReturnType<typeof this.auth.pollAuthSessionStatus>>;
    try {
      res = await this.auth.pollAuthSessionStatus(this.clientId, this.requestId);
    } catch (err) {
      // Transient poll errors shouldn't abort the login (e.g. a blip while the user approves on
      // their phone); keep polling until the deadline, like steam-session does.
      if (Date.now() >= this.deadline) {
        this.stop();
        this.emit("timeout");
        return;
      }
      this.emit("debug", `poll error, retrying: ${(err as Error).message}`);
      this.schedulePoll();
      return;
    }

    if (res.hadRemoteInteraction) this.emitRemoteInteraction();
    if (res.newGuardData) {
      this.steamGuardMachineToken = res.newGuardData;
      this.emit("steamGuardMachineToken", res.newGuardData);
    }
    if (res.newClientId) this.clientId = res.newClientId;
    if (res.accessToken) this.accessToken = res.accessToken;

    if (res.refreshToken) {
      this.refreshToken = res.refreshToken;
      if (res.accountName) this.accountName = res.accountName;
      this.stop();
      this.emit("authenticated");
      return;
    }

    if (Date.now() >= this.deadline) {
      this.stop();
      this.emit("timeout");
      return;
    }
    this.schedulePoll();
  }

  private emitRemoteInteraction(): void {
    if (this.remoteInteractionEmitted) return;
    this.remoteInteractionEmitted = true;
    this.emit("remoteInteraction");
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.stop();
    this.emit("error", error);
  }
}
