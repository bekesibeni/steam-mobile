// How we present as the Steam mobile app on the wire (per-host UA + cookies) plus the login-time
// device_details. Steam doesn't strictly require any of it, but we match the app consistently.
export type MobilePlatform = "ios" | "android";

export interface MobileProfile {
  mobileClient: MobilePlatform; // mobileClient cookie value
  mobileClientVersion: string; // its presence is Steam's trigger for mobile treatment
  apiUserAgent: string; // UA for api.steampowered.com
  webUserAgent: string; // UA for steamcommunity/store/help
  // device_details (BeginAuthSessionViaCredentials):
  deviceFriendlyName: string; // iOS sends the model id, e.g. "iPhone18,3"
  osType: number; // EOSType, signed: iOS -600, Android -500
  gamingDeviceType: number;
  appType?: number; // EAuthTokenAppType (iOS 1); omitted for Android
}

// Captured from a real iOS Steam app (Charles).
export const IOS_PROFILE: MobileProfile = {
  mobileClient: "ios",
  mobileClientVersion: "777777 3.10.9",
  apiUserAgent: "Steam%20Mobile/10472498 CFNetwork/3860.600.12 Darwin/25.5.0",
  webUserAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X; Valve Steam App Version/3) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  deviceFriendlyName: "iPhone18,3",
  osType: -600,
  gamingDeviceType: 528,
  appType: 1,
};

// Matches the Android Steam app (okhttp UA) and our android: confirmation device-ids.
export const ANDROID_PROFILE: MobileProfile = {
  mobileClient: "android",
  mobileClientVersion: "777777 3.10.3",
  apiUserAgent: "okhttp/4.9.2",
  webUserAgent:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  deviceFriendlyName: "Galaxy S25",
  osType: -500,
  gamingDeviceType: 528,
};

const PRESETS: Record<MobilePlatform, MobileProfile> = {
  ios: IOS_PROFILE,
  android: ANDROID_PROFILE,
};

// Default to iOS; a string picks a preset; an object overrides fields on the implied preset.
export function resolveMobileProfile(
  input?: MobilePlatform | Partial<MobileProfile>,
): MobileProfile {
  if (input === undefined) return { ...IOS_PROFILE };
  if (typeof input === "string") return { ...PRESETS[input] };
  const base = input.mobileClient === "android" ? ANDROID_PROFILE : IOS_PROFILE;
  return { ...base, ...input };
}
