// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Wire formats. {@link JsonCodec} pairs with the Rust runtime's `format::Json`
 * (`name === "json"`); a MessagePack codec matching `format::MsgPack` is a
 * later addition.
 */

import type { Codec } from "./contract.js";
import { stringifyJson } from "./json.js";

/**
 * UTF-8 JSON, written as the Rust runtime's serde writes the same shape: a
 * `bigint` with all its digits, and an absent optional as `null`. Reading
 * gives `null` back as `undefined`, since the IDL has no null. Integers read
 * back as `number`, exact below 2^53.
 */
export class JsonCodec implements Codec {
  readonly name = "json";

  encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(stringifyJson(value));
  }

  decode<T>(bytes: Uint8Array): T {
    return JSON.parse(new TextDecoder().decode(bytes), (_key, v: unknown) =>
      v === null ? undefined : v,
    ) as T;
  }
}
