// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Wire formats. {@link JsonCodec} pairs with the Rust runtime's `format::Json`
 * (`name === "json@1"`), and `PackedCodec` (`./packed.ts`) with
 * `format::Packed` (`"packed@1"`); a MessagePack codec matching
 * `format::MsgPack` is a later addition.
 */

import type { Codec } from "./contract.js";
import { FORMAT_JSON } from "./handshake.js";
import { type Shape, decodeJson, parseJson, stringifyJson } from "./json.js";
import { type Layout, checkBounds, jsonShape } from "./packed.js";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * UTF-8 JSON, written as the Rust runtime's serde writes the same shape: a
 * `bigint` with all its digits, and an absent optional as `null`. Reading
 * gives `null` back as `undefined`, since the IDL has no null. Integers read
 * as `number`, except where the {@link Shape} generated code passes says a
 * `bigint` goes: those are read exactly. A {@link Layout} says the same.
 */
export class JsonCodec implements Codec {
  readonly name = FORMAT_JSON;

  /**
   * With a {@link Layout}, its bounds (core#98) are checked first: a value
   * over one is refused before anything is written.
   */
  encode(value: unknown, layout?: Layout): Uint8Array {
    if (layout !== undefined) checkBounds(layout, value);
    return new TextEncoder().encode(stringifyJson(value));
  }

  decode<T>(bytes: Uint8Array, shape?: Shape | Layout): T {
    // Strict, as serde_json is: invalid UTF-8 is refused, not replaced, and
    // a byte-order mark is a character, not something to skip.
    const text = strictUtf8.decode(bytes);
    if (shape !== undefined) {
      // JSON has no count or length ahead of a value, so bounds are checked
      // once it's parsed; the frame limit caps what parsing allocates.
      const value = decodeJson(parseJson(text), jsonShape(shape));
      checkBounds(shape, value);
      return value as T;
    }
    return JSON.parse(text, (_key, v: unknown) => (v === null ? undefined : v)) as T;
  }
}
