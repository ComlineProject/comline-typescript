// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Wire formats. {@link JsonCodec} pairs with the Rust runtime's `format::Json`
 * (`name === "json@1"`); a MessagePack codec matching `format::MsgPack` is a
 * later addition.
 */

import type { Codec } from "./contract.js";
import { FORMAT_JSON } from "./handshake.js";
import { type Shape, decodeJson, parseJson, stringifyJson } from "./json.js";

/**
 * UTF-8 JSON, written as the Rust runtime's serde writes the same shape: a
 * `bigint` with all its digits, and an absent optional as `null`. Reading
 * gives `null` back as `undefined`, since the IDL has no null. Integers read
 * as `number`, except where the {@link Shape} generated code passes says a
 * `bigint` goes: those are read exactly.
 */
export class JsonCodec implements Codec {
  readonly name = FORMAT_JSON;

  encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(stringifyJson(value));
  }

  decode<T>(bytes: Uint8Array, shape?: Shape): T {
    const text = new TextDecoder().decode(bytes);
    if (shape !== undefined) return decodeJson(parseJson(text), shape) as T;
    return JSON.parse(text, (_key, v: unknown) => (v === null ? undefined : v)) as T;
  }
}
