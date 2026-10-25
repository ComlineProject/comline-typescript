// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Wire conformance: the runtime against the byte-exact vectors of
 * `ComlineProject/runtime`'s `runtime/conformance/`, vendored in
 * `test/conformance/` at the commit in `VECTORS_REV`.
 *
 * Every claim in `conformance-support.json` must hold against the vectors:
 * a supported feature passes all its cases, an unsupported one reports each
 * as not implemented. The result, with the cases proving each claim, is
 * `conformance-report.json`; `CONFORMANCE_BLESS=1 npm test` rewrites it.
 * The vectors' format is described in the runtime repository's
 * `runtime/conformance/README.md`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  DatagramFraming,
  Datagram2Framing,
  FRAMING_DATAGRAM2,
  FORMAT_JSON,
  FORMAT_PACKED,
  FRAMING_DATAGRAM,
  FRAMING_JSONRPC,
  HandshakeFrame,
  JsonCodec,
  JsonRpcConnectionFraming,
  JsonRpcFraming,
  PackedCodec,
  call,
  decodeEnvelope,
  encodeEnvelopeErr,
  encodeEnvelopeFault,
  encodeEnvelopeOk,
  nameHash,
  type DecodedRequest,
  type Envelope,
  type Framing,
} from "../src/index.js";
import { jsonEqual, parseJson } from "../src/json.js";
import { fromJs, layoutOf, layoutOfType, toJs, type Json, type Type } from "./values.js";

// Tests run from `dist/test/`; the vendored corpus and the claims stay in
// the source tree.
const RUNTIME = new URL("../../", import.meta.url);
const CORPUS = new URL("test/conformance/", RUNTIME);
const SUPPORT = new URL("conformance-support.json", RUNTIME);
const REPORT = new URL("conformance-report.json", RUNTIME);

interface Case {
  id: string;
  op: "name_hash" | "handshake" | "envelope" | "request" | "response" | "encode" | "decode";
  input?: { [key: string]: Json };
  bytes: string;
  expect?: "reject";
  compare?: "json";
}

interface Claim {
  state: "supported" | "partial" | "unsupported";
  note?: string;
  tracking?: string;
  failing?: string[];
}

/** What running one case gave. */
type Outcome = { pass: true } | { fail: string } | { notImplemented: string };

class NotImplemented extends Error {}

const readJson = <T>(url: URL): T => JSON.parse(readFileSync(url, "utf8")) as T;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const unhex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

/** Bytes for a message: text when they're printable UTF-8, else hex. */
function show(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/^[\x20-\x7e]*$/.test(text)) return JSON.stringify(text);
  } catch {
    // not UTF-8
  }
  return hex(bytes);
}

const text = new TextDecoder();

/**
 * Whether `got` matches the `wanted` hex as the case compares: byte for
 * byte, or as JSON values.
 */
function matches(c: Case, got: Uint8Array, wanted: string): boolean {
  if (hex(got) === wanted) return true;
  if (c.compare !== "json") return false;
  try {
    return jsonEqual(parseJson(text.decode(got)), parseJson(text.decode(unhex(wanted))));
  } catch {
    return false;
  }
}

/** Order-insensitive equality of decoded and stated inputs. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

function encodeValue(format: string, value: Json): Uint8Array {
  if (format === FORMAT_PACKED) return new PackedCodec().encode(toJs(value), layoutOf(value));
  if (format !== FORMAT_JSON) throw new NotImplemented(`format \`${format}\``);
  return new JsonCodec().encode(toJs(value));
}

function framingOf(name: string): Framing {
  switch (name) {
    case FRAMING_DATAGRAM:
      return new DatagramFraming();
    case FRAMING_JSONRPC:
      return new JsonRpcFraming();
    default:
      throw new NotImplemented(`framing \`${name}\``);
  }
}

type Reply =
  | { kind: "ok"; payload: string }
  | { kind: "err"; id: number; body: string }
  | { kind: "fault" };

function encodeReply(reply: Reply): Uint8Array {
  switch (reply.kind) {
    case "ok":
      return encodeEnvelopeOk(unhex(reply.payload));
    case "err":
      return encodeEnvelopeErr(reply.id, unhex(reply.body));
    case "fault":
      return encodeEnvelopeFault();
  }
}

function replyOf(envelope: Envelope): Reply {
  if ("ok" in envelope) return { kind: "ok", payload: hex(envelope.ok) };
  if ("err" in envelope) return { kind: "err", id: envelope.err.id, body: hex(envelope.err.body) };
  return { kind: "fault" };
}

function encode(c: Case): Uint8Array {
  const i = c.input ?? {};
  switch (c.op) {
    case "name_hash": {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigUint64(0, nameHash(i.name as string), true);
      return out;
    }
    case "handshake":
      return new HandshakeFrame({
        irHash: BigInt(i.ir_hash as string),
        wireFormat: i.wire_format as string,
        framing: i.framing as string,
        capabilities: i.capabilities as number,
      }).encode();
    case "envelope":
      return encodeReply(i as unknown as Reply);
    case "request":
      if (i.framing === FRAMING_DATAGRAM2) {
        return new Datagram2Framing().encodeRequest(
          i.protocol as number,
          call(i.call_id as number, i.method as string),
          BigInt(i.request_id as string),
          encodeValue(i.format as string, i.params as Json),
        );
      }
      if (i.one_way === true && i.framing === FRAMING_JSONRPC) {
        // Only a connection sends one-way calls, as notifications.
        return new JsonRpcConnectionFraming().encodeRequest(
          0,
          call(i.call_id as number, i.method as string),
          BigInt(i.request_id as string),
          encodeValue(i.format as string, i.params as Json),
          true,
        );
      }
      return framingOf(i.framing as string).encodeRequest(
        call(i.call_id as number, i.method as string),
        BigInt(i.request_id as string),
        encodeValue(i.format as string, i.params as Json),
      );
    case "response": {
      const id = BigInt(i.request_id as string);
      const reply = i as unknown as Reply;
      if (i.framing === FRAMING_DATAGRAM2) {
        return new Datagram2Framing().encodeReply(
          i.protocol as number,
          id,
          decodeEnvelope(encodeReply(reply))!,
        );
      }
      const f = framingOf(i.framing as string);
      switch (reply.kind) {
        case "ok":
          return f.encodeResponseOk(id, unhex(reply.payload));
        case "err":
          return f.encodeResponseErr(id, reply.id, unhex(reply.body));
        case "fault":
          return f.encodeResponseFault(id);
      }
    }
    // falls through: every reply kind returns
    case "encode":
      return encodeValue(i.format as string, i.value as Json);
    case "decode":
      throw new Error("`decode` cases are decode only");
  }
}

/** The input `bytes` decode to, or `undefined` when the runtime refuses them. */
function decode(c: Case, bytes: Uint8Array): unknown {
  const i = c.input ?? {};
  switch (c.op) {
    case "handshake": {
      const h = HandshakeFrame.decode(bytes);
      if (!h) return undefined;
      const named = (hash: bigint, name: Json | undefined) =>
        typeof name === "string" && nameHash(name) === hash
          ? name
          : `0x${hash.toString(16).padStart(16, "0")}`;
      return {
        ir_hash: h.irHash.toString(),
        wire_format: named(h.wireFormat, i.wire_format),
        framing: named(h.framing, i.framing),
        capabilities: h.capabilities,
      };
    }
    case "envelope": {
      const e = decodeEnvelope(bytes);
      return e && replyOf(e);
    }
    case "request": {
      if (i.framing === FRAMING_DATAGRAM2) {
        const frame = new Datagram2Framing().decode(bytes);
        if (frame?.kind !== "request") return undefined;
        if (c.expect === "reject") return frame;
        const r = frame.request;
        const params = encodeValue(i.format as string, i.params as Json);
        return {
          framing: i.framing,
          protocol: frame.protocol,
          call_id: "id" in r.call ? r.call.id : i.call_id,
          method: i.method,
          request_id: r.requestId.toString(),
          format: i.format,
          params: matches(c, r.params, hex(params)) ? i.params : { undecoded: hex(r.params) },
        };
      }
      // A notification is a connection's frame: read as one, it says whether
      // the frame wanted a reply.
      let r: DecodedRequest | undefined;
      let oneWay = false;
      if (i.one_way === true && i.framing === FRAMING_JSONRPC) {
        const frame = new JsonRpcConnectionFraming().decode(bytes);
        if (frame?.kind === "request") {
          r = frame.request;
          oneWay = frame.oneWay;
        }
      } else {
        r = framingOf(i.framing as string).decodeRequest(bytes);
      }
      if (!r || c.expect === "reject") return r;
      const params = encodeValue(i.format as string, i.params as Json);
      return {
        framing: i.framing,
        call_id: "id" in r.call ? r.call.id : i.call_id,
        method: "name" in r.call ? r.call.name : i.method,
        request_id: r.requestId.toString(),
        ...(oneWay ? { one_way: true } : {}),
        format: i.format,
        // Params decode as bytes; they stand for the stated value only when
        // they're its exact encoding.
        params: matches(c, r.params, hex(params)) ? i.params : { undecoded: hex(r.params) },
      };
    }
    case "response": {
      let r: { requestId: bigint; envelope: Envelope } | undefined;
      let protocol: number | undefined;
      if (i.framing === FRAMING_DATAGRAM2) {
        const frame = new Datagram2Framing().decode(bytes);
        if (frame?.kind === "reply") {
          r = frame;
          protocol = frame.protocol;
        }
      } else {
        r = framingOf(i.framing as string).decodeResponse(bytes);
      }
      if (!r) return undefined;
      const reply = replyOf(r.envelope);
      // A payload or body stands for the stated one when it matches it.
      if (reply.kind === "ok" && matches(c, unhex(reply.payload), i.payload as string)) {
        reply.payload = i.payload as string;
      }
      if (reply.kind === "err" && matches(c, unhex(reply.body), i.body as string)) {
        reply.body = i.body as string;
      }
      return {
        framing: i.framing,
        ...(protocol === undefined ? {} : { protocol }),
        request_id: r.requestId.toString(),
        ...reply,
      };
    }
    case "decode": {
      let parsed: unknown;
      if (i.format === FORMAT_PACKED) {
        try {
          parsed = new PackedCodec().decode(bytes, layoutOfType(i.type as Type));
        } catch {
          return undefined;
        }
        return { format: i.format, type: i.type, value: fromJs(i.type as Type, parsed) };
      }
      if (i.format !== FORMAT_JSON) throw new NotImplemented(`format \`${i.format as string}\``);
      try {
        parsed = new JsonCodec().decode(bytes, layoutOfType(i.type as Type));
      } catch {
        return undefined;
      }
      return { format: i.format, type: i.type, value: fromJs(i.type as Type, parsed) };
    }
    default:
      return undefined;
  }
}

function run(c: Case): Outcome {
  try {
    const bytes = unhex(c.bytes);
    if (c.expect === "reject") {
      const got = decode(c, bytes);
      return got === undefined
        ? { pass: true }
        : { fail: `accepted bytes it must reject, as ${canon(got)}` };
    }
    if (c.op !== "decode") {
      const encoded = encode(c);
      if (!matches(c, encoded, c.bytes)) {
        return { fail: `encodes to ${show(encoded)}, expected ${show(bytes)}` };
      }
      if (c.op === "name_hash" || c.op === "encode") return { pass: true };
    }
    const got = decode(c, bytes);
    if (got === undefined) return { fail: "refused bytes it must decode" };
    return canon(got) === canon(c.input)
      ? { pass: true }
      : { fail: `decodes to ${canon(got)}, expected ${canon(c.input)}` };
  } catch (e) {
    if (e instanceof NotImplemented) return { notImplemented: e.message };
    return { fail: `threw ${e instanceof Error ? e.message : String(e)}` };
  }
}

test("TypeScript runtime support is proven by the wire vectors", () => {
  const { features } = readJson<{ features: { id: string }[] }>(new URL("features.json", CORPUS));
  const support = readJson<{ runtime: string; support: Record<string, Claim> }>(SUPPORT);
  const vectorFiles = new Set(readdirSync(new URL("vectors/", CORPUS)));
  const problems: string[] = [];

  for (const id of Object.keys(support.support)) {
    if (!features.some((f) => f.id === id)) problems.push(`support claims unknown feature \`${id}\``);
  }

  const proven: Record<string, Claim & { proven_by: string[] }> = {};
  for (const { id } of [...features].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const claim = support.support[id];
    if (!claim) {
      problems.push(`\`${id}\` has no claim in conformance-support.json`);
      continue;
    }
    if (!vectorFiles.has(`${id}.json`)) {
      problems.push(`\`${id}\` has no vectors`);
      continue;
    }
    const { cases } = readJson<{ cases: Case[] }>(new URL(`vectors/${id}.json`, CORPUS));
    if (cases.length === 0) problems.push(`\`${id}\` has no cases`);

    const provenBy: string[] = [];
    for (const c of cases) {
      const outcome = run(c);
      const known = claim.failing?.includes(c.id) ?? false;
      if (claim.state === "partial") {
        if ("pass" in outcome && known) {
          problems.push(
            `${c.id}: listed as failing in \`${id}\`'s partial claim, but passes - drop it from \`failing\``,
          );
        } else if ("pass" in outcome) provenBy.push(c.id);
        else if (!known) problems.push(`${c.id}: ${"fail" in outcome ? outcome.fail : outcome.notImplemented}`);
      } else if (claim.state === "supported") {
        if ("pass" in outcome) provenBy.push(c.id);
        else if ("fail" in outcome) problems.push(`${c.id}: ${outcome.fail}`);
        else
          problems.push(
            `${c.id}: \`${id}\` is claimed supported, but ${outcome.notImplemented} isn't implemented`,
          );
      } else if (!("notImplemented" in outcome)) {
        problems.push(
          `${c.id}: \`${id}\` is claimed unsupported, but the runtime implements it - claim it`,
        );
      }
    }
    for (const failing of claim.failing ?? []) {
      if (claim.state !== "partial") {
        problems.push(`\`${id}\` lists failing cases but isn't partial`);
        break;
      }
      if (!cases.some((c) => c.id === failing)) {
        problems.push(`\`${id}\` lists \`${failing}\` as failing, but has no such case`);
      }
    }
    proven[id] = { ...claim, proven_by: provenBy };
  }

  assert.deepEqual(problems, []);

  const wanted = `${JSON.stringify({ runtime: support.runtime, support: proven }, null, 2)}\n`;
  if (process.env.CONFORMANCE_BLESS) {
    writeFileSync(REPORT, wanted);
  } else {
    let current = "";
    try {
      current = readFileSync(REPORT, "utf8");
    } catch {
      // a missing report is out of date
    }
    assert.equal(
      current,
      wanted,
      "conformance-report.json is out of date. Run: CONFORMANCE_BLESS=1 npm test",
    );
  }
});
