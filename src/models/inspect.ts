import { Buffer } from "node:buffer";
import { fromBinary, fromJson, type JsonObject, toBinary, toJson } from "@bufbuild/protobuf";
import { CEconItemPreviewDataBlockSchema } from "../protobufs/csgo_econ_preview_pb.js";

const HEX_RE = /^[0-9a-fA-F]+$/;
const wearView = new DataView(new ArrayBuffer(4));

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[i] = c >>> 0;
}

/** Trailing checksum: crc32 over `[xorKey, ...protobuf]` folded with the protobuf length. */
function previewChecksum(keyed: Uint8Array, protoLength: number): number {
  let crc = 0xffffffff;
  for (const byte of keyed) crc = (CRC32_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return ((crc & 0xffff) ^ (protoLength * crc)) >>> 0;
}

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

/**
 * Encode JSON back into a masked preview token — the inverse of
 * {@link decodePreviewToken}, accepting the same shape it returns. `paintwear` is read as
 * the float wear (0..1) and re-packed into its uint32 bits. `xorKey` 0 leaves the payload
 * readable; any other byte masks it the way CS2's own links do. The checksum is unkeyed
 * crc32, so this is an integrity code and not a signature. Returns `null` if the input is
 * not a valid CEconItemPreviewDataBlock.
 */
export function encodePreviewToken(data: Record<string, unknown>, xorKey = 0): string | null {
  if (!Number.isInteger(xorKey) || xorKey < 0 || xorKey > 0xff) return null;
  try {
    const json = { ...data };
    if (typeof json.paintwear === "number") {
      wearView.setFloat32(0, json.paintwear, true);
      json.paintwear = wearView.getUint32(0, true);
    }
    const proto = toBinary(
      CEconItemPreviewDataBlockSchema,
      fromJson(CEconItemPreviewDataBlockSchema, json as JsonObject),
    );
    const bytes = Buffer.alloc(proto.length + 5);
    bytes[0] = xorKey;
    bytes.set(proto, 1);
    bytes.writeUInt32BE(
      previewChecksum(bytes.subarray(0, proto.length + 1), proto.length),
      proto.length + 1,
    );
    for (let i = 1; i < bytes.length; i++) bytes[i] = (bytes[i] as number) ^ xorKey;
    return bytes.toString("hex").toUpperCase();
  } catch {
    return null;
  }
}
