// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `packed@1`, matching the Rust runtime's `format::Packed`: a value is its
 * fields back to back, like a packed C struct.
 *
 * - Integers and floats are fixed-width little-endian; `bool` is one byte,
 *   `00` or `01`.
 * - A string is a varint length, then its UTF-8 bytes.
 * - An array is a varint count, then the elements; a fixed-size array has no
 *   count, its length is in the type.
 * - An optional is `00`, or `01` and the value.
 * - A struct is its fields in declaration order, with no names or header.
 * - An enum is its variant index, as a varint.
 * - A single `char` is its UTF-8 bytes alone, 1 to 4, with no length: the
 *   first byte gives the width.
 * - Bounds (core#98) don't change the bytes, only what's accepted: a count
 *   above an array's maximum is refused before any item is read, a byte
 *   length above 4 × a string's maximum before the string is decoded, and a
 *   recursive type nested past its depth before it's read.
 *
 * Varints are unsigned LEB128 in their shortest form; any other spelling is
 * refused. Decoding is strict: a value must use every byte it is given, and a
 * length larger than the bytes left is refused before anything is allocated.
 *
 * The bytes don't say what they hold, so both directions need the value's
 * {@link Layout}, which generated code declares beside each type.
 */

import { Depths, checkChar, checkChars, checkCharsExact, checkItems, isChar } from "./bounds.js";
import { RuntimeError, type Codec } from "./contract.js";
import { FORMAT_PACKED } from "./handshake.js";
import type { Shape } from "./json.js";

/**
 * Everything about a type the packed bytes leave out, as generated code
 * declares it. The value it describes is the one generated TypeScript holds:
 * a 64- or 128-bit integer a `bigint`, every narrower one and every float a
 * `number`, an absent optional `undefined`, an enum value its variant's name.
 *
 * - A scalar by name. Signed integers are `s`-prefixed, as in the IDL;
 *   `"unit"` is `()`, which takes no bytes.
 * - `"char"`: one Unicode scalar value, a string of exactly one code point.
 * - `{ array }`: `T[]`; with `max`, `T[max N]`. `{ fixed, length }`: `T[N]`.
 * - `{ chars: { max } }`: `char[max N]`, a string of at most N characters.
 *   `{ chars: { length } }`: `char[N]`, exactly N characters. Both are a
 *   string on the wire, like `"string"`.
 * - `{ depth, of }`: a type that can contain itself, under
 *   `@max_depth = depth`. `of` is the type; it refers back to itself through
 *   a function returning this same object, which is how its levels are
 *   counted: the outermost value is level 1.
 * - `{ option }`: an optional field.
 * - `{ struct }`: the fields, in declaration order.
 * - `{ enum }`: the variant names, in declaration order.
 * - `{ union }`: the members, in declaration order. A value is written as
 *   the first member that can hold it, after its index.
 * - A function: a named type's layout, looked up only when it's needed, so
 *   types can refer to each other in any order, and recursively.
 */
export type Layout =
  | "bool"
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "u128"
  | "s8"
  | "s16"
  | "s32"
  | "s64"
  | "s128"
  | "f32"
  | "f64"
  | "string"
  | "char"
  | "unit"
  | { readonly array: Layout; readonly max?: number }
  | { readonly chars: { readonly max: number } | { readonly length: number } }
  | { readonly depth: number; readonly of: Layout }
  | { readonly fixed: Layout; readonly length: number }
  | { readonly option: Layout }
  | { readonly struct: readonly (readonly [name: string, layout: Layout])[] }
  | { readonly enum: readonly string[] }
  | { readonly union: readonly Layout[] }
  | (() => Layout);

type Resolved = Exclude<Layout, () => Layout>;

function resolve(layout: Layout): Resolved {
  while (typeof layout === "function") layout = layout();
  return layout;
}

const INTEGERS = {
  u8: { bytes: 1, min: 0, max: 0xff },
  u16: { bytes: 2, min: 0, max: 0xffff },
  u32: { bytes: 4, min: 0, max: 0xffff_ffff },
  s8: { bytes: 1, min: -0x80, max: 0x7f },
  s16: { bytes: 2, min: -0x8000, max: 0x7fff },
  s32: { bytes: 4, min: -0x8000_0000, max: 0x7fff_ffff },
} as const;

type Integer = keyof typeof INTEGERS;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const S128_MIN = -(1n << 127n);
const S128_MAX = (1n << 127n) - 1n;
const S64_MIN = -(1n << 63n);
const S64_MAX = (1n << 63n) - 1n;

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A byte sink that grows by doubling. */
class Writer {
  readonly depths = new Depths();
  private buf = new Uint8Array(64);
  private view = new DataView(this.buf.buffer);
  length = 0;

  /**
   * Room for `n` more bytes; returns where they start. It may replace `buf`
   * and `view`, so callers take the offset before touching either.
   */
  private reserve(n: number): number {
    const at = this.length;
    if (at + n > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < at + n) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.buf.subarray(0, at));
      this.buf = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length += n;
    return at;
  }

  u8(v: number): void {
    const at = this.reserve(1);
    this.buf[at] = v;
  }

  bytes(b: Uint8Array): void {
    const at = this.reserve(b.length);
    this.buf.set(b, at);
  }

  varint(v: number): void {
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.u8(v);
  }

  integer(name: Integer, v: number): void {
    const at = this.reserve(INTEGERS[name].bytes);
    switch (name) {
      case "u8":
        return this.view.setUint8(at, v);
      case "u16":
        return this.view.setUint16(at, v, true);
      case "u32":
        return this.view.setUint32(at, v, true);
      case "s8":
        return this.view.setInt8(at, v);
      case "s16":
        return this.view.setInt16(at, v, true);
      case "s32":
        return this.view.setInt32(at, v, true);
    }
  }

  u64(v: bigint): void {
    const at = this.reserve(8);
    this.view.setBigUint64(at, v, true);
  }

  s64(v: bigint): void {
    const at = this.reserve(8);
    this.view.setBigInt64(at, v, true);
  }

  /** 128 bits, two's complement, low half first. */
  u128(v: bigint): void {
    const bits = BigInt.asUintN(128, v);
    const at = this.reserve(16);
    this.view.setBigUint64(at, BigInt.asUintN(64, bits), true);
    this.view.setBigUint64(at + 8, bits >> 64n, true);
  }

  f32(v: number): void {
    const at = this.reserve(4);
    this.view.setFloat32(at, v, true);
  }

  f64(v: number): void {
    const at = this.reserve(8);
    this.view.setFloat64(at, v, true);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const refuse = (): never => {
  throw RuntimeError.serialization();
};

function write(w: Writer, layout: Layout, value: unknown): void {
  const l = resolve(layout);
  if (typeof l === "string") {
    switch (l) {
      case "bool":
        if (typeof value !== "boolean") refuse();
        return w.u8(value ? 1 : 0);
      case "u64":
      case "s64": {
        if (typeof value !== "bigint") refuse();
        const v = value as bigint;
        if (l === "u64" ? v < 0n || v > U64_MAX : v < S64_MIN || v > S64_MAX) refuse();
        return l === "u64" ? w.u64(v) : w.s64(v);
      }
      case "u128":
      case "s128": {
        if (typeof value !== "bigint") refuse();
        const v = value as bigint;
        if (l === "u128" ? v < 0n || v > U128_MAX : v < S128_MIN || v > S128_MAX) refuse();
        return w.u128(v);
      }
      case "f32":
      case "f64":
        if (typeof value !== "number") refuse();
        return l === "f32" ? w.f32(value as number) : w.f64(value as number);
      case "string": {
        if (typeof value !== "string") refuse();
        const b = utf8.encode(value as string);
        w.varint(b.length);
        return w.bytes(b);
      }
      case "char":
        checkChar(value);
        return w.bytes(utf8.encode(value));
      case "unit":
        return;
      default: {
        const name = l as Integer;
        const { min, max } = INTEGERS[name];
        if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) refuse();
        return w.integer(name, value as number);
      }
    }
  }
  if ("chars" in l) {
    if (typeof value !== "string") refuse();
    const s = value as string;
    if ("max" in l.chars) checkChars(s, l.chars.max);
    else checkCharsExact(s, l.chars.length);
    const b = utf8.encode(s);
    w.varint(b.length);
    return w.bytes(b);
  }
  if ("depth" in l) {
    w.depths.enter(l, l.depth);
    write(w, l.of, value);
    return w.depths.leave(l);
  }
  if ("array" in l) {
    if (!Array.isArray(value)) refuse();
    const items = value as unknown[];
    if (l.max !== undefined) checkItems(items.length, l.max);
    w.varint(items.length);
    for (const item of items) write(w, l.array, item);
    return;
  }
  if ("fixed" in l) {
    if (!Array.isArray(value) || value.length !== l.length) refuse();
    for (const item of value as unknown[]) write(w, l.fixed, item);
    return;
  }
  if ("option" in l) {
    if (value === undefined || value === null) return w.u8(0);
    w.u8(1);
    return write(w, l.option, value);
  }
  if ("struct" in l) {
    if (typeof value !== "object" || value === null) refuse();
    const o = value as { [field: string]: unknown };
    for (const [name, field] of l.struct) write(w, field, o[name]);
    return;
  }
  if ("union" in l) {
    const index = l.union.findIndex((member) => holds(member, value));
    if (index < 0) refuse();
    w.varint(index);
    return write(w, l.union[index]!, value);
  }
  const index = l.enum.indexOf(value as string);
  if (index < 0) refuse();
  w.varint(index);
}

/**
 * Whether a value of `layout` can be `value`, by its JavaScript kind: what
 * picks a union's member. A value two members could both be goes to the
 * first.
 */
function holds(layout: Layout, value: unknown): boolean {
  const l = resolve(layout);
  if (typeof l === "string") {
    switch (l) {
      case "bool":
        return typeof value === "boolean";
      case "u64":
      case "s64":
      case "u128":
      case "s128":
        return typeof value === "bigint";
      case "string":
        return typeof value === "string";
      case "char":
        return isChar(value);
      case "unit":
        return value === undefined || value === null;
      case "f32":
      case "f64":
        return typeof value === "number";
      default: {
        // A JSON `Shape`'s scalar (`"number"`) isn't an integer layout.
        const range = INTEGERS[l as Integer] as (typeof INTEGERS)[Integer] | undefined;
        if (range === undefined) return false;
        return Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max;
      }
    }
  }
  if ("chars" in l) return typeof value === "string";
  if ("depth" in l) return holds(l.of, value);
  if ("array" in l) return Array.isArray(value);
  if ("fixed" in l) return Array.isArray(value) && value.length === l.length;
  if ("option" in l) return value === undefined || value === null || holds(l.option, value);
  if ("struct" in l) return typeof value === "object" && value !== null && !Array.isArray(value);
  if ("union" in l) return l.union.some((member) => holds(member, value));
  return typeof value === "string" && l.enum.includes(value);
}

/**
 * Refuses `value` if it breaks a bound its {@link Layout} declares: a
 * single `char` that isn't one, a string or array over its maximum, a
 * recursive type nested too deep. For formats whose bytes the check can't
 * see into while decoding (`json@1`): run before encoding, and after
 * decoding. Anything else about the value is left to the codec, and a JSON
 * {@link Shape} passed instead declares no bounds.
 */
export function checkBounds(layout: Layout | Shape, value: unknown, depths = new Depths()): void {
  if (typeof layout === "function") return checkBounds(layout(), value, depths);
  if (typeof layout === "string") {
    if (layout === "char") checkChar(value);
    return;
  }
  if ("chars" in layout) {
    if (typeof value !== "string") return;
    if ("max" in layout.chars) checkChars(value, layout.chars.max);
    else checkCharsExact(value, layout.chars.length);
    return;
  }
  if ("depth" in layout) {
    depths.enter(layout, layout.depth);
    checkBounds(layout.of, value, depths);
    return depths.leave(layout);
  }
  if ("array" in layout) {
    if (!Array.isArray(value)) return;
    const max = (layout as { max?: number }).max;
    if (max !== undefined) checkItems(value.length, max);
    for (const item of value) checkBounds(layout.array, item, depths);
    return;
  }
  if ("fixed" in layout) {
    if (!Array.isArray(value)) return;
    for (const item of value) checkBounds(layout.fixed, item, depths);
    return;
  }
  if ("option" in layout) {
    if (value !== undefined && value !== null) checkBounds(layout.option, value, depths);
    return;
  }
  if ("struct" in layout) {
    if (typeof value !== "object" || value === null) return;
    const o = value as { [field: string]: unknown };
    for (const [name, field] of layout.struct) {
      if (Object.hasOwn(o, name)) checkBounds(field, o[name], depths);
    }
    return;
  }
  if ("union" in layout) {
    const members = layout.union as readonly Layout[];
    const member = members.find((m) => holds(m, value));
    if (member !== undefined) checkBounds(member, value, depths);
  }
}

/** A cursor over the bytes being decoded. */
class Reader {
  readonly depths = new Depths();
  private readonly view: DataView;
  at = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get left(): number {
    return this.bytes.length - this.at;
  }

  /** Where `n` bytes start, refusing if there aren't that many left. */
  private take(n: number): number {
    if (n > this.left) refuse();
    const at = this.at;
    this.at += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  tag(): boolean {
    const b = this.u8();
    if (b > 1) refuse();
    return b === 1;
  }

  /** An unsigned LEB128 number, in its shortest form, up to 64 bits. */
  varint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.u8();
      // The tenth byte holds bit 63 alone.
      if (i === 9 && byte > 1) refuse();
      value |= BigInt(byte & 0x7f) << BigInt(7 * i);
      if ((byte & 0x80) === 0) {
        // A trailing zero byte would be a second spelling of a shorter number.
        if (i > 0 && byte === 0) refuse();
        return value;
      }
    }
    return refuse();
  }

  /** A length or count: never more than the bytes left. */
  len(): number {
    const n = this.varint();
    if (n > BigInt(this.left)) refuse();
    return Number(n);
  }

  integer(name: Integer): number {
    const at = this.take(INTEGERS[name].bytes);
    switch (name) {
      case "u8":
        return this.view.getUint8(at);
      case "u16":
        return this.view.getUint16(at, true);
      case "u32":
        return this.view.getUint32(at, true);
      case "s8":
        return this.view.getInt8(at);
      case "s16":
        return this.view.getInt16(at, true);
      case "s32":
        return this.view.getInt32(at, true);
    }
  }

  u64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }

  s64(): bigint {
    return this.view.getBigInt64(this.take(8), true);
  }

  /** 128 bits, low half first, as unsigned. */
  u128(): bigint {
    const at = this.take(16);
    return (this.view.getBigUint64(at + 8, true) << 64n) | this.view.getBigUint64(at, true);
  }

  f32(): number {
    return this.view.getFloat32(this.take(4), true);
  }

  f64(): number {
    return this.view.getFloat64(this.take(8), true);
  }

  /**
   * A string; with `max`, of at most that many characters, a byte length
   * above 4 × `max` refused before anything is decoded. With `exact`, of
   * exactly that many: a byte length below it is refused at once.
   */
  string(max?: number, exact?: number): string {
    const n = this.len();
    const limit = max ?? exact;
    if (limit !== undefined && n > 4 * limit) throw RuntimeError.boundExceeded("chars");
    if (exact !== undefined && n < exact) refuse();
    const at = this.take(n);
    let s: string;
    try {
      s = strictUtf8.decode(this.bytes.subarray(at, at + n));
    } catch {
      return refuse();
    }
    // A string of at most `max` bytes has at most `max` characters.
    if (max !== undefined && n > max) checkChars(s, max);
    if (exact !== undefined) checkCharsExact(s, exact);
    return s;
  }

  /** One character's UTF-8 bytes, no prefix: the first byte gives the width. */
  char(): string {
    const first = this.bytes[this.at];
    if (first === undefined) return refuse();
    const width =
      first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    if (width === 0) refuse();
    const at = this.take(width);
    let s: string;
    try {
      s = strictUtf8.decode(this.bytes.subarray(at, at + width));
    } catch {
      return refuse();
    }
    // Strict decoding refuses overlong forms, surrogates and truncation, so
    // `width` bytes that decode are exactly one character.
    if (!isChar(s)) refuse();
    return s;
  }
}

function read(r: Reader, layout: Layout): unknown {
  const l = resolve(layout);
  if (typeof l === "string") {
    switch (l) {
      case "bool":
        return r.tag();
      case "u64":
        return r.u64();
      case "s64":
        return r.s64();
      case "u128":
        return r.u128();
      case "s128":
        return BigInt.asIntN(128, r.u128());
      case "f32":
        return r.f32();
      case "f64":
        return r.f64();
      case "string":
        return r.string();
      case "char":
        return r.char();
      case "unit":
        return undefined;
      default: {
        const name = l as Integer;
        return r.integer(name);
      }
    }
  }
  if ("chars" in l) {
    return "max" in l.chars ? r.string(l.chars.max) : r.string(undefined, l.chars.length);
  }
  if ("depth" in l) {
    r.depths.enter(l, l.depth);
    const value = read(r, l.of);
    r.depths.leave(l);
    return value;
  }
  if ("array" in l) {
    const n = r.len();
    if (l.max !== undefined) checkItems(n, l.max);
    const items: unknown[] = [];
    for (let i = 0; i < n; i++) items.push(read(r, l.array));
    return items;
  }
  if ("fixed" in l) {
    const items: unknown[] = [];
    for (let i = 0; i < l.length; i++) items.push(read(r, l.fixed));
    return items;
  }
  if ("option" in l) return r.tag() ? read(r, l.option) : undefined;
  if ("union" in l) {
    const index = r.varint();
    if (index >= BigInt(l.union.length)) refuse();
    return read(r, l.union[Number(index)]!);
  }
  if ("struct" in l) {
    // An absent optional is left out, as the JSON codec leaves it.
    // `fromEntries` defines own properties, so a `__proto__` field stays data.
    const entries = l.struct.map(([name, field]) => [name, read(r, field)] as const);
    return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  }
  const index = r.varint();
  if (index >= BigInt(l.enum.length)) refuse();
  return l.enum[Number(index)];
}

/**
 * The JSON {@link Shape} for `s`: a {@link Layout} says where the JSON codec
 * reads a `bigint`, so one declaration per type serves both codecs. A
 * `Shape` comes back as it is.
 */
export function jsonShape(s: Shape | Layout): Shape {
  if (typeof s === "function") return () => jsonShape(s());
  if (typeof s === "string") {
    switch (s) {
      case "u64":
      case "s64":
      case "u128":
      case "s128":
      case "bigint":
        return "bigint";
      case "bool":
      case "boolean":
        return "boolean";
      case "string":
      case "char":
        return "string";
      default:
        return "number";
    }
  }
  if ("chars" in s) return "string";
  if ("depth" in s) return jsonShape(s.of);
  if ("array" in s) return { array: jsonShape(s.array) };
  if ("fixed" in s) return { array: jsonShape(s.fixed), length: s.length };
  if ("option" in s) return jsonShape(s.option);
  if ("struct" in s) {
    return { fields: Object.fromEntries(s.struct.map(([name, f]) => [name, jsonShape(f)])) };
  }
  if ("enum" in s) return "string";
  // A `Shape`'s union holds `Shape`s, a `Layout`'s `Layout`s: either way,
  // each member maps on its own.
  if ("union" in s) return { union: (s.union as readonly (Shape | Layout)[]).map(jsonShape) };
  return s;
}

/**
 * `packed@1` (`name === "packed@1"`): the smallest and fastest format, for
 * peers that share the schema. Positional, so both directions need the
 * value's {@link Layout}; without one, encoding and decoding throw.
 */
export class PackedCodec implements Codec {
  readonly name = FORMAT_PACKED;

  encode(value: unknown, layout?: Layout): Uint8Array {
    if (layout === undefined) {
      throw new TypeError("packed@1 encodes a value only with its layout");
    }
    const w = new Writer();
    write(w, layout, value);
    return w.finish();
  }

  /** `layout` must be a {@link Layout}; a JSON {@link Shape} says too little. */
  decode<T>(bytes: Uint8Array, layout?: Shape | Layout): T {
    if (layout === undefined) {
      throw new TypeError("packed@1 decodes a value only with its layout");
    }
    const r = new Reader(bytes);
    const value = read(r, layout as Layout);
    if (r.left !== 0) refuse();
    return value as T;
  }
}
