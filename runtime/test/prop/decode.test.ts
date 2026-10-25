// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Decode agreement: on a value's valid encoding, on it mutated (bytes
 * flipped, cut, appended), on random bytes, and on it with one targeted
 * fault (overlong varints, tags of 2, counts past the end, unknown
 * variants, invalid UTF-8, out-of-range integers, missing fields...), this
 * runtime decoding with the type's layout and `comline-reference` decoding
 * as the type both accept, to the same value, or both refuse.
 */

import { test } from "node:test";

import fc from "fast-check";

import { FORMAT_JSON, FORMAT_PACKED, JsonCodec, PackedCodec } from "../../src/index.js";
import { hex } from "../ops.js";
import { stringify } from "../reference.js";
import { fromJs, layoutOfType, sameValue, toJs, type Json } from "../values.js";
import { inputArb, inputBytes, typedArb } from "./gen.js";
import { known, params, withReference } from "./harness.js";

withReference("decode: TypeScript accepts and refuses what the reference does", (reference) => {
  test("packed@1 and json@1 decoding agree with the reference", async () => {
    await fc.assert(
      fc.asyncProperty(
        typedArb,
        fc.constantFrom(FORMAT_PACKED, FORMAT_JSON),
        inputArb,
        async (typed, format, input) => {
          const { type, value } = typed;
          const layout = layoutOfType(type);
          const codec = format === FORMAT_PACKED ? new PackedCodec() : new JsonCodec();
          const bytes = inputBytes(input, format, typed, codec.encode(toJs(value), layout));
          const answer = await reference().one({ op: "decode", input: { format, type }, bytes: hex(bytes) });
          if (answer.kind !== "accept" && answer.kind !== "reject") {
            throw new Error(`the reference neither accepted nor refused: ${JSON.stringify(answer)}`);
          }

          let decoded: Json | undefined;
          let refusal = "";
          try {
            decoded = fromJs(type, codec.decode(bytes, layout));
          } catch (e) {
            refusal = e instanceof Error ? e.message : String(e);
          }
          const wanted = answer.kind === "accept" ? (answer.input.value as Json) : undefined;
          if (decoded === undefined && wanted === undefined) return;
          if (decoded !== undefined && wanted !== undefined && sameValue(decoded, wanted)) return;

          const verdict = known({
            property: "decode",
            format,
            type,
            value,
            bytes,
            ts: decoded === undefined ? `refused (${refusal})` : `accepted, as ${stringify(decoded)}`,
            reference: wanted === undefined ? "refused" : `accepted, as ${stringify(wanted)}`,
            tsAccepted: decoded !== undefined,
            referenceAccepted: wanted !== undefined,
          });
          if (verdict !== true) throw new Error(verdict);
        },
      ),
      params(),
    );
  });
});
