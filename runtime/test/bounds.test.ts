// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Bounds (core#98) beyond the vectors: the error each refusal carries, and
// the checks generated code calls.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JsonCodec,
  PackedCodec,
  RuntimeError,
  checkChar,
  checkChars,
  checkCharsExact,
  checkItems,
  countChars,
  type Layout,
  type Measure,
} from "../src/index.js";

const bound = (measure: Measure) => (e: unknown) =>
  e instanceof RuntimeError && e.is("boundExceeded") && e.measure === measure;

test("characters are Unicode scalar values, not UTF-16 units", () => {
  assert.equal(countChars("a😀é"), 3);
  checkChars("😀😀", 2);
  assert.throws(() => checkChars("😀😀😀", 2), bound("chars"));
  assert.throws(() => checkChars("abc", 2), bound("chars"));
  checkCharsExact("DE", 2);
  checkCharsExact("😀é", 2);
  assert.throws(() => checkCharsExact("DEU", 2), bound("chars"));
  assert.throws(() => checkCharsExact("D", 2), (e: unknown) => e instanceof RuntimeError && e.is("serialization"));
  checkItems(3, 3);
  assert.throws(() => checkItems(4, 3), bound("items"));
  checkChar("😀");
  for (const bad of ["", "ab", "\ud83d", 97]) assert.throws(() => checkChar(bad));
});

test("each codec refuses an over-bound value with its measure, both ways", () => {
  const node: { depth: number; of: Layout } = { depth: 2, of: "unit" };
  node.of = { struct: [["name", { chars: { max: 3 } }], ["tags", { array: "u8", max: 2 }], ["next", { option: () => node }]] };
  const ok = { name: "abc", tags: [1, 2], next: { name: "😀", tags: [] } };
  for (const codec of [new PackedCodec(), new JsonCodec()]) {
    assert.deepEqual(codec.decode(codec.encode(ok, node), node), ok);
    assert.throws(() => codec.encode({ ...ok, name: "abcd" }, node), bound("chars"));
    assert.throws(() => codec.encode({ ...ok, tags: [1, 2, 3] }, node), bound("items"));
    assert.throws(() => codec.encode({ ...ok, next: { ...ok, next: ok } }, node), bound("depth"));
    // Over the bound on the wire: written unbounded, read bounded.
    const loose: Layout = { struct: [["name", "string"], ["tags", { array: "u8" }]] };
    const wide = codec.encode({ name: "abcd", tags: [] }, loose);
    assert.throws(() => codec.decode(wide, node), bound("chars"));
  }
});
