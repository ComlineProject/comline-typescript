// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Call, DecodedRequest, DecodedResponse, Framing } from "../contract.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** JSON bytes of a value, or `null` for an empty sub-frame. */
function jsonBytes(sub: unknown): Uint8Array {
  return enc.encode(sub === undefined ? "null" : JSON.stringify(sub));
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
 * spliced in verbatim.
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
    let r: { method?: unknown; params?: unknown; id?: unknown };
    try {
      r = JSON.parse(dec.decode(frame));
    } catch {
      return undefined;
    }
    if (typeof r.method !== "string") return undefined;
    return {
      call: { name: r.method },
      requestId: r.id === undefined || r.id === null ? 0n : BigInt(r.id as number),
      params: jsonBytes(r.params),
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
    let r: { result?: unknown; error?: { code?: unknown; data?: unknown }; id?: unknown };
    try {
      r = JSON.parse(dec.decode(frame));
    } catch {
      return undefined;
    }
    const requestId = r.id === undefined || r.id === null ? 0n : BigInt(r.id as number);
    if (r.error && typeof r.error === "object") {
      // An ordinal is a `u16`, so it is always in `0..=65535`. Anything
      // outside that — JSON-RPC's reserved negatives, `-32603` among them, or
      // a code too wide to be an ordinal — is not a schema error this wire can
      // name, so it is a fault.
      const code = Number(r.error.code ?? 0);
      if (!Number.isInteger(code) || code < 0 || code > 0xffff) {
        return { requestId, envelope: { fault: true } };
      }
      return {
        requestId,
        envelope: { err: { id: code, body: jsonBytes(r.error.data) } },
      };
    }
    return { requestId, envelope: { ok: jsonBytes(r.result) } };
  }
}
