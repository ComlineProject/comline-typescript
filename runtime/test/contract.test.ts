import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JsonCodec,
  Reply,
  RuntimeError,
  call,
  resolveKind,
  type Envelope,
} from "../src/index.js";

const CALLS = ["send", "history", "poke"] as const;

test("resolveKind maps an id or a name to an ordinal", () => {
  assert.equal(resolveKind({ id: 1 }, CALLS), 1);
  assert.equal(resolveKind({ id: 9 }, CALLS), undefined);
  assert.equal(resolveKind({ name: "poke" }, CALLS), 2);
  assert.equal(resolveKind({ name: "nope" }, CALLS), undefined);
});

test("call carries both addresses", () => {
  assert.deepEqual(call(0, "send"), { id: 0, name: "send" });
});

test("Reply starts as none, then records ok / err", () => {
  const r = new Reply();
  assert.equal(r.outcome.kind, "none");

  r.ok(Uint8Array.of(1, 2, 3));
  assert.deepEqual(r.outcome, { kind: "ok" });
  assert.deepEqual([...r.body], [1, 2, 3]);

  r.err(4, Uint8Array.of(9));
  assert.deepEqual(r.outcome, { kind: "err", id: 4 });
  assert.deepEqual([...r.body], [9]);
});

test("RuntimeError carries a discriminant and an optional remote id", () => {
  const e = RuntimeError.remote(7);
  assert.equal(e.kind, "remote");
  assert.equal(e.remoteId, 7);
  assert.ok(e.is("remote"));
  assert.ok(e instanceof Error);
  assert.equal(RuntimeError.timeout().remoteId, undefined);
});

test("JsonCodec round-trips a value and hashes as \"json\"", () => {
  const codec = new JsonCodec();
  assert.equal(codec.name, "json");

  const value = { body: "hi", seq: 42, tags: ["a", "b"] };
  const decoded = codec.decode<typeof value>(codec.encode(value));
  assert.deepEqual(decoded, value);

  // bigint degrades to a JS number (documented) rather than throwing
  assert.equal(codec.decode<number>(codec.encode(10n)), 10);
});

test("an Envelope is a discriminated ok / err", () => {
  const ok: Envelope = { ok: Uint8Array.of(1) };
  const err: Envelope = { err: { id: 2, body: Uint8Array.of(3) } };
  assert.ok("ok" in ok);
  assert.ok("err" in err && err.err.id === 2);
});
