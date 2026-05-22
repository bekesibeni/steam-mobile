import { Buffer } from "node:buffer";

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

export type ProtoValue =
  | { kind: "varint"; value: bigint }
  | { kind: "fixed64"; value: bigint }
  | { kind: "bytes"; value: Buffer }
  | { kind: "fixed32"; value: number };

export class ProtoWriter {
  private readonly bytes: number[] = [];

  string(field: number, value: string): this {
    const buf = Buffer.from(value, "utf8");
    this.tag(field, WIRE_BYTES);
    this.varintRaw(buf.length);
    this.bytes.push(...buf);
    return this;
  }

  fixed64(field: number, value: bigint): this {
    this.tag(field, WIRE_FIXED64);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    this.bytes.push(...buf);
    return this;
  }

  varint(field: number, value: number): this {
    this.tag(field, WIRE_VARINT);
    this.varintRaw(value);
    return this;
  }

  finish(): Buffer {
    return Buffer.from(this.bytes);
  }

  private tag(field: number, wire: number): void {
    this.varintRaw((field << 3) | wire);
  }

  private varintRaw(value: number): void {
    let n = value;
    while (n > 0x7f) {
      this.bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.bytes.push(n);
  }
}

export class ProtoReader {
  private i = 0;

  constructor(private readonly buf: Buffer) {}

  *fields(): Generator<{ field: number; value: ProtoValue }> {
    while (this.i < this.buf.length) {
      const tag = this.varintRaw();
      yield { field: tag >> 3, value: this.value(tag & 0x07) };
    }
  }

  private value(wire: number): ProtoValue {
    switch (wire) {
      case WIRE_VARINT:
        return { kind: "varint", value: this.varintBig() };
      case WIRE_FIXED64:
        return { kind: "fixed64", value: this.fixed(8).readBigUInt64LE() };
      case WIRE_BYTES:
        return { kind: "bytes", value: this.fixed(this.varintRaw()) };
      case WIRE_FIXED32:
        return { kind: "fixed32", value: this.fixed(4).readUInt32LE() };
      default:
        throw new Error(`unsupported wire type ${wire}`);
    }
  }

  // For tags and byte-lengths only — always small, safely within Number range.
  private varintRaw(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.next();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  // For varint field values, which may exceed 2^53 (e.g. 64-bit ids encoded as varint).
  private varintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    let byte: number;
    do {
      byte = this.next();
      result += BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    return result;
  }

  private fixed(length: number): Buffer {
    if (this.i + length > this.buf.length) throw new Error("unexpected end of protobuf");
    const slice = this.buf.subarray(this.i, this.i + length);
    this.i += length;
    return slice;
  }

  private next(): number {
    if (this.i >= this.buf.length) throw new Error("unexpected end of protobuf");
    return this.buf[this.i++] as number;
  }
}
