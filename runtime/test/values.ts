// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The conformance corpus's typed values and reader types, and how they map
 * to what generated TypeScript holds and declares. Shared by the vector
 * runner (`conformance.test.ts`) and the differential properties
 * (`prop/*.test.ts`). The encoding is described in the runtime repository's
 * `runtime/conformance/README.md`.
 */

import type { Layout } from "../src/index.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The scalar types, by their corpus names. */
export const SCALARS = [
  "bool",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "f32",
  "f64",
  "string",
  "unit",
] as const;

export type Scalar = (typeof SCALARS)[number];

/** A reader type, as a `decode` case describes it. */
export type Type =
  | Scalar
  | { option: Type }
  | { array: Type }
  | { fixed: { of: Type; len: number } }
  | { struct: { name: string; fields: [string, Type][] } }
  | { enum: { name: string; variants: string[] } };

/** The integers generated TypeScript holds as `number`, with their ranges. */
export const NARROW: Record<string, readonly [number, number]> = {
  u8: [0, 0xff],
  u16: [0, 0xffff],
  u32: [0, 0xffff_ffff],
  i8: [-0x80, 0x7f],
  i16: [-0x8000, 0x7fff],
  i32: [-0x8000_0000, 0x7fff_ffff],
};

/** The integers generated TypeScript holds as `bigint`, with their ranges. */
export const WIDE: Record<string, readonly [bigint, bigint]> = {
  u64: [0n, (1n << 64n) - 1n],
  i64: [-(1n << 63n), (1n << 63n) - 1n],
  u128: [0n, (1n << 128n) - 1n],
  i128: [-(1n << 127n), (1n << 127n) - 1n],
};

const kindOf = (value: Json): [string, Json] =>
  Object.entries(value as { [key: string]: Json })[0] as [string, Json];

/**
 * A typed value as generated TypeScript holds it: a 64- or 128-bit integer
 * a `bigint`, every narrower one a `number`, an absent optional and `()`
 * `undefined`, a unit enum variant its name.
 */
export function toJs(value: Json): unknown {
  const [kind, inner] = kindOf(value);
  switch (kind) {
    case "u64":
    case "i64":
    case "u128":
    case "i128":
      return BigInt(inner as string);
    case "bool":
    case "u8":
    case "u16":
    case "u32":
    case "i8":
    case "i16":
    case "i32":
    case "f32":
    case "f64":
    case "string":
      return inner;
    case "unit":
      return undefined;
    case "array":
    case "tuple":
      return (inner as Json[]).map(toJs);
    case "option":
      return inner === null ? undefined : toJs(inner);
    case "struct": {
      const { fields } = inner as { fields: [string, Json][] };
      return Object.fromEntries(fields.map(([name, v]) => [name, toJs(v)]));
    }
    case "unit_variant":
      return (inner as { variant: string }).variant;
    default:
      throw new Error(`unknown value kind \`${kind}\``);
  }
}

/** A scalar type's {@link Layout} name: signed integers are `s`-prefixed. */
function scalarLayout(name: Scalar): Layout {
  return (name.startsWith("i") ? `s${name.slice(1)}` : name) as Layout;
}

/**
 * The {@link Layout} generated code would declare for a typed value. An
 * empty array or an absent optional says nothing of its element, which
 * takes no bytes then anyway; an enum's variants other than the one written
 * are placeholders, the index being what's on the wire.
 */
export function layoutOf(value: Json): Layout {
  const [kind, inner] = kindOf(value);
  if ((SCALARS as readonly string[]).includes(kind)) return scalarLayout(kind as Scalar);
  switch (kind) {
    case "array": {
      const [first] = inner as Json[];
      return { array: first === undefined ? "u8" : layoutOf(first) };
    }
    case "tuple": {
      const items = inner as Json[];
      return { fixed: items.length === 0 ? "u8" : layoutOf(items[0]!), length: items.length };
    }
    case "option":
      return { option: inner === null ? "u8" : layoutOf(inner) };
    case "struct": {
      const { fields } = inner as { fields: [string, Json][] };
      return { struct: fields.map(([name, v]) => [name, layoutOf(v)] as const) };
    }
    case "unit_variant": {
      const { index, variant } = inner as { index: number; variant: string };
      const variants = Array.from({ length: index + 1 }, (_, i) => `#${i}`);
      variants[index] = variant;
      return { enum: variants };
    }
    default:
      throw new Error(`unknown value kind \`${kind}\``);
  }
}

/** A reader type as the {@link Layout} generated code declares for it. */
export function layoutOfType(type: Type): Layout {
  if (typeof type === "string") return scalarLayout(type);
  if ("option" in type) return { option: layoutOfType(type.option) };
  if ("array" in type) return { array: layoutOfType(type.array) };
  if ("fixed" in type) return { fixed: layoutOfType(type.fixed.of), length: type.fixed.len };
  if ("struct" in type) {
    return { struct: type.struct.fields.map(([name, t]) => [name, layoutOfType(t)] as const) };
  }
  return { enum: type.enum.variants };
}

/**
 * What generated TypeScript holds after decoding `v` as `type`, as a typed
 * value. Generated code takes a decoded value as it is, so nothing here
 * checks more than it does: an unknown variant or an out-of-range integer
 * comes through, and whatever doesn't fit the type is kept as it is, so it
 * compares unequal to any real value of the type.
 *
 * An `f32` is rounded to single precision, as the field holds it; a
 * non-finite float is `null`, as the corpus's JSON writes it.
 */
export function fromJs(type: Type, v: unknown): Json {
  if (typeof type === "string") {
    switch (type) {
      case "u64":
      case "i64":
      case "u128":
      case "i128":
        return { [type]: typeof v === "bigint" ? v.toString() : (v as Json) };
      case "f32":
      case "f64": {
        if (typeof v !== "number") return { [type]: v as Json };
        const f = type === "f32" ? Math.fround(v) : v;
        return { [type]: Number.isFinite(f) ? f : null };
      }
      case "unit":
        return { unit: v === undefined ? null : (v as Json) };
      default:
        return { [type]: v as Json };
    }
  }
  if ("option" in type) return { option: v === undefined || v === null ? null : fromJs(type.option, v) };
  if ("array" in type || "fixed" in type) {
    const kind = "array" in type ? "array" : "tuple";
    const of = "array" in type ? type.array : type.fixed.of;
    return { [kind]: Array.isArray(v) ? v.map((item) => fromJs(of, item)) : (v as Json) };
  }
  if ("struct" in type) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { struct: v as Json };
    const o = v as { [field: string]: unknown };
    return {
      struct: {
        name: type.struct.name,
        fields: type.struct.fields.map(([field, t]) => [field, fromJs(t, o[field])]),
      },
    };
  }
  const variant = v as string;
  return {
    unit_variant: {
      enum: type.enum.name,
      index: type.enum.variants.indexOf(variant),
      variant,
    },
  };
}

/**
 * Whether two typed values are the same: floats by `Object.is` (so `-0`
 * isn't `0`, and `null` stands for every non-finite float), everything else
 * structurally, struct fields in order.
 */
export function sameValue(a: Json, b: Json): boolean {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return Object.is(a, b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameValue(x, b[i]!))
    );
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => {
    const x = a[k]!;
    const y = b[k]!;
    // An integer is equal to itself however it's signed: `-0` is `0`.
    if (k in NARROW && typeof x === "number" && typeof y === "number") return x === y;
    return sameValue(x, y);
  });
}
