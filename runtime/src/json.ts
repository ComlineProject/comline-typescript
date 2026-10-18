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
        const key = token(STRING) ?? fail();
        space();
        if (text[at++] !== ":") fail();
        members.set(JSON.parse(key) as string, value());
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
      const raw = token(STRING) ?? fail();
      return { kind: "string", value: JSON.parse(raw) as string, start, end: at };
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
