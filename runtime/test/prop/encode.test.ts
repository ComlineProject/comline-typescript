// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Encode equality: a random value of a random type, written by this
 * runtime's `PackedCodec` and `JsonCodec` with the layout generated code
 * would declare, is what `comline-reference` writes. JSON compares as JSON
 * (`jsonEqual`), packed byte for byte.
 */

import { test } from "node:test";

import fc from "fast-check";

import { FORMAT_JSON, FORMAT_PACKED, JsonCodec, PackedCodec } from "../../src/index.js";
import { jsonEqual, parseJson } from "../../src/json.js";
import { hex, unhex } from "../ops.js";
import { layoutOfType, toJs } from "../values.js";
import { typedArb } from "./gen.js";
import { known, params, withReference, type Divergence } from "./harness.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function sameJson(a: Uint8Array, b: Uint8Array): boolean {
  try {
    return jsonEqual(parseJson(utf8.decode(a)), parseJson(utf8.decode(b)));
  } catch {
    return false;
  }
}

withReference("encode: TypeScript writes what the reference writes", (reference) => {
  test("packed@1 and json@1 encodings equal the reference's", async () => {
    await fc.assert(
      fc.asyncProperty(typedArb, async ({ type, value }) => {
        const [check, ...wanted] = await reference().ask([
          { op: "check", input: { type, value } },
          { op: "encode", input: { format: FORMAT_PACKED, value } },
          { op: "encode", input: { format: FORMAT_JSON, value } },
        ]);
        if (check?.kind !== "check" || !check.ok) {
          throw new Error(`the generator made a value that isn't of its type: ${JSON.stringify(check)}`);
        }
        const layout = layoutOfType(type);
        const failures: string[] = [];
        for (const [i, format] of [FORMAT_PACKED, FORMAT_JSON].entries()) {
          const answer = wanted[i]!;
          if (answer.kind !== "bytes") throw new Error(`no bytes from the reference: ${JSON.stringify(answer)}`);
          const referenceBytes = unhex(answer.bytes);
          let tsBytes: Uint8Array | undefined;
          let threw: string | undefined;
          try {
            const codec = format === FORMAT_PACKED ? new PackedCodec() : new JsonCodec();
            tsBytes = codec.encode(toJs(value), layout);
          } catch (e) {
            threw = e instanceof Error ? e.message : String(e);
          }
          const same =
            tsBytes !== undefined &&
            (format === FORMAT_PACKED ? hex(tsBytes) === answer.bytes : sameJson(tsBytes, referenceBytes));
          if (same) continue;
          const d: Divergence = {
            property: "encode",
            format,
            type,
            value,
            ts: tsBytes ? `wrote ${hex(tsBytes)}` : `threw ${threw}`,
            reference: `wrote ${answer.bytes}`,
            ...(tsBytes ? { tsBytes } : {}),
            referenceBytes,
          };
          const verdict = known(d);
          if (verdict !== true) failures.push(verdict);
        }
        if (failures.length > 0) throw new Error(failures.join("\n"));
      }),
      params(),
    );
  });
});
