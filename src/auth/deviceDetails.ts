import { create } from "@bufbuild/protobuf";
import type { MobileProfile } from "../core/mobileProfile.js";
import {
  type CAuthentication_DeviceDetails,
  CAuthentication_DeviceDetailsSchema,
  type EAuthTokenAppType,
  EAuthTokenPlatformType,
} from "../protobufs/steammessages_auth_pb.js";

// device_details for the login (shows in Steam's authorized-devices list). Always MobileApp.
export function buildDeviceDetails(profile: MobileProfile): CAuthentication_DeviceDetails {
  return create(CAuthentication_DeviceDetailsSchema, {
    deviceFriendlyName: profile.deviceFriendlyName,
    platformType: EAuthTokenPlatformType.k_EAuthTokenPlatformType_MobileApp,
    osType: profile.osType,
    gamingDeviceType: profile.gamingDeviceType,
    ...(profile.appType !== undefined ? { appType: profile.appType as EAuthTokenAppType } : {}),
  });
}
