import assert from "node:assert/strict";
import { test } from "node:test";

import { JsonCodec, PackedCodec, RuntimeError, type Layout } from "../src/index.js";

const codec = new PackedCodec();

const Class: Layout = { enum: ["Warrior", "Mage"] };
const Player: Layout = {
  struct: [
    ["id", "u32"],
    ["hp", "u16"],
    ["name", "string"],
    ["guild", { option: "string" }],
    ["class", Class],
    ["pos", { fixed: "f32", length: 2 }],
  ],
};

test("the proposal's example is nineteen bytes, and reads back", () => {
  const player = { id: 7, hp: 100, name: "ab", class: "Mage", pos: [1, 2] };
  const bytes = codec.encode(player, Player);
  assert.deepEqual(
    [...bytes],
    [7, 0, 0, 0, 100, 0, 2, 0x61, 0x62, 0, 1, 0, 0, 0x80, 0x3f, 0, 0, 0, 0x40],
  );
  assert.deepEqual(codec.decode(bytes, Player), player);
});

test("64-bit integers are bigints, at their edges", () => {
  const layout: Layout = { struct: [["u", "u64"], ["s", "s64"]] };
  const value = { u: (1n << 64n) - 1n, s: -(1n << 63n) };
  assert.deepEqual(codec.decode(codec.encode(value, layout), layout), value);
});

test("a value its layout can't hold is refused, not wrapped", () => {
  const refused = (value: unknown, layout: Layout) =>
    assert.throws(() => codec.encode(value, layout), RuntimeError);
  refused(256, "u8");
  refused(-1, "u32");
  refused(1.5, "s16");
  refused(1n << 64n, "u64");
  refused(1, "u64");
  refused("Bard", Class);
  refused([1], { fixed: "u8", length: 2 });
  refused("yes", "bool");
});

test("layouts can refer to each other lazily, and recursively", () => {
  const Tree: Layout = { struct: [["value", "u8"], ["children", { array: () => Tree }]] };
  const tree = { value: 1, children: [{ value: 2, children: [] }] };
  const bytes = codec.encode(tree, Tree);
  assert.deepEqual([...bytes], [1, 1, 2, 0]);
  assert.deepEqual(codec.decode(bytes, Tree), tree);
});

test("a long string's length takes two varint bytes", () => {
  const long = "x".repeat(300);
  const bytes = codec.encode(long, "string");
  assert.deepEqual([...bytes.subarray(0, 2)], [0xac, 0x02]);
  assert.equal(codec.decode(bytes, "string"), long);
});

test("without a layout, packed@1 can't encode or decode", () => {
  assert.throws(() => codec.encode(1), TypeError);
  assert.throws(() => codec.decode(new Uint8Array([1])), TypeError);
});

test("the JSON codec reads bigints where a layout says so", () => {
  const layout: Layout = { struct: [["big", "u64"], ["small", "u32"], ["xs", { array: "s64" }]] };
  const json = new TextEncoder().encode(`{"big":9007199254740993,"small":1,"xs":[-1]}`);
  assert.deepEqual(new JsonCodec().decode(json, layout), { big: 9007199254740993n, small: 1, xs: [-1n] });
});
