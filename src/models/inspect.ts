import { Buffer } from "node:buffer";
import { fromBinary, toJson } from "@bufbuild/protobuf";
import { CEconItemPreviewDataBlockSchema } from "../protobufs/csgo_econ_preview_pb.js";

const HEX_RE = /^[0-9a-fA-F]+$/;
const wearView = new DataView(new ArrayBuffer(4));

/**
 * Decode a CS2 masked preview token — the asset_properties propertyid-6
 * "certificate" hex — into a plain JSON object (uint64 ids as strings, camelCase
 * fields, only set fields present). Layout is `[xorKey][protobuf][crc32]`: every
 * byte after the key is XOR'd with it and the trailing 4-byte crc32 dropped.
 * `paintwear` is returned as the float wear (0..1), not its raw uint32 bits.
 * Returns `null` for non-hex input.
 */
export function decodePreviewToken(hex: string | null | undefined): Record<string, unknown> | null {
  if (!hex || hex.length % 2 !== 0 || hex.length < 12 || !HEX_RE.test(hex)) return null;
  try {
    const bytes = Buffer.from(hex, "hex");
    const xorKey = bytes[0] as number;
    for (let i = 1; i < bytes.length; i++) bytes[i] = (bytes[i] as number) ^ xorKey;
    const message = fromBinary(
      CEconItemPreviewDataBlockSchema,
      bytes.subarray(1, bytes.length - 4),
    );
    const json = toJson(CEconItemPreviewDataBlockSchema, message) as Record<string, unknown>;
    if (typeof json.paintwear === "number") {
      wearView.setUint32(0, json.paintwear >>> 0, true);
      json.paintwear = wearView.getFloat32(0, true);
    }
    return json;
  } catch {
    return null;
  }
}
