// Exercises generated bounds (core#98) against the runtime. `generated/bounds.ts`
// is written by `comline-codegen-typescript`'s `generated_bounds_match_the_
// runtime_test_fixture` test; this proves it type-checks and that every
// bound it declares is checked, both ways, in both formats.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Connection, JsonCodec, PackedCodec, RuntimeError, duplex, type Measure } from "../src/index.js";
import {
  type Customer,
  type Directory,
  type Folder,
  CONNECTION_IR_HASH,
  CountryCode,
  CustomerLayout,
  DirectoryDispatcher,
  DirectorySender,
  FolderLayout,
  Name,
} from "./generated/bounds.js";

const bound = (measure: Measure) => (e: unknown) =>
  e instanceof RuntimeError && e.is("boundExceeded") && e.measure === measure;

const customer: Customer = {
  name: Name.from("Ada"),
  country: CountryCode.from("GB"),
  grade: "😀",
  tags: ["a", "é€😀"],
  scores: [1, 2, 3],
};

test("a branded alias is made by its checked factory", () => {
  assert.equal(Name.from("é".repeat(32)), "é".repeat(32));
  assert.throws(() => Name.from("x".repeat(33)), bound("chars"));
  assert.equal(CountryCode.from("😀é"), "😀é");
  assert.throws(() => CountryCode.from("GBR"), bound("chars"));
  assert.throws(() => CountryCode.from("G"), (e: unknown) => e instanceof RuntimeError && e.is("serialization"));
});

test("the generated layouts refuse an over-bound value before writing, and on reading", () => {
  for (const codec of [new PackedCodec(), new JsonCodec()]) {
    assert.deepEqual(codec.decode(codec.encode(customer, CustomerLayout), CustomerLayout), customer);
    const over: [Customer, Measure | undefined][] = [
      [{ ...customer, tags: ["a", "b", "c", "d", "e"] }, "items"],
      [{ ...customer, tags: ["x".repeat(17)] }, "chars"],
      [{ ...customer, scores: [1, 2, 3, 4] }, "items"],
      [{ ...customer, nickname: "😀".repeat(9) }, "chars"],
      [{ ...customer, name: "x".repeat(33) as Name }, "chars"],
      [{ ...customer, grade: "ab" }, undefined],
    ];
    for (const [value, measure] of over) {
      assert.throws(() => codec.encode(value, CustomerLayout), measure ? bound(measure) : RuntimeError);
    }
    const leaf: Folder = { name: "leaf", children: [] };
    const deep: Folder = { name: "root", children: [{ name: "mid", children: [leaf] }] };
    assert.deepEqual(codec.decode(codec.encode(deep, FolderLayout), FolderLayout), deep);
    const deeper: Folder = { name: "top", children: [deep] };
    assert.throws(() => codec.encode(deeper, FolderLayout), bound("depth"));
  }
});

test("a call's arguments and return are checked on each side", async () => {
  const [dialler, acceptor] = duplex();
  const codec = new PackedCodec();
  const [client, server] = await Promise.all([
    Connection.connect(dialler, codec, CONNECTION_IR_HASH),
    Connection.accept(acceptor, codec, CONNECTION_IR_HASH),
  ]);
  const directory: Directory = {
    async find(_peer, { query }) {
      return query === "many" ? [customer, customer, customer] : [customer];
    },
    async tree(_peer, { root }) {
      return root.children.length;
    },
  };
  new DirectoryDispatcher(directory).provideOn(server);
  const sender = new DirectorySender(client);
  assert.deepEqual(await sender.find({ query: "ada" }), [customer]);
  // The argument is over its bound: refused before anything is sent.
  await assert.rejects(sender.find({ query: "x".repeat(9) }), bound("chars"));
  // The return is over its bound: the provider can't encode it.
  await assert.rejects(sender.find({ query: "many" }));
  assert.equal(await sender.tree({ root: { name: "r", children: [] } }), 0);
  acceptor.close();
  await client.closed;
});
