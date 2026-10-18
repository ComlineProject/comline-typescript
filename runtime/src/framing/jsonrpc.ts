// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Call, DecodedRequest, DecodedResponse, Framing } from "../contract.js";
import { type JsonNode, jsonInteger, parseJson } from "../json.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const NULL = enc.encode("null");

/** `frame` as a JSON object's members, or `undefined` if it isn't one. */
function members(frame: Uint8Array): { text: string; members: ReadonlyMap<string, JsonNode> } | undefined {
  try {
    const text = dec.decode(frame);
    const root = parseJson(text);
    return root.kind === "object" ? { text, members: root.members } : undefined;
  } catch {
    return undefined;
  }
}

/** A member's JSON exactly as written, or `null` when it's absent. */
function raw(text: string, node: JsonNode | undefined): Uint8Array {
  return node ? enc.encode(text.slice(node.start, node.end)) : NULL;
}

/** A `u64` id, or `undefined` if `node` isn't one. */
function u64(node: JsonNode | undefined): bigint | undefined {
  const n = jsonInteger(node);
  return n !== undefined && n >= 0n && n <= U64_MAX ? n : undefined;
}

/**
 * [JSON-RPC 2.0](https://www.jsonrpc.org/specification) framing — name-oriented,
 * human-readable. Pair with {@link JsonCodec}. Matches
 * `comline_runtime::framing::JsonRpcFraming`:
 *
 * - request: `{"jsonrpc":"2.0","method":<name>,"params":<params>,"id":<n>}`
 * - ok:      `{"jsonrpc":"2.0","result":<r>,"id":<n>}`
 * - err:     `{"jsonrpc":"2.0","error":{"code":<ordinal>,"message":...,"data":<body>},"id":<n>}`
 *
 * `params` / `payload` / `body` arrive as already-encoded JSON bytes and are
 * spliced in verbatim; decoding hands them back as written, and reads the id
 * exactly. A response must carry its id.
 */
export class JsonRpcFraming implements Framing {
  readonly name = "jsonrpc-2.0";

  encodeRequest(call: Call, requestId: bigint, params: Uint8Array): Uint8Array {
    const p = params.length === 0 ? "null" : dec.decode(params);
    return enc.encode(
      `{"jsonrpc":"2.0","method":${JSON.stringify(call.name)},"params":${p},"id":${requestId}}`,
    );
  }

  decodeRequest(frame: Uint8Array): DecodedRequest | undefined {
    const r = members(frame);
    const method = r?.members.get("method");
    if (!r || method?.kind !== "string") return undefined;
    // A notification has no id (or a null one); it's request 0.
    const id = r.members.get("id");
    const requestId = !id || id.kind === "null" ? 0n : u64(id);
    if (requestId === undefined) return undefined;
    return {
      call: { name: method.value },
      requestId,
      params: raw(r.text, r.members.get("params")),
    };
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
    const r = members(frame);
    const requestId = u64(r?.members.get("id"));
    if (!r || requestId === undefined) return undefined;
    const error = r.members.get("error");
    if (error && error.kind !== "null") {
      if (error.kind !== "object") return undefined;
      const code = jsonInteger(error.members.get("code"));
      if (code === undefined || code < I64_MIN || code > I64_MAX) return undefined;
      // An ordinal is a u16; any other code (-32603 and the rest of
      // JSON-RPC's own) is a provider fault.
      if (code < 0n || code > 0xffffn) return { requestId, envelope: { fault: true } };
      return {
        requestId,
        envelope: { err: { id: Number(code), body: raw(r.text, error.members.get("data")) } },
      };
    }
    return { requestId, envelope: { ok: raw(r.text, r.members.get("result")) } };
  }
}
