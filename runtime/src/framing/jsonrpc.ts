// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { FRAMING_JSONRPC } from "../handshake.js";
import type {
  Call,
  ConnectionFraming,
  DecodedRequest,
  DecodedResponse,
  Envelope,
  Frame,
  Framing,
} from "../contract.js";
import { type JsonNode, JsonReader } from "../json.js";

const enc = new TextEncoder();
// Strict, as serde_json is: a frame that isn't UTF-8 is refused, not repaired.
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const NULL = enc.encode("null");

/** The members a message is read by, and an error object's. */
const MESSAGE_MEMBERS = ["jsonrpc", "method", "params", "id", "result", "error"];
const ERROR_MEMBERS = ["code", "message", "data"];

/**
 * A member read only as far as checking it's one well-formed JSON value:
 * where it is in the frame, and the character it starts with. Like serde_json's
 * `RawValue`, it's handed on as written, and parsed once, by the format.
 */
type Raw = { readonly kind: "raw"; readonly start: number; readonly end: number; readonly first: string };
type Member = JsonNode | Raw;

/** A message's members, `params` and `result` as {@link Raw}. */
type Message = { readonly text: string; readonly members: ReadonlyMap<string, Member> };

/**
 * Whether any of `keys` is written more than once. serde refuses a
 * repeated member it reads, so the Rust runtime does, and this matches it.
 */
function repeats(repeated: ReadonlySet<string> | undefined, keys: readonly string[]): boolean {
  return repeated !== undefined && keys.some((key) => repeated.has(key));
}

/**
 * `frame` as a JSON-RPC 2.0 message's members: a JSON object carrying
 * `"jsonrpc": "2.0"`. `undefined` for anything else (runtime#75).
 *
 * The object is walked here, member by member: `params` and `result` are
 * only checked and sliced out, not built, and the rest are read as values.
 */
function members(frame: Uint8Array): Message | undefined {
  try {
    const text = dec.decode(frame);
    const reader = new JsonReader(text);
    const members = new Map<string, Member>();
    const seen = new Set<string>();
    reader.space();
    if (text[reader.at++] !== "{") return undefined;
    reader.space();
    if (text[reader.at] === "}") reader.at++;
    else {
      for (;;) {
        reader.space();
        const key = reader.string();
        reader.space();
        if (text[reader.at++] !== ":") return undefined;
        // serde refuses a member it reads twice.
        if (seen.has(key) && MESSAGE_MEMBERS.includes(key)) return undefined;
        seen.add(key);
        if (key === "params" || key === "result") {
          reader.space();
          const start = reader.at;
          reader.skip();
          members.set(key, { kind: "raw", start, end: reader.at, first: text[start]! });
        } else {
          members.set(key, reader.value());
        }
        reader.space();
        const next = text[reader.at++];
        if (next === "}") break;
        if (next !== ",") return undefined;
      }
    }
    reader.space();
    if (reader.at !== text.length) return undefined;
    const version = members.get("jsonrpc");
    return version?.kind === "string" && version.value === "2.0" ? { text, members } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `member` is `null` (a value read whole, or one left raw). */
function isNull(member: Member): boolean {
  return member.kind === "null" || (member.kind === "raw" && member.first === "n");
}

/** A member's JSON exactly as written, or `null` when it's absent. */
function raw(text: string, member: Member | undefined): Uint8Array {
  return member ? enc.encode(text.slice(member.start, member.end)) : NULL;
}

/**
 * A JSON integer as serde reads one into an integer type: written as an
 * integer, so not `1.0`, `1e0` or `-0`, which serde_json reads as floats
 * (comline-typescript#75). `undefined` for anything else.
 */
function integer(member: Member | undefined): bigint | undefined {
  if (member?.kind !== "number") return undefined;
  const digits = member.raw;
  // Wider than any 64-bit integer is none, and isn't worth building.
  if (digits.length > 20 || /[.eE]/.test(digits) || digits === "-0") return undefined;
  return BigInt(digits);
}

/**
 * A request up to its id. JSON-RPC 2.0 has `params` omitted when there are
 * none, not `null`, so params that are empty or `null` are left out.
 */
function requestHead(call: Call, params: Uint8Array): string {
  const p = dec.decode(params);
  const method = `{"jsonrpc":"2.0","method":${JSON.stringify(call.name)}`;
  return p === "" || p === "null" ? method : `${method},"params":${p}`;
}

/** A `u64` id, or `undefined` if `member` isn't one. */
function u64(member: Member | undefined): bigint | undefined {
  const n = integer(member);
  return n !== undefined && n >= 0n && n <= U64_MAX ? n : undefined;
}

/**
 * A JSON-RPC 2.0 error whose `id` is `null`, which is how the specification has
 * a peer answer a request it couldn't read. No other frame has a `null` id: a
 * request's is refused, and so is a `result`'s. Matches
 * `comline_runtime`'s `is_peer_refusal`.
 */
function isPeerRefusal(frame: Uint8Array): boolean {
  const r = members(frame);
  if (r?.members.get("id")?.kind !== "null") return false;
  const result = r.members.get("result");
  if (result && !isNull(result)) return false;
  const error = r.members.get("error");
  if (error?.kind !== "object" || repeats(error.repeated, ERROR_MEMBERS)) return false;
  if (error.members.get("message")?.kind !== "string") return false;
  const code = integer(error.members.get("code"));
  return code !== undefined && code >= I64_MIN && code <= I64_MAX;
}

/** A request, from its message's members. */
function request(r: Message | undefined): DecodedRequest | undefined {
  const method = r?.members.get("method");
  if (!r || method?.kind !== "string") return undefined;
  // Params are an array or an object. `null` isn't JSON-RPC 2.0's, and this
  // framing no longer writes it, but it's read as none: peers send it.
  const params = r.members.get("params");
  if (params && !(params.kind === "raw" && "[{n".includes(params.first))) return undefined;
  // A notification has no id; it's request 0. A null id is refused: it
  // still wants a reply, which a notification never gets (runtime#75).
  const id = r.members.get("id");
  const requestId = !id ? 0n : u64(id);
  if (requestId === undefined) return undefined;
  return {
    call: { name: method.value },
    requestId,
    params: raw(r.text, r.members.get("params")),
  };
}

/** A response, from its message's members. */
function response(r: Message | undefined): DecodedResponse | undefined {
  const requestId = u64(r?.members.get("id"));
  if (!r || requestId === undefined) return undefined;
  const error = r.members.get("error");
  if (error && error.kind !== "null") {
    if (error.kind !== "object" || repeats(error.repeated, ERROR_MEMBERS)) return undefined;
    // An error object has a message; a response, never both outcomes.
    if (error.members.get("message")?.kind !== "string") return undefined;
    const result = r.members.get("result");
    if (result && !isNull(result)) return undefined;
    const code = integer(error.members.get("code"));
    if (code === undefined || code < I64_MIN || code > I64_MAX) return undefined;
    // An ordinal is a u16; any other code (-32603 and the rest of
    // JSON-RPC's own) is a provider fault.
    if (code < 0n || code > 0xffffn) return { requestId, envelope: { fault: true } };
    return {
      requestId,
      envelope: { err: { id: Number(code), body: raw(r.text, error.members.get("data")) } },
    };
  }
  // A response has its outcome: `null` is one, and nothing, as in a request's
  // frame, isn't.
  const result = r.members.get("result");
  if (!result) return undefined;
  return { requestId, envelope: { ok: raw(r.text, result) } };
}

/**
 * [JSON-RPC 2.0](https://www.jsonrpc.org/specification) framing — name-oriented,
 * human-readable. Pair with {@link JsonCodec}. Matches
 * `comline_runtime::framing::JsonRpcFraming`:
 *
 * - request: `{"jsonrpc":"2.0","method":<name>,"params":<params>,"id":<n>}`,
 *   without `params` when there are none
 * - ok:      `{"jsonrpc":"2.0","result":<r>,"id":<n>}`
 * - err:     `{"jsonrpc":"2.0","error":{"code":<ordinal>,"message":...,"data":<body>},"id":<n>}`
 *
 * `params` / `payload` / `body` arrive as already-encoded JSON bytes and are
 * spliced in verbatim; decoding hands them back as written, and reads the id
 * exactly. A response must carry its id.
 */
export class JsonRpcFraming implements Framing {
  readonly name = FRAMING_JSONRPC;

  encodeRequest(call: Call, requestId: bigint, params: Uint8Array): Uint8Array {
    return enc.encode(`${requestHead(call, params)},"id":${requestId}}`);
  }

  decodeRequest(frame: Uint8Array): DecodedRequest | undefined {
    return request(members(frame));
  }

  encodeResponseOk(requestId: bigint, payload: Uint8Array): Uint8Array {
    const r = payload.length === 0 ? "null" : dec.decode(payload);
    return enc.encode(`{"jsonrpc":"2.0","result":${r},"id":${requestId}}`);
  }

  encodeResponseErr(requestId: bigint, id: number, body: Uint8Array): Uint8Array {
    const d = body.length === 0 ? "null" : dec.decode(body);
    return enc.encode(
      `{"jsonrpc":"2.0","error":{"code":${id},"message":"application error","data":${d}},"id":${requestId}}`,
    );
  }

  /**
   * JSON-RPC's own reserved `-32603 Internal error`, which is what a
   * non-Comline JSON-RPC peer already expects. An ordinal is a `u16`, so the
   * schema's error codes are all non-negative and can never collide with it.
   */
  encodeResponseFault(requestId: bigint): Uint8Array {
    return enc.encode(
      `{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal error"},"id":${requestId}}`,
    );
  }

  decodeResponse(frame: Uint8Array): DecodedResponse | undefined {
    return response(members(frame));
  }

  isPeerRefusal(frame: Uint8Array): boolean {
    return isPeerRefusal(frame);
  }
}

/**
 * JSON-RPC on a {@link Connection}, for calls in both directions. Matches
 * `comline_runtime::framing::JsonRpcFraming` as a `ConnectionFraming`: frames
 * are {@link JsonRpcFraming}'s, a message with a `method` is a request and any
 * other a reply. A request names no protocol, only its method - bare (`send`)
 * or qualified (`chat.Chat/send`), as the schema's `method_names` chose - which
 * the receiver looks up among the protocols it provides. A one-way call is a
 * notification: it has no `id`, and gets no reply.
 */
export class JsonRpcConnectionFraming implements ConnectionFraming {
  readonly name = FRAMING_JSONRPC;
  private readonly frames = new JsonRpcFraming();

  encodeRequest(
    _protocol: number,
    call: Call,
    requestId: bigint,
    params: Uint8Array,
    oneWay = false,
  ): Uint8Array {
    if (!oneWay) return this.frames.encodeRequest(call, requestId, params);
    return enc.encode(`${requestHead(call, params)}}`);
  }

  encodeReply(_protocol: number, requestId: bigint, reply: Envelope): Uint8Array {
    return "ok" in reply
      ? this.frames.encodeResponseOk(requestId, reply.ok)
      : "err" in reply
        ? this.frames.encodeResponseErr(requestId, reply.err.id, reply.err.body)
        : this.frames.encodeResponseFault(requestId);
  }

  decode(frame: Uint8Array): Frame | undefined {
    const r = members(frame);
    if (!r) return undefined;
    if (r.members.has("method")) {
      const decoded = request(r);
      if (!decoded) return undefined;
      const id = r.members.get("id");
      return { kind: "request", protocol: undefined, request: decoded, oneWay: !id };
    }
    const decoded = response(r);
    return decoded && { kind: "reply", protocol: undefined, ...decoded };
  }

  isPeerRefusal(frame: Uint8Array): boolean {
    return isPeerRefusal(frame);
  }
}
