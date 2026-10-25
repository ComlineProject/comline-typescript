// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the differential properties share: the reference process, the run
 * count, and the known divergences.
 *
 * A **divergence** is a case where this runtime and `comline-reference`
 * answer differently. `known-divergences.json` lists divergence classes,
 * each tied to the issue that will fix it. A divergence is classified by a
 * predicate over the case (`CLASSES` below): one in a listed class is
 * reported in a summary and passes; any other fails the property, which
 * fast-check then shrinks. A class's predicate looks at what makes the case
 * diverge, not merely at its format, so an unrelated bug in the same format
 * still fails: a JSON value TypeScript accepts and the reference refuses is
 * #57 only when the value has an undeclared variant or an out-of-range
 * integer in it, and nothing else wrong with it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { jsonEqual, parseJson, type JsonNode } from "../../src/json.js";
import { Reference, stringify, unavailable } from "../reference.js";
import { NARROW, WIDE, type Json, type Type } from "../values.js";

const RUNTIME = new URL("../../../", import.meta.url);

/** Runs per property: short by default, so `npm test` stays fast. */
export const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 100;

/** fast-check's parameters: the run count, and `FC_SEED` to replay a run. */
export function params(): { numRuns: number; includeErrorInReport: true; seed?: number; path?: string } {
  return {
    numRuns: NUM_RUNS,
    // The divergence, with what each side answered, in the failure itself.
    includeErrorInReport: true,
    ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}),
    ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
  };
}

const inCi = (): boolean => !!process.env.CI && process.env.CI !== "false";

/**
 * A suite of properties against the reference, which `body` reaches through
 * the function it's given. Without the reference the suite is skipped,
 * saying why, except in CI, where that fails: a suite that runs nothing
 * mustn't pass there.
 */
export function withReference(name: string, body: (reference: () => Reference) => void): void {
  const why = unavailable();
  if (why) {
    if (inCi()) test(name, () => assert.fail(`the reference is required in CI: ${why}`));
    else test(name, { skip: why }, () => {});
    return;
  }
  let reference: Reference | undefined;
  describe(name, () => {
    before(async () => {
      reference = await Reference.start();
    });
    after(async () => {
      await reference?.close();
      summarize(name);
    });
    body(() => reference!);
  });
}

// ---------------------------------------------------------------------------
// Known divergences
// ---------------------------------------------------------------------------

/** One case where the two runtimes answered differently. */
export interface Divergence {
  /** Which property found it: `encode`, `decode`, a frame op, or `session`. */
  property: string;
  format?: string;
  /** For a frame: its framing, and the op's input. */
  framing?: string;
  input?: Json;
  type?: Type;
  value?: Json;
  /** The bytes decoded, for a decode. */
  bytes?: Uint8Array;
  /** What each side answered, as text, for the report. */
  ts: string;
  reference: string;
  /** For an encode: the two encodings. */
  tsBytes?: Uint8Array;
  referenceBytes?: Uint8Array;
  /** For a decode: whether each side accepted the bytes. */
  tsAccepted?: boolean;
  referenceAccepted?: boolean;
  /** For a connection sequence: the session, and where the two sides' steps part. */
  session?: SessionDivergence;
}

/** A connection sequence whose steps differ first at `at`. */
export interface SessionDivergence {
  ordered: boolean;
  /** The session's events, all of them. */
  events: Json[];
  at: number;
  /** Each side's steps, up to and including `at`. */
  ts: Json[];
  reference: Json[];
  /** When the event at `at` is a received frame: the request id the reference reads it as a reply to. */
  referenceRead?: string;
}

interface Known {
  issue: string;
  note: string;
}

const KNOWN: Record<string, Known> = (
  JSON.parse(readFileSync(new URL("known-divergences.json", RUNTIME), "utf8")) as {
    classes: Record<string, Known>;
  }
).classes;

const text = new TextDecoder("utf-8", { fatal: true });

/**
 * What's wrong with JSON `node` as a value of `t`, as `serde` derives read
 * it, by kind: `variant` (not a declared variant), `int-range` (an integer
 * outside its type's range), `int-spelling` (an integer written with a
 * fraction or an exponent, or as `-0`), `float-range` (past the float's
 * range), `kind` (the wrong JSON kind), `missing` (a required field absent),
 * `duplicate` (a field twice), `length` (a fixed array's length),
 * `surrogate` (a string holding half a surrogate pair).
 */
function violations(t: Type, node: JsonNode, duplicates: Map<number, Set<string>>, out: Set<string>): void {
  if (typeof t === "string") {
    if (t === "bool") {
      if (node.kind !== "true" && node.kind !== "false") out.add("kind");
    } else if (t === "unit") {
      if (node.kind !== "null") out.add("kind");
    } else if (t === "string") {
      if (node.kind !== "string") out.add("kind");
      else if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(node.value)) {
        out.add("surrogate");
      }
    } else if (t === "f32" || t === "f64") {
      if (node.kind !== "number") out.add("kind");
      else {
        const f = Number(node.raw);
        if (!Number.isFinite(t === "f32" ? Math.fround(f) : f)) out.add("float-range");
      }
    } else if (node.kind !== "number") {
      out.add("kind");
    } else if (/[.eE]/.test(node.raw) || node.raw === "-0") {
      out.add("int-spelling");
    } else {
      const [min, max] = t in NARROW ? NARROW[t]!.map(BigInt) : WIDE[t]!;
      const n = BigInt(node.raw);
      if (n < min! || n > max!) out.add("int-range");
    }
    return;
  }
  if ("option" in t) {
    if (node.kind !== "null") violations(t.option, node, duplicates, out);
    return;
  }
  if ("array" in t || "fixed" in t) {
    if (node.kind !== "array") return void out.add("kind");
    if ("fixed" in t && node.items.length !== t.fixed.len) out.add("length");
    const of = "array" in t ? t.array : t.fixed.of;
    for (const item of node.items) violations(of, item, duplicates, out);
    return;
  }
  if ("struct" in t) {
    if (node.kind !== "object") return void out.add("kind");
    if (duplicates.has(node.start)) out.add("duplicate");
    for (const [name, f] of t.struct.fields) {
      const member = node.members.get(name);
      if (member === undefined) {
        if (typeof f !== "object" || !("option" in f)) out.add("missing");
      } else violations(f, member, duplicates, out);
    }
    return;
  }
  if (node.kind !== "string") out.add("kind");
  else if (!t.enum.variants.includes(node.value)) out.add("variant");
}

/** The objects in valid JSON `s` that have a member twice: where each starts, and the members. */
function duplicateKeys(s: string): Map<number, Set<string>> {
  const found = new Map<number, Set<string>>();
  const stack: { start: number; keys: Set<string> | undefined; key: boolean }[] = [];
  const STRING = /"(?:[^"\\]|\\.)*"/y;
  for (let at = 0; at < s.length; at++) {
    const c = s[at]!;
    const top = stack[stack.length - 1];
    if (c === '"') {
      STRING.lastIndex = at;
      const raw = STRING.exec(s)![0];
      if (top?.keys && top.key) {
        const key = JSON.parse(raw) as string;
        if (top.keys.has(key)) found.set(top.start, (found.get(top.start) ?? new Set()).add(key));
        top.keys.add(key);
        top.key = false;
      }
      at += raw.length - 1;
    } else if (c === "{") stack.push({ start: at, keys: new Set(), key: true });
    else if (c === "[") stack.push({ start: at, keys: undefined, key: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && top?.keys) top.key = true;
  }
  return found;
}

/** Whether two JSON values are equal, numbers at `f32` places compared as `f32`s. */
function equalAsF32(t: Type, a: JsonNode, b: JsonNode): boolean {
  if (t === "f32") {
    return a.kind === "number" && b.kind === "number" && Math.fround(Number(a.raw)) === Math.fround(Number(b.raw));
  }
  if (typeof t === "string" || "enum" in t) return jsonEqual(a, b);
  if ("option" in t) return a.kind === "null" ? b.kind === "null" : b.kind !== "null" && equalAsF32(t.option, a, b);
  if ("array" in t || "fixed" in t) {
    const of = "array" in t ? t.array : t.fixed.of;
    return (
      a.kind === "array" &&
      b.kind === "array" &&
      a.items.length === b.items.length &&
      a.items.every((x, i) => equalAsF32(of, x, b.items[i]!))
    );
  }
  if (a.kind !== "object" || b.kind !== "object" || a.members.size !== b.members.size) return false;
  return t.struct.fields.every(([name, f]) => {
    const x = a.members.get(name);
    const y = b.members.get(name);
    return x !== undefined && y !== undefined && equalAsF32(f, x, y);
  });
}

/** A JSON number that isn't written as an integer: `1.0`, `1e0`, `-0`. */
const misspelled = (node: JsonNode | undefined): boolean =>
  node?.kind === "number" && (/[.eE]/.test(node.raw) || node.raw === "-0");

/**
 * Whether a JSON-RPC frame has a member the reference declares twice, or an
 * `id` or error `code` that is an integer in value but not in spelling: the
 * two things TypeScript's JSON-RPC framing lets through that `serde` refuses.
 */
function jsonRpcLenient(bytes: Uint8Array): boolean {
  let source: string;
  let root: JsonNode;
  try {
    source = text.decode(bytes);
    root = parseJson(source);
  } catch {
    return false;
  }
  if (root.kind !== "object") return false;
  const error = root.members.get("error");
  const duplicates = duplicateKeys(source);
  const twice = (node: JsonNode | undefined, declared: string[]) =>
    node !== undefined && [...(duplicates.get(node.start) ?? [])].some((k) => declared.includes(k));
  return (
    twice(root, ["method", "params", "id", "result", "error"]) ||
    (error?.kind === "object" && twice(error, ["code", "data"])) ||
    misspelled(root.members.get("id")) ||
    (error?.kind === "object" && misspelled(error.members.get("code")))
  );
}

/** The classes a JSON-decode violation belongs to. */
const VIOLATION_CLASS: Record<string, string> = {
  variant: "json-decode-unchecked-variants-and-ranges",
  "int-range": "json-decode-unchecked-variants-and-ranges",
  kind: "json-decode-unchecked-shape",
  missing: "json-decode-unchecked-shape",
  duplicate: "json-decode-unchecked-shape",
  length: "json-decode-unchecked-shape",
  "int-spelling": "json-decode-unchecked-shape",
  "float-range": "json-decode-unchecked-shape",
  // `surrogate` is in no class: decoding refuses half a surrogate pair.
};

/**
 * The divergence classes, by id, each a predicate giving the classes that
 * explain a divergence: all of them must be listed for it to be known.
 */
const CLASSES: Record<string, true> = {
  "json-decode-unchecked-variants-and-ranges": true,
  "json-decode-unchecked-shape": true,
  "json-encode-f32-digits": true,
  "jsonrpc-decode-lenient": true,
  "connection-replies-in-any-order": true,
};

/**
 * Whether a connection sequence parts where an ordered (nested) State
 * refuses a reply that skips the innermost waiting call, and TypeScript, which
 * has only the async model, hands the reply to the call it answers: the
 * reference reads the frame as a reply to that call, which its own steps say
 * is waiting but not innermost, and TypeScript's step is exactly that reply.
 */
function skipsInnermost(s: SessionDivergence): boolean {
  const event = s.events[s.at] as { [key: string]: Json } | undefined;
  const ours = s.ts[s.at] as { event?: { reply?: { request_id?: Json } } } | undefined;
  const id = ours?.event?.reply?.request_id;
  if (!s.ordered || typeof event?.receive !== "string" || typeof id !== "string") return false;
  if (stringify(s.reference[s.at]) !== stringify({ error: "framing" }) || s.referenceRead !== id) return false;
  const waiting: string[] = [];
  for (let i = 0; i < s.at; i++) {
    const e = s.events[i] as { [key: string]: { [key: string]: Json } | string };
    const step = s.reference[i] as { request_id?: string; event?: { reply?: { request_id: string } } };
    const drop = (id: string) => {
      const at = waiting.indexOf(id);
      if (at >= 0) waiting.splice(at, 1);
    };
    if (typeof e.call === "object" && !e.call.one_way && step.request_id) waiting.push(step.request_id);
    else if (e.receive !== undefined && step.event?.reply) drop(step.event.reply.request_id);
    else if (typeof e.abandon === "string") drop(e.abandon);
  }
  return waiting.includes(id) && waiting[waiting.length - 1] !== id;
}

/** The classes that explain `d`, or `undefined` if none does. */
function explain(d: Divergence): string[] | undefined {
  if (d.property === "session") {
    return d.session && skipsInnermost(d.session) ? ["connection-replies-in-any-order"] : undefined;
  }
  if (d.framing === "jsonrpc@1") {
    // TypeScript took a JSON-RPC frame the reference refuses, for the reason
    // above.
    if (d.property.endsWith(" decode") && d.tsAccepted && !d.referenceAccepted && d.bytes && jsonRpcLenient(d.bytes)) {
      return ["jsonrpc-decode-lenient"];
    }
    return undefined;
  }
  if (d.format !== "json@1" || !d.type) return undefined;
  // TypeScript accepted JSON the reference refuses: explained only by what
  // is wrong with the value as a value of the type.
  if (d.property === "decode" && d.tsAccepted && !d.referenceAccepted && d.bytes) {
    let source: string;
    let node: JsonNode;
    try {
      source = text.decode(d.bytes);
      node = parseJson(source);
    } catch {
      return undefined;
    }
    const found = new Set<string>();
    violations(d.type, node, duplicateKeys(source), found);
    if (found.size === 0) return undefined;
    const classes = [...found].map((v) => VIOLATION_CLASS[v]);
    return classes.every((c) => c !== undefined) ? [...new Set(classes)] : undefined;
  }
  // TypeScript writes an `f32` with a double's digits: the same `f32`, but
  // not the same JSON number.
  if (d.property === "encode" && d.tsBytes && d.referenceBytes) {
    try {
      const a = parseJson(text.decode(d.tsBytes));
      const b = parseJson(text.decode(d.referenceBytes));
      return equalAsF32(d.type, a, b) ? ["json-encode-f32-digits"] : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

for (const id of Object.keys(KNOWN)) {
  if (!CLASSES[id]) {
    throw new Error(`known-divergences.json lists \`${id}\`, which no predicate in test/prop/harness.ts classifies`);
  }
}

const seen = new Map<string, { count: number; example: Divergence }>();

/**
 * Whether `d` is a known divergence, recording it for the summary if so. A
 * divergence no listed class explains is a failure, described by the
 * returned message.
 */
export function known(d: Divergence): true | string {
  const classes = explain(d);
  const unlisted = classes?.filter((c) => !KNOWN[c]);
  if (classes && unlisted!.length === 0) {
    const key = classes.sort().join(" + ");
    const entry = seen.get(key);
    if (entry) entry.count++;
    else seen.set(key, { count: 1, example: d });
    return true;
  }
  const why = classes
    ? `in class ${unlisted!.map((c) => `\`${c}\``).join(", ")}, which known-divergences.json doesn't list`
    : "in no known class";
  return `${describeDivergence(d)}\n  (${why})`;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function describeDivergence(d: Divergence): string {
  const lines = [`${d.property}${d.format ? ` ${d.format}` : ""}: TypeScript ${d.ts}, the reference ${d.reference}`];
  if (d.type !== undefined) lines.push(`  type: ${stringify(d.type)}`);
  if (d.value !== undefined) lines.push(`  value: ${stringify(d.value)}`);
  if (d.input !== undefined) lines.push(`  input: ${stringify(d.input)}`);
  if (d.bytes) lines.push(`  bytes: ${hex(d.bytes)}`);
  if (d.session) lines.push(`  at event ${d.session.at}`);
  return lines.join("\n");
}

function summarize(suite: string): void {
  if (seen.size === 0) return;
  const lines = [`${suite}: known divergences (reported, not failed):`];
  for (const [key, { count, example }] of seen) {
    const issues = key.split(" + ").map((c) => KNOWN[c]!.issue);
    lines.push(`- ${key} (${issues.join(", ")}): ${count} case(s); e.g.`);
    lines.push(`  ${describeDivergence(example).replace(/\n/g, "\n  ")}`);
  }
  console.log(lines.join("\n"));
  seen.clear();
}
