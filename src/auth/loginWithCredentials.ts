import { LoginError } from "../core/errors.js";
import {
  type MobilePlatform,
  type MobileProfile,
  resolveMobileProfile,
} from "../core/mobileProfile.js";
import { HttpClient } from "../http/HttpClient.js";
import { CredentialSession } from "./CredentialSession.js";

export interface LoginWithCredentialsOptions {
  accountName: string;
  password: string;
  sharedSecret?: string; // answers DeviceCode automatically via TOTP
  steamGuardCode?: string;
  machineToken?: string;
  proxy?: string;
  mobileProfile?: MobilePlatform | Partial<MobileProfile>;
  // Called when a code is required and none was supplied; resolve to the code to continue.
  onSteamGuardRequired?: (info: { type: number; message: string }) => Promise<string> | string;
}

export interface LoginResult {
  refreshToken: string;
  accessToken: string | undefined;
  steamId: string;
  accountName: string;
  steamGuardMachineToken: string | undefined;
}

// One-shot credential login → MobileApp refresh token. Feed into `new SteamMobile({ refreshToken })`.
export function loginWithCredentials(opts: LoginWithCredentialsOptions): Promise<LoginResult> {
  const profile = resolveMobileProfile(opts.mobileProfile);
  const http = new HttpClient({ ...(opts.proxy ? { proxy: opts.proxy } : {}), profile });
  const session = new CredentialSession(http, profile);

  return new Promise<LoginResult>((resolve, reject) => {
    session.on("error", reject);
    session.on("timeout", () => reject(new LoginError("login timed out waiting for confirmation")));
    session.on("authenticated", () => {
      if (!session.refreshToken || !session.steamID) {
        reject(new LoginError("login completed without a refresh token"));
        return;
      }
      resolve({
        refreshToken: session.refreshToken,
        accessToken: session.accessToken,
        steamId: session.steamID.getSteamID64(),
        accountName: session.accountName,
        steamGuardMachineToken: session.steamGuardMachineToken,
      });
    });

    session.on("steamGuardRequired", (info) => {
      const handler = opts.onSteamGuardRequired;
      if (!handler) {
        session.stop();
        reject(
          new LoginError(
            `${info.message}; pass sharedSecret, steamGuardCode, or onSteamGuardRequired`,
          ),
        );
        return;
      }
      Promise.resolve(handler(info))
        .then((code) => session.submitSteamGuardCode(code))
        .catch((err) => {
          session.stop();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    session.start(opts).catch((err) => {
      session.stop();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
