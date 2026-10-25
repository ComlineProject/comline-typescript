// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Random types, values and bytes for the differential properties, mirroring
 * the Rust reference's own generator (`runtime/conformance/tests/properties.rs`
 * in ComlineProject/runtime):
 *
 * - every scalar, options, arrays, fixed arrays, structs and unit enums, to
 *   depth 4, with names from small pools; no unions;
 * - **no array of data-less elements** (unit, `T[0]`, a struct of only such
 *   fields): core refuses them at schema build (core#141), so such an
 *   element gets a `bool` field beside it, as in Rust;
 * - **no `Some(None)` or `Some(())`:** an option directly around an option
 *   or `()` is wrapped in an array, as Rust does for JSON. Here it holds for
 *   every format: generated TypeScript holds an absent optional as
 *   `undefined`, so it can't tell them apart either;
 * - **floats are finite** in every format, not only JSON: the corpus's value
 *   encoding is JSON, which writes NaN and infinity as `null`. Decoding
 *   mutated `packed@1` bytes still meets every bit pattern.
 */

import fc from "fast-check";

import { NARROW, SCALARS, WIDE, type Json, type Scalar, type Type } from "../values.js";

const STRUCT_NAMES = ["Point", "Player", "Line", "Empty"];
const ENUM_NAMES = ["Color", "Class"];
const FIELD_NAMES = ["id", "name", "x", "y", "tags", "label"];
const VARIANT_NAMES = ["Red", "Green", "Blue", "Warrior", "Mage"];

const MAX_FIELDS = 6;
const MAX_ELEMENTS = 8;
/** `T[N]` past 32 needs `serde_big_array` in generated Rust. */
const MAX_FIXED = 40;
/** A fixed array of something that isn't a scalar stays short. */
const MAX_FIXED_NESTED = 4;
const MAX_DEPTH = 4;
/** The most scalars a value of a type can hold, past which it's redrawn. */
const MAX_WEIGHT = 2000;

const scalar = (t: Type): t is Scalar => typeof t === "string";

/** Whether a value of `t` takes any bytes. An option does. */
export function carriesData(t: Type): boolean {
  if (t === "unit") return false;
  if (typeof t === "string") return true;
  if ("fixed" in t) return t.fixed.len > 0 && carriesData(t.fixed.of);
  if ("struct" in t) return t.struct.fields.some(([, f]) => carriesData(f));
  return true;
}

/** `T[]`, or an array of `{ id: bool, name: T }` when `T` carries no data. */
function arrayOf(t: Type): Type {
  if (carriesData(t)) return { array: t };
  return {
    array: { struct: { name: STRUCT_NAMES[2]!, fields: [[FIELD_NAMES[0]!, "bool"], [FIELD_NAMES[1]!, t]] } },
  };
}

function optionOf(t: Type): Type {
  return { option: t === "unit" || (typeof t === "object" && "option" in t) ? arrayOf(t) : t };
}

/** At most how many scalars a value of `t` holds. */
function weight(t: Type): number {
  if (typeof t === "string") return 1;
  if ("option" in t) return 1 + weight(t.option);
  if ("array" in t) return 1 + MAX_ELEMENTS * weight(t.array);
  if ("fixed" in t) return 1 + t.fixed.len * weight(t.fixed.of);
  if ("struct" in t) return 1 + t.struct.fields.reduce((n, [, f]) => n + weight(f), 0);
  return 1;
}

const leaf: fc.Arbitrary<Type> = fc.oneof(
  { arbitrary: fc.constantFrom<Type>(...SCALARS), weight: SCALARS.length },
  {
    arbitrary: fc
      .tuple(fc.constantFrom(...ENUM_NAMES), fc.integer({ min: 1, max: VARIANT_NAMES.length }))
      .map(([name, n]): Type => ({ enum: { name, variants: VARIANT_NAMES.slice(0, n) } })),
    weight: 1,
  },
);

function typeAt(depth: number): fc.Arbitrary<Type> {
  if (depth === 0) return leaf;
  const inner = typeAt(depth - 1);
  return fc.oneof(
    { arbitrary: leaf, weight: 3 },
    { arbitrary: inner.map(optionOf), weight: 1 },
    { arbitrary: inner.map(arrayOf), weight: 1 },
    {
      arbitrary: inner.chain((of) =>
        fc
          .integer({ min: 0, max: scalar(of) ? MAX_FIXED : MAX_FIXED_NESTED })
          .map((len): Type => ({ fixed: { of, len } })),
      ),
      weight: 1,
    },
    {
      arbitrary: fc
        .tuple(fc.constantFrom(...STRUCT_NAMES), fc.array(inner, { maxLength: MAX_FIELDS }))
        .map(
          ([name, fields]): Type => ({
            struct: { name, fields: fields.map((f, i) => [FIELD_NAMES[i]!, f]) },
          }),
        ),
      weight: 1,
    },
  );
}

/** A random reader type. */
export const typeArb: fc.Arbitrary<Type> = typeAt(MAX_DEPTH).filter((t) => weight(t) <= MAX_WEIGHT);

function narrow(kind: string): fc.Arbitrary<Json> {
  const [min, max] = NARROW[kind]!;
  return fc
    .oneof(fc.constantFrom(min, max, 0, 1), fc.integer({ min, max }))
    .map((n) => ({ [kind]: n }));
}

function wide(kind: string): fc.Arbitrary<Json> {
  const [min, max] = WIDE[kind]!;
  return fc
    .oneof(fc.constantFrom(min, max, 0n, 1n), fc.bigInt({ min, max }))
    .map((n) => ({ [kind]: n.toString() }));
}

/** Any Unicode scalar value: a code point that isn't a surrogate. */
const scalarValue = fc
  .integer({ min: 0, max: 0x10ffff - 0x800 })
  .map((n) => (n >= 0xd800 ? n + 0x800 : n));

/**
 * Lengths about where a varint takes another byte (127/128, 16383/16384):
 * a short value never writes a length of more than one byte.
 */
const longLength = fc.oneof(
  fc.constantFrom(127, 128, 129, 255, 256, 16383, 16384),
  fc.integer({ min: 100, max: 400 }),
);

export const stringArb = fc.oneof(
  {
    arbitrary: fc
      .array(fc.oneof(scalarValue, fc.integer({ min: 0x20, max: 0x7e })), { maxLength: 16 })
      .map((cps) => String.fromCodePoint(...cps)),
    weight: 3,
  },
  { arbitrary: fc.tuple(longLength, fc.integer({ min: 0x20, max: 0x7e })).map(([n, c]) => String.fromCharCode(c).repeat(n)), weight: 1 },
);

/** A value of `t`, in the corpus's typed encoding. */
export function valueArb(t: Type): fc.Arbitrary<Json> {
  if (typeof t === "string") {
    switch (t) {
      case "bool":
        return fc.boolean().map((b) => ({ bool: b }));
      case "f32":
        return fc
          .oneof(
            fc.constantFrom(0, -0, 1.5, 3.4028234663852886e38, -3.4028234663852886e38, 1.1754943508222875e-38, 1e-45),
            fc.float({ noNaN: true, noDefaultInfinity: true }),
          )
          .map((f) => ({ f32: f }));
      case "f64":
        return fc
          .oneof(
            fc.constantFrom(0, -0, 0.1, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, 2.2250738585072014e-308, 9007199254740993),
            fc.double({ noNaN: true, noDefaultInfinity: true }),
          )
          .map((f) => ({ f64: f }));
      case "string":
        return stringArb.map((s) => ({ string: s }));
      case "unit":
        return fc.constant({ unit: null });
      default:
        return t in NARROW ? narrow(t) : wide(t);
    }
  }
  if ("option" in t) {
    return fc.option(valueArb(t.option), { nil: null }).map((v) => ({ option: v }));
  }
  if ("array" in t) {
    const items = fc.array(valueArb(t.array), { maxLength: MAX_ELEMENTS });
    // An array of scalars is sometimes long, so its count takes two bytes.
    const long =
      typeof t.array === "string" && t.array !== "string"
        ? longLength
            .filter((n) => n < 1000)
            .chain((n) => fc.array(valueArb(t.array), { minLength: n, maxLength: n }))
        : undefined;
    return (long ? fc.oneof({ arbitrary: items, weight: 3 }, { arbitrary: long, weight: 1 }) : items).map(
      (items) => ({ array: items }),
    );
  }
  if ("fixed" in t) {
    const { of, len } = t.fixed;
    return fc.array(valueArb(of), { minLength: len, maxLength: len }).map((items) => ({ tuple: items }));
  }
  if ("struct" in t) {
    const { name, fields } = t.struct;
    return fc
      .tuple(...fields.map(([, f]) => valueArb(f)))
      .map((values) => ({ struct: { name, fields: fields.map(([f], i) => [f, values[i]!]) } }));
  }
  const { name, variants } = t.enum;
  return fc
    .integer({ min: 0, max: variants.length - 1 })
    .map((index) => ({ unit_variant: { enum: name, index, variant: variants[index]! } }));
}

export interface Typed {
  type: Type;
  value: Json;
}

/** A random type and a value of it. */
export const typedArb: fc.Arbitrary<Typed> = typeArb.chain((type) =>
  valueArb(type).map((value) => ({ type, value })),
);

/** Changes to valid bytes: bytes flipped, then a cut, then bytes appended. */
export interface Mutation {
  flips: [at: number, xor: number][];
  cut: number | null;
  append: number[];
}

export const mutationArb: fc.Arbitrary<Mutation> = fc.record({
  flips: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 })), { maxLength: 4 }),
  cut: fc.option(fc.nat(), { nil: null, freq: 3 }),
  append: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 3 }),
});

export function mutate(bytes: Uint8Array, m: Mutation): Uint8Array {
  const out = Array.from(bytes);
  if (out.length > 0) for (const [at, xor] of m.flips) out[at % out.length]! ^= xor;
  if (m.cut !== null) out.length = m.cut % (out.length + 1);
  out.push(...m.append);
  return Uint8Array.from(out);
}

/**
 * A change to a JSON-RPC frame made as JSON, not as bytes: a flipped byte
 * almost never makes a member twice, an `id` spelled `1.0`, a method name
 * written with escapes, or whitespace between tokens, and these are where
 * the two runtimes' JSON-RPC readers could part.
 */
export type JsonMutation =
  | { duplicate: { member: number; inError: boolean; at: number; fresh: boolean } }
  | { respell: { target: "id" | "code"; style: number } }
  | { escape: { mask: number[]; all: boolean; upper: boolean; slash: boolean } }
  | { space: { mask: number[]; widths: number[] } }
  | { reorder: { keys: number[]; inError: boolean } };

const spaceArb = fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 8 });

export const jsonMutationArb: fc.Arbitrary<JsonMutation> = fc.oneof(
  fc
    .record({ member: fc.nat(), inError: fc.boolean(), at: fc.nat(), fresh: fc.boolean() })
    .map((duplicate) => ({ duplicate })),
  fc
    .record({ target: fc.constantFrom("id" as const, "code" as const), style: fc.integer({ min: 0, max: 4 }) })
    .map((respell) => ({ respell })),
  fc
    .record({
      mask: fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 1, maxLength: 12 }),
      all: fc.boolean(),
      upper: fc.boolean(),
      slash: fc.boolean(),
    })
    .map((escape) => ({ escape })),
  fc.record({ mask: fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 1, maxLength: 12 }), widths: spaceArb })
    .map((space) => ({ space })),
  fc
    .record({ keys: fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), inError: fc.boolean() })
    .map((reorder) => ({ reorder })),
);

/** One member of a JSON object: its key, and its text as written, key included. */
interface Member {
  key: string;
  text: string;
}

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/y;

/** The members of the object written in `source` (which starts with `{`), or `undefined`. */
function members(source: string): Member[] | undefined {
  if (source[0] !== "{" || source[source.length - 1] !== "}") return undefined;
  const out: Member[] = [];
  let depth = 0;
  let from = 1;
  for (let at = 0; at < source.length; at++) {
    const c = source[at]!;
    if (c === '"') {
      STRING_LITERAL.lastIndex = at;
      const m = STRING_LITERAL.exec(source);
      if (!m) return undefined;
      at += m[0].length - 1;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    if ((c === "," && depth === 1) || (c === "}" && depth === 0)) {
      const text = source.slice(from, at);
      STRING_LITERAL.lastIndex = 0;
      const key = STRING_LITERAL.exec(text);
      if (!key || text[key[0].length] !== ":") return undefined;
      out.push({ key: JSON.parse(key[0]) as string, text });
      from = at + 1;
    }
  }
  return out;
}

const valueOf = (m: Member): string => m.text.slice(m.text.indexOf(":", JSON.stringify(m.key).length - 1) + 1);
const join = (ms: Member[]): string => `{${ms.map((m) => m.text).join(",")}}`;
const nth = <T>(xs: readonly T[], n: number): T => xs[n % xs.length]!;

/** `frame` with its `error` object's members changed by `edit`, or `undefined`. */
function inError(ms: Member[], edit: (error: Member[]) => Member[] | undefined): Member[] | undefined {
  const at = ms.findIndex((m) => m.key === "error");
  const error = at < 0 ? undefined : members(valueOf(ms[at]!));
  const edited = error && edit(error);
  if (!edited) return undefined;
  return ms.map((m, i) => (i === at ? { key: "error", text: `"error":${join(edited)}` } : m));
}

/** A non-negative integer `n` as another spelling of itself. */
function respelled(n: string, style: number): string {
  switch (style) {
    case 0:
      return `${n}.0`;
    case 1:
      return `${n}e0`;
    case 2:
      return n === "0" ? "-0" : `${n}.0`;
    case 3:
      return `${n}.00`;
    default:
      return `${n}0e-1`;
  }
}

/** A string as JSON written with escapes in places `m` chooses. */
function escapedString(value: string, m: Extract<JsonMutation, { escape: unknown }>["escape"]): string {
  const unit = (u: number) => {
    const h = u.toString(16).padStart(4, "0");
    return `\\u${m.upper ? h.toUpperCase() : h}`;
  };
  let out = "";
  let i = 0;
  for (const ch of value) {
    if (!m.all && nth(m.mask, i++) !== 1) out += JSON.stringify(ch).slice(1, -1);
    else if (ch === "/" && m.slash) out += "\\/";
    else for (let u = 0; u < ch.length; u++) out += unit(ch.charCodeAt(u));
  }
  return `"${out}"`;
}

/** `source` with whitespace between its tokens, where `m` chooses. */
function spaced(source: string, m: Extract<JsonMutation, { space: unknown }>["space"]): string {
  const WS = [" ", "\t", "\n", "\r"];
  let out = "";
  let n = 0;
  const gap = () => (nth(m.mask, n++) === 1 ? WS[nth(m.widths, n)]!.repeat(1 + (n % 3)) : "");
  out += gap();
  for (let at = 0; at < source.length; at++) {
    const c = source[at]!;
    if (c === '"') {
      STRING_LITERAL.lastIndex = at;
      const lit = STRING_LITERAL.exec(source)![0];
      out += lit;
      at += lit.length - 1;
    } else if ("{}[],:".includes(c)) out += gap() + c + gap();
    else out += c;
  }
  return out + gap();
}

/**
 * `valid`, a JSON-RPC frame, changed by `mutations`, or `undefined` if it
 * isn't one or a mutation doesn't apply to it.
 */
export function mutateJson(valid: Uint8Array, mutations: JsonMutation[]): Uint8Array | undefined {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(valid);
  } catch {
    return undefined;
  }
  // Whitespace last: the others read the frame as the compact JSON it was written as.
  const ordered = [...mutations].sort((a, b) => Number("space" in a) - Number("space" in b));
  for (const mutation of ordered) {
    const next = mutateOnce(source, mutation);
    if (next === undefined) return undefined;
    source = next;
  }
  return new TextEncoder().encode(source);
}

function mutateOnce(source: string, mutation: JsonMutation): string | undefined {
  if ("space" in mutation) return source[0] === "{" ? spaced(source, mutation.space) : undefined;
  const root = members(source.trim());
  if (!root) return undefined;
  if ("duplicate" in mutation) {
    const d = mutation.duplicate;
    const dup = (ms: Member[]): Member[] => {
      // Either a member there already, or an undeclared one, twice.
      const copy: Member = d.fresh ? { key: "x", text: '"x":1' } : nth(ms, d.member);
      const out = [...ms];
      out.splice(d.at % (ms.length + 1), 0, ...(d.fresh ? [copy, copy] : [copy]));
      return out;
    };
    const out = d.inError ? inError(root, dup) : dup(root);
    return out && join(out);
  }
  if ("respell" in mutation) {
    const { target, style } = mutation.respell;
    const respellMember = (ms: Member[], key: string): Member[] | undefined => {
      const at = ms.findIndex((m) => m.key === key);
      const v = at < 0 ? undefined : valueOf(ms[at]!);
      if (v === undefined || !/^(0|[1-9][0-9]*)$/.test(v)) return undefined;
      return ms.map((m, i) => (i === at ? { key, text: `${JSON.stringify(key)}:${respelled(v, style)}` } : m));
    };
    const out = target === "id" ? respellMember(root, "id") : inError(root, (e) => respellMember(e, "code"));
    return out && join(out);
  }
  if ("escape" in mutation) {
    const at = root.findIndex((m) => m.key === "method");
    if (at < 0) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(valueOf(root[at]!));
    } catch {
      return undefined;
    }
    if (typeof value !== "string") return undefined;
    return join(root.map((m, i) => (i === at ? { key: "method", text: `"method":${escapedString(value, mutation.escape)}` } : m)));
  }
  const { keys, inError: nested } = mutation.reorder;
  const order = (ms: Member[]): Member[] =>
    ms.map((m, i) => ({ m, k: nth(keys, i) })).sort((a, b) => a.k - b.k).map(({ m }) => m);
  const out = nested ? inError(root, order) : order(root);
  return out && join(out);
}

/**
 * Bytes to decode, made from a value's valid encoding: as they are,
 * mutated, random, or with one targeted fault at one place in the value
 * (see {@link sabotage}).
 */
export type Input =
  | { valid: true }
  | { mutated: Mutation }
  | { random: number[] }
  | { sabotage: { site: number; fault: number } };

export const inputArb: fc.Arbitrary<Input> = fc.oneof(
  { arbitrary: fc.constant({ valid: true as const }), weight: 1 },
  { arbitrary: mutationArb.map((m) => ({ mutated: m })), weight: 3 },
  { arbitrary: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 64 }).map((r) => ({ random: r })), weight: 1 },
  {
    arbitrary: fc.record({ site: fc.nat(), fault: fc.nat() }).map((s) => ({ sabotage: s })),
    weight: 3,
  },
);

// ---------------------------------------------------------------------------
// Targeted faults: a typed value written out, with one place in it broken in
// a way a decoder must notice.
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** Byte sequences that aren't UTF-8. */
const INVALID_UTF8 = [
  [0xff],
  [0xc0, 0x80], // overlong NUL
  [0xed, 0xa0, 0x80], // a surrogate
  [0xe2, 0x82], // truncated
  [0x80], // a lone continuation byte
  [0xf4, 0x90, 0x80, 0x80], // past U+10FFFF
];

/** The shortest unsigned LEB128 spelling of `n`. */
function varint(n: bigint): number[] {
  const out: number[] = [];
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
}

/** A longer spelling of `n`: a continuation byte too many, then zero. */
function overlong(n: bigint): number[] {
  const v = varint(n);
  v[v.length - 1]! |= 0x80;
  return [...v, 0x00];
}

/** How the walk below writes, and where it breaks the value. */
interface Saboteur {
  /** Which place to break, counting from 0; the walk counts down. */
  site: number;
  /** Which fault, among those that fit the place. */
  fault: number;
}

/** Whether this is the place to break, counting it if it can be broken. */
function here(s: Saboteur): boolean {
  return s.site-- === 0;
}

const pick = <T>(s: Saboteur, faults: readonly T[]): T => faults[s.fault % faults.length]!;

function le(n: bigint, bytes: number): number[] {
  const u = BigInt.asUintN(bytes * 8, n);
  return Array.from({ length: bytes }, (_, i) => Number((u >> BigInt(8 * i)) & 0xffn));
}

const WIDTH: Record<string, number> = { u8: 1, u16: 2, u32: 4, i8: 1, i16: 2, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16 };

/** `value` as `packed@1`, independently of the runtime, with `s`'s fault. */
function packed(t: Type, value: Json, s: Saboteur, out: number[]): void {
  const [[kind, inner]] = Object.entries(value as { [k: string]: Json }) as [[string, Json]];
  if (typeof t === "string") {
    switch (t) {
      case "bool":
        if (here(s)) return void out.push(2 + (s.fault % 254));
        return void out.push(inner ? 1 : 0);
      case "f32": {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setFloat32(0, inner as number, true);
        return void out.push(...b);
      }
      case "f64": {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, inner as number, true);
        return void out.push(...b);
      }
      case "string": {
        const b = Array.from(utf8.encode(inner as string));
        if (here(s)) {
          const fault = pick(s, ["overlong", "past", "utf8"] as const);
          if (fault === "overlong") return void out.push(...overlong(BigInt(b.length)), ...b);
          if (fault === "past") return void out.push(...varint(BigInt(b.length + 1 + s.fault)), ...b);
          const bad = INVALID_UTF8[s.fault % INVALID_UTF8.length]!;
          const text = [...b.slice(0, b.length >> 1), ...bad, ...b.slice(b.length >> 1)];
          return void out.push(...varint(BigInt(text.length)), ...text);
        }
        return void out.push(...varint(BigInt(b.length)), ...b);
      }
      case "unit":
        return;
      default:
        return void out.push(...le(BigInt(inner as number | string), WIDTH[t]!));
    }
  }
  if ("option" in t) {
    if (here(s)) out.push(2 + (s.fault % 254));
    else out.push(inner === null ? 0 : 1);
    if (inner !== null) packed(t.option, inner, s, out);
    return;
  }
  if ("array" in t || "fixed" in t) {
    const items = inner as Json[];
    if ("array" in t) {
      if (here(s)) {
        const fault = pick(s, ["overlong", "past", "huge", "eleven"] as const);
        if (fault === "overlong") out.push(...overlong(BigInt(items.length)));
        else if (fault === "past") out.push(...varint(BigInt(items.length + 1)));
        else if (fault === "huge") out.push(...varint(1n << BigInt(32 + (s.fault % 32))));
        // Ten continuation bytes: no u64 is that long.
        else out.push(...Array<number>(10).fill(0xff), 0x01);
      } else {
        out.push(...varint(BigInt(items.length)));
      }
    }
    const of = "array" in t ? t.array : t.fixed.of;
    for (const item of items) packed(of, item, s, out);
    return;
  }
  if ("struct" in t) {
    const { fields } = inner as { fields: [string, Json][] };
    t.struct.fields.forEach(([, f], i) => packed(f, fields[i]![1], s, out));
    return;
  }
  const { index } = inner as { index: number };
  if (here(s)) {
    const fault = pick(s, ["unknown", "overlong"] as const);
    if (fault === "unknown") return void out.push(...varint(BigInt(t.enum.variants.length + (s.fault % 3))));
    return void out.push(...overlong(BigInt(index)));
  }
  out.push(...varint(BigInt(index)));
}

/** A string of JSON text with raw bytes spliced in: what `json` writes. */
type Text = (string | number[])[];

const LIMITS: Record<string, readonly [bigint, bigint]> = {
  ...Object.fromEntries(Object.entries(NARROW).map(([k, [a, b]]) => [k, [BigInt(a), BigInt(b)] as const])),
  ...WIDE,
};

/** `value` as `json@1`, independently of the runtime, with `s`'s fault. */
function json(t: Type, value: Json, s: Saboteur, out: Text): void {
  const [[, inner]] = Object.entries(value as { [k: string]: Json }) as [[string, Json]];
  if (typeof t === "string") {
    switch (t) {
      case "bool":
        if (here(s)) return void out.push(pick(s, ["2", '"true"', "0", "null"]));
        return void out.push(String(inner));
      case "f32":
      case "f64":
        if (here(s)) return void out.push(pick(s, t === "f32" ? ["1e39", "-4e38", '"1"', "NaN"] : ["1e309", "-2e308", '"1"', "Infinity"]));
        return void out.push(JSON.stringify(inner));
      case "string":
        if (here(s)) {
          const fault = pick(s, ["utf8", "surrogate", "number", "control"] as const);
          if (fault === "utf8") return void out.push('"a', INVALID_UTF8[s.fault % INVALID_UTF8.length]!, 'b"');
          if (fault === "surrogate") return void out.push(pick(s, ['"\\ud800"', '"\\udc00x"', '"a\\udbff"']));
          if (fault === "control") return void out.push('"a\tb"');
          return void out.push("1");
        }
        return void out.push(JSON.stringify(inner));
      case "unit":
        if (here(s)) return void out.push(pick(s, ["0", "{}", "[]", "false"]));
        return void out.push("null");
      default: {
        if (here(s)) {
          const [min, max] = LIMITS[t]!;
          const n = BigInt(inner as number | string);
          return void out.push(
            pick(s, [
              (max + 1n).toString(),
              (min - 1n).toString(),
              (max + (1n << 70n)).toString(),
              `${n}.0`,
              `${n}e0`,
              `${n}.5`,
              "-0",
              `"${n}"`,
            ]),
          );
        }
        return void out.push(typeof inner === "string" ? inner : String(inner));
      }
    }
  }
  if ("option" in t) {
    if (inner === null) return void out.push("null");
    return json(t.option, inner, s, out);
  }
  if ("array" in t || "fixed" in t) {
    let items = inner as Json[];
    if ("fixed" in t && here(s)) {
      // One element short, or one too many.
      items = s.fault % 2 === 0 || items.length === 0 ? [...items, ...items.slice(0, 1)] : items.slice(1);
      if (items.length === (inner as Json[]).length) items = [];
    }
    const of = "array" in t ? t.array : t.fixed.of;
    out.push("[");
    items.forEach((item, i) => {
      if (i > 0) out.push(",");
      json(of, item, s, out);
    });
    return void out.push("]");
  }
  if ("struct" in t) {
    let fields = (inner as { fields: [string, Json][] }).fields.map(
      ([name, v], i) => [name, v, t.struct.fields[i]![1]] as const,
    );
    if (fields.length > 0 && here(s)) {
      const at = s.fault % fields.length;
      const fault = pick(s, ["missing", "duplicate", "unknown"] as const);
      if (fault === "missing") fields = fields.filter((_, i) => i !== at);
      else if (fault === "duplicate") fields = [...fields, fields[at]!];
      else {
        // A field the reader doesn't declare: ignored, by both.
        out.push('{"zz":0');
        for (const [name, v, ft] of fields) {
          out.push(`,${JSON.stringify(name)}:`);
          json(ft, v, s, out);
        }
        return void out.push("}");
      }
    }
    out.push("{");
    fields.forEach(([name, v, ft], i) => {
      out.push(`${i > 0 ? "," : ""}${JSON.stringify(name)}:`);
      json(ft, v, s, out);
    });
    return void out.push("}");
  }
  const { variant, index } = inner as { variant: string; index: number };
  if (here(s)) return void out.push(pick(s, ['"Purple"', String(index), '"red"', "null"]));
  out.push(JSON.stringify(variant));
}

/**
 * `value` written as `format` with one targeted fault, at the `site`-th
 * place in it that can be broken: a bool or option tag of 2 or more, an
 * unknown variant, an overlong varint, a count or length past the end,
 * invalid UTF-8, and in JSON out-of-range or mis-spelled integers, floats
 * past their range, missing, repeated and unknown fields, and fixed arrays
 * of the wrong length. `undefined` when the value has no such place.
 */
export function sabotage(format: string, t: Type, value: Json, site: number, fault: number): Uint8Array | undefined {
  // A first walk counts the places; the second breaks one of them.
  const counter: Saboteur = { site: -1, fault };
  if (format === "packed@1") packed(t, value, counter, []);
  else json(t, value, counter, []);
  const places = -1 - counter.site;
  if (places === 0) return undefined;
  const s: Saboteur = { site: site % places, fault };
  if (format === "packed@1") {
    const out: number[] = [];
    packed(t, value, s, out);
    return Uint8Array.from(out);
  }
  const out: Text = [];
  json(t, value, s, out);
  return Uint8Array.from(out.flatMap((part) => (typeof part === "string" ? Array.from(utf8.encode(part)) : part)));
}

/** The bytes an {@link Input} stands for, given the value's valid encoding. */
export function inputBytes(input: Input, format: string, typed: Typed, valid: Uint8Array): Uint8Array {
  if ("mutated" in input) return mutate(valid, input.mutated);
  if ("random" in input) return Uint8Array.from(input.random);
  if ("sabotage" in input) {
    return sabotage(format, typed.type, typed.value, input.sabotage.site, input.sabotage.fault) ?? valid;
  }
  return valid;
}
