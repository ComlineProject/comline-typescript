// `buildHello` against the specification's `comline@2` Hello cases: a Hello
// put together from a header and protocol entries is the `hello` case's bytes
// with every protocol among them, and `hello-subset`'s with one (spec 0.12).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildHello, type ProtocolEntry } from "../src/index.js";
import { unhex } from "./ops.js";

const CORPUS = new URL("../../test/conformance/vectors/", import.meta.url);

interface Message {
  protocols: { number: number; line: { major: number; minor: number; patch: number }; shape_hash: string; functions: number[] }[];
}

const varint = (n: number): number[] => (n > 0x7f ? [(n & 0x7f) | 0x80, ...varint(n >>> 7)] : [n]);

/** The case's Hello, as the header and the entries `buildHello` takes, written from its facts. */
function parts(id: string): { header: Uint8Array; entries: ProtocolEntry[]; bytes: Uint8Array } {
  const { cases } = JSON.parse(readFileSync(new URL("handshake-comline2.json", CORPUS), "utf8")) as {
    cases: { id: string; bytes: string; input: { message: Message } }[];
  };
  const found = cases.find((c) => c.id === `handshake-comline2/${id}`);
  assert.ok(found, id);
  const entries = found.input.message.protocols.map(({ number, line, shape_hash, functions }) => ({
    number,
    bytes: Uint8Array.from([
      ...varint(number),
      ...varint(line.major),
      ...varint(line.minor),
      ...varint(line.patch),
      ...unhex(shape_hash),
      ...varint(functions.length),
      ...functions.flatMap(varint),
    ]),
  }));
  const bytes = unhex(found.bytes);
  // The header is what precedes the protocol list: its count, then the entries.
  const list = entries.reduce((n, e) => n + e.bytes.length, varint(entries.length).length);
  return { header: bytes.slice(0, bytes.length - list), entries, bytes };
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

test("every protocol, however it is split between provided and called, is the whole Hello", () => {
  const { header, entries, bytes } = parts("hello");
  const [zero, one] = entries as [ProtocolEntry, ProtocolEntry];
  for (const [provided, called] of [
    [[zero, one], []],
    [[], [zero, one]],
    [[zero], [one]],
    [[one], [zero]],
    [[one, zero], [one, zero]],
    [[zero, zero], [one]],
  ] as const) {
    assert.equal(hex(buildHello(header, provided, called)), hex(bytes));
  }
});

test("a subset is the Hello that lists those protocols", () => {
  const { header, entries } = parts("hello");
  const subset = parts("hello-subset");
  assert.deepEqual([...subset.header], [...header]);
  const one = entries[1]!;
  assert.deepEqual([...subset.entries[0]!.bytes], [...one.bytes]);
  for (const [provided, called] of [[[one], []], [[], [one]], [[one], [one]]] as const) {
    assert.equal(hex(buildHello(header, provided, called)), hex(subset.bytes));
  }
});

test("the first entry given for a number is the one listed", () => {
  const { header, entries } = parts("hello");
  const [zero] = entries as [ProtocolEntry];
  const other = { number: zero.number, bytes: Uint8Array.from([0xff]) };
  assert.equal(hex(buildHello(header, [zero], [other])), hex(buildHello(header, [zero], [])));
  assert.equal(hex(buildHello(header, [other], [zero])), hex(buildHello(header, [other], [])));
});

test("a Hello that lists nothing has a zero count", () => {
  const { header } = parts("hello");
  assert.deepEqual([...buildHello(header, [], [])], [...header, 0]);
});
