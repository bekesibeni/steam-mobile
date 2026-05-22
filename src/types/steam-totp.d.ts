declare module "steam-totp" {
  import type SteamID from "steamid";

  interface SteamTotpStatic {
    time(timeOffset?: number): number;
    getConfirmationKey(identitySecret: Buffer | string, time: number, tag: string): string;
    getDeviceID(steamID: string | SteamID): string;
    getTimeOffset(callback: (error: Error | null, offset?: number, latency?: number) => void): void;
  }

  const SteamTotp: SteamTotpStatic;
  export default SteamTotp;
}
