// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The corpus's ops run through this runtime: what it encodes a case's input
 * to, and what it decodes bytes to, in the case's own form. The vector
 * runner (`conformance.test.ts`) checks them against the vectors, and the
 * frame properties (`prop/frames.test.ts`) against `comline-reference`.
 */

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

export interface Case {
  id: string;
  op:
    | "name_hash"
    | "handshake"
    | "envelope"
    | "request"
    | "response"
    | "encode"
    | "decode"
    | "stream_prefix"
    | "stream_split";
  input?: { [key: string]: Json };
  bytes: string;
  expect?: "reject";
  compare?: "json";
}

export class NotImplemented extends Error {}

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const unhex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

/** Bytes for a message: text when they're printable UTF-8, else hex. */
export function show(bytes: Uint8Array): string {
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
export function matches(c: Case, got: Uint8Array, wanted: string): boolean {
  if (hex(got) === wanted) return true;
  if (c.compare !== "json") return false;
  try {
    return jsonEqual(parseJson(text.decode(got)), parseJson(text.decode(unhex(wanted))));
  } catch {
    return false;
  }
}

/** Order-insensitive equality of decoded and stated inputs. */
export function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

export function encodeValue(format: string, value: Json): Uint8Array {
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

export function encode(c: Case): Uint8Array {
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
    case "stream_prefix":
    case "stream_split":
      throw new NotImplemented("stream framing");
  }
}

/** The input `bytes` decode to, or `undefined` when the runtime refuses them. */
export function decode(c: Case, bytes: Uint8Array): unknown {
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
    case "stream_prefix":
    case "stream_split":
      throw new NotImplemented("stream framing");
    default:
      // An op this harness doesn't know isn't a refusal: returning
      // `undefined` would pass every `reject` case of it unchecked.
      throw new NotImplemented(`op \`${(c as { op: string }).op}\``);
  }
}

