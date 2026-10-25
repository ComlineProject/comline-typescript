// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * JSON without the double-precision detour. `JSON.parse` turns every number
 * into a `number`, which rounds integers above 2^53, and `JSON.stringify`
 * refuses `bigint`. The wire needs both exact: a JSON-RPC id or a payload
 * passes through a framing as written, and a 64-bit integer goes out with
 * all its digits.
 */

/** A parsed JSON value that keeps each number's digits and each value's span. */
export type JsonNode = { readonly start: number; readonly end: number } & (
  | { readonly kind: "null" | "true" | "false" }
  | { readonly kind: "number"; readonly raw: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly JsonNode[] }
  | { readonly kind: "object"; readonly members: ReadonlyMap<string, JsonNode> }
);

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const SPACE = /[ \t\n\r]*/y;
/** Half a surrogate pair, alone: `\ud800` escapes to no Unicode scalar value. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Parses `text` as one JSON value; throws `SyntaxError` on anything else. */
export function parseJson(text: string): JsonNode {
  let at = 0;
  const fail = (): never => {
    throw new SyntaxError(`invalid JSON at ${at}`);
  };
  const space = () => {
    SPACE.lastIndex = at;
    SPACE.exec(text);
    at = SPACE.lastIndex;
  };
  // A string's value; one escaping half a surrogate pair is refused, as
  // serde_json refuses it.
  const string = (): string => {
    const value = JSON.parse(token(STRING) ?? fail()) as string;
    if (LONE_SURROGATE.test(value)) fail();
    return value;
  };
  const token = (re: RegExp): string | undefined => {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) return undefined;
    at = re.lastIndex;
    return m[0];
  };
  const value = (): JsonNode => {
    space();
    const start = at;
    const c = text[at];
    if (c === "{") {
      at++;
      const members = new Map<string, JsonNode>();
      space();
      if (text[at] === "}") {
        at++;
        return { kind: "object", members, start, end: at };
      }
      for (;;) {
        space();
        const key = string();
        space();
        if (text[at++] !== ":") fail();
        members.set(key, value());
        space();
        const next = text[at++];
        if (next === "}") return { kind: "object", members, start, end: at };
        if (next !== ",") fail();
      }
    }
    if (c === "[") {
      at++;
      const items: JsonNode[] = [];
      space();
      if (text[at] === "]") {
        at++;
        return { kind: "array", items, start, end: at };
      }
      for (;;) {
        items.push(value());
        space();
        const next = text[at++];
        if (next === "]") return { kind: "array", items, start, end: at };
        if (next !== ",") fail();
      }
    }
    if (c === '"') {
      return { kind: "string", value: string(), start, end: at };
    }
    for (const kind of ["null", "true", "false"] as const) {
      if (text.startsWith(kind, at)) {
        at += kind.length;
        return { kind, start, end: at };
      }
    }
    const raw = token(NUMBER) ?? fail();
    return { kind: "number", raw, start, end: at };
  };

  const root = value();
  space();
  if (at !== text.length) fail();
  return root;
}

/**
 * A JSON number's exact value, written one way: `1`, `1.0` and `10e-1` all
 * give `1e0`.
 */
export function canonicalNumber(raw: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!m) throw new SyntaxError(`not a JSON number: ${raw}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  let digits = (int! + frac).replace(/^0+/, "");
  let e = Number(exp) - frac.length;
  if (digits === "") return "0e0";
  const trailing = digits.length - digits.replace(/0+$/, "").length;
  digits = digits.slice(0, digits.length - trailing);
  e += trailing;
  return `${sign}${digits}e${e}`;
}

/** Whether two parsed values are equal as JSON, numbers compared exactly. */
export function jsonEqual(a: JsonNode, b: JsonNode): boolean {
  switch (a.kind) {
    case "number":
      return b.kind === "number" && canonicalNumber(a.raw) === canonicalNumber(b.raw);
    case "string":
      return b.kind === "string" && a.value === b.value;
    case "array":
      return (
        b.kind === "array" &&
        a.items.length === b.items.length &&
        a.items.every((item, i) => jsonEqual(item, b.items[i]!))
      );
    case "object":
      if (b.kind !== "object" || a.members.size !== b.members.size) return false;
      for (const [key, value] of a.members) {
        const other = b.members.get(key);
        if (!other || !jsonEqual(value, other)) return false;
      }
      return true;
    default:
      return a.kind === b.kind;
  }
}

/**
 * A JSON integer's exact value as a `bigint`, or `undefined` if `node` isn't
 * an integer.
 */
export function jsonInteger(node: JsonNode | undefined): bigint | undefined {
  if (node?.kind !== "number") return undefined;
  const [, sign, digits, e] = /^(-?)(\d+)e(-?\d+)$/.exec(canonicalNumber(node.raw))!;
  const exp = Number(e);
  // A negative exponent left after canonicalizing is a fraction. A large one
  // is no wire integer, and `1e999999999` mustn't build a billion digits.
  if (exp < 0 || digits!.length + exp > 40) return undefined;
  return BigInt(`${sign}${digits}${"0".repeat(exp)}`);
}

/**
 * `value` as JSON text, as the Rust runtime's serde writes the same shape:
 * a `bigint` with all its digits, and an absent value (`undefined`, an
 * optional that isn't there) as `null`, also as an object member.
 */
export function stringifyJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object": {
      const v = value as { toJSON?: () => unknown };
      if (typeof v.toJSON === "function") return stringifyJson(v.toJSON());
      if (Array.isArray(value)) return `[${value.map(stringifyJson).join(",")}]`;
      const members = Object.entries(value).map(
        ([key, member]) => `${JSON.stringify(key)}:${stringifyJson(member)}`,
      );
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`not JSON-serializable: ${typeof value}`);
  }
}

/**
 * Where a decoded value holds integers too wide for `number`, as generated
 * code describes its types: each type with a 64- or 128-bit integer in it
 * gets a `Shape` beside its interface, under the same name.
 *
 * - `"bigint"`: an integer read exactly, as a `bigint`.
 * - `"number"`, `"string"`, `"boolean"`: a value read as `JSON.parse` would.
 *   They only matter as union members, to tell the members apart.
 * - `{ array }`, `{ fields }`: the shape of each element, or of the named
 *   fields. A field not listed is read as `JSON.parse` would. An array
 *   with a `length` (a fixed-size array, `T[N]`) must have exactly that
 *   many elements.
 * - `{ union }`: the first member whose kind the JSON value has.
 * - A function: a named type's shape, looked up only when it's needed, so
 *   types can refer to each other in any order, and recursively.
 */
export type Shape =
  | "bigint"
  | "number"
  | "string"
  | "boolean"
  | { readonly array: Shape; readonly length?: number }
  | { readonly fields: { readonly [name: string]: Shape } }
  | { readonly union: readonly Shape[] }
  | (() => Shape);

type Resolved = Exclude<Shape, () => Shape>;

function resolve(shape: Shape | undefined): Resolved | undefined {
  while (typeof shape === "function") shape = shape();
  return shape;
}

/** Whether a value of `shape` can be the JSON value `node`. */
function admits(shape: Resolved, node: JsonNode): boolean {
  if (typeof shape === "string") {
    if (shape === "bigint" || shape === "number") return node.kind === "number";
    if (shape === "boolean") return node.kind === "true" || node.kind === "false";
    return node.kind === "string";
  }
  if ("array" in shape) return node.kind === "array";
  if ("fields" in shape) return node.kind === "object";
  return shape.union.some((member) => admits(resolve(member)!, node));
}

/**
 * `node` as a value of `shape`: `JSON.parse`'s reading, except that a
 * `"bigint"` is read exactly and `null` reads as an absent value (the IDL
 * has no null).
 */
export function decodeJson(node: JsonNode, shape?: Shape): unknown {
  let s = resolve(shape);
  if (s && typeof s === "object" && "union" in s) {
    s = s.union.map(resolve).find((member) => admits(member!, node));
  }
  switch (node.kind) {
    case "null":
      return undefined;
    case "true":
      return true;
    case "false":
      return false;
    case "string":
      return node.value;
    case "number": {
      if (s !== "bigint") return Number(node.raw);
      const n = jsonInteger(node);
      if (n === undefined) throw new SyntaxError(`expected an integer, got ${node.raw}`);
      return n;
    }
    case "array": {
      const array = s && typeof s === "object" && "array" in s ? s : undefined;
      if (array?.length !== undefined && node.items.length !== array.length) {
        throw new SyntaxError(`expected ${array.length} elements, got ${node.items.length}`);
      }
      return node.items.map((item) => decodeJson(item, array?.array));
    }
    case "object": {
      const fields = s && typeof s === "object" && "fields" in s ? s.fields : undefined;
      // An absent optional is left out, as `JSON.parse` with nulls dropped
      // leaves it. `fromEntries` defines own properties, so a `__proto__`
      // member stays data.
      const entries = [...node.members].map(([key, member]) => [
        key,
        decodeJson(member, fields && Object.hasOwn(fields, key) ? fields[key] : undefined),
      ]);
      return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
    }
  }
}
