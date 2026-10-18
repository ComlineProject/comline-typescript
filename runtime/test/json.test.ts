// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";

import { JsonCodec } from "../src/index.js";
import {
  type Shape,
  canonicalNumber,
  decodeJson,
  jsonEqual,
  jsonInteger,
  parseJson,
  stringifyJson,
} from "../src/json.js";

test("parseJson keeps each number's digits and each value's span", () => {
  const text = ' {"id": 9007199254740993, "params": [1.0, "x"]} ';
  const root = parseJson(text);
  assert.equal(root.kind, "object");
  if (root.kind !== "object") return;
  const id = root.members.get("id");
  assert.equal(id?.kind === "number" && id.raw, "9007199254740993");
  const params = root.members.get("params")!;
  assert.equal(text.slice(params.start, params.end), '[1.0, "x"]');
});

test("parseJson refuses what JSON.parse refuses", () => {
  for (const bad of ["", "{", '{"a":1,}', "[1 2]", "01", "1.", '"\u0001"', "nul", "1 2"]) {
    assert.throws(() => parseJson(bad), SyntaxError, bad);
    assert.throws(() => JSON.parse(bad), SyntaxError, bad);
  }
});

test("numbers compare as exact decimals", () => {
  assert.equal(canonicalNumber("1"), canonicalNumber("1.0"));
  assert.equal(canonicalNumber("10e-1"), canonicalNumber("1"));
  assert.equal(canonicalNumber("0"), canonicalNumber("-0.0"));
  assert.notEqual(canonicalNumber("9007199254740992"), canonicalNumber("9007199254740993"));
  assert.ok(jsonEqual(parseJson('{"a":1,"b":[2.50]}'), parseJson('{ "b": [2.5], "a": 1.0 }')));
  assert.ok(!jsonEqual(parseJson('{"a":1}'), parseJson('{"a":1,"b":null}')));
});

test("jsonInteger reads integers exactly, and only integers", () => {
  assert.equal(jsonInteger(parseJson("18446744073709551615")), 18446744073709551615n);
  assert.equal(jsonInteger(parseJson("-9223372036854775808")), -9223372036854775808n);
  assert.equal(jsonInteger(parseJson("2e3")), 2000n);
  assert.equal(jsonInteger(parseJson("1.5")), undefined);
  assert.equal(jsonInteger(parseJson("1e999999999")), undefined);
  assert.equal(jsonInteger(parseJson('"1"')), undefined);
});

test("stringifyJson writes bigint exactly and absent values as null", () => {
  assert.equal(stringifyJson(18446744073709551615n), "18446744073709551615");
  assert.equal(stringifyJson(undefined), "null");
  assert.equal(stringifyJson({ id: 1, label: undefined }), '{"id":1,"label":null}');
  assert.equal(stringifyJson([undefined, "a\n"]), '[null,"a\\n"]');
});

test("JsonCodec reads null back as an absent value", () => {
  const codec = new JsonCodec();
  const back = codec.decode<{ id: number; label?: string }>(codec.encode({ id: 1, label: undefined }));
  assert.deepEqual(back, { id: 1 });
  assert.equal(codec.decode(codec.encode(undefined)), undefined);
});

test("a Shape reads its bigints exactly, and the rest as JSON.parse would", () => {
  const point: Shape = { fields: { id: "bigint" } };
  const tree: Shape = { fields: { id: "bigint", children: { array: () => tree } } };
  const read = (text: string, shape: Shape) => decodeJson(parseJson(text), shape);

  assert.deepEqual(read('{"id":9007199254740993,"x":1.5,"label":null}', point), {
    id: 9007199254740993n,
    x: 1.5,
  });
  assert.deepEqual(read('{"id":1,"children":[{"id":2,"children":[]}]}', tree), {
    id: 1n,
    children: [{ id: 2n, children: [] }],
  });
  assert.deepEqual(read("[18446744073709551615]", { array: "bigint" }), [18446744073709551615n]);
  assert.throws(() => read("1.5", "bigint"), SyntaxError);
});

test("a union member is chosen by the JSON value's kind", () => {
  const value: Shape = { union: ["string", "bigint", { fields: { n: "bigint" } }] };
  const read = (text: string) => decodeJson(parseJson(text), value);
  assert.equal(read('"7"'), "7");
  assert.equal(read("7"), 7n);
  assert.deepEqual(read('{"n":7}'), { n: 7n });
});

test("JsonCodec decodes with a shape, and round-trips a bigint", () => {
  const codec = new JsonCodec();
  const shape: Shape = { fields: { seq: "bigint" } };
  const value = { seq: 18446744073709551615n, body: "x" };
  assert.deepEqual(codec.decode(codec.encode(value), shape), value);
});
