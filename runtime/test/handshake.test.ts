import assert from "node:assert/strict";
import { test } from "node:test";

import { FRAMING_DATAGRAM, Handshake, nameHash, RuntimeError } from "../src/index.js";

const sample = () =>
  new Handshake({
    irHash: 0xdeadbeef01020304n,
    wireFormat: "msgpack",
    framing: FRAMING_DATAGRAM,
    capabilities: 0b101,
  });

test("nameHash is deterministic and name-specific", () => {
  assert.equal(nameHash("msgpack"), nameHash("msgpack"));
  assert.notEqual(nameHash("msgpack"), nameHash("json"));
  assert.notEqual(nameHash("msgpack"), nameHash("com.acme.msgpack"));
});

test("nameHash matches the Rust FNV-1a reference vectors", () => {
  // Cross-checked against `comline_runtime::contract::name_hash`.
  assert.equal(nameHash(""), 0xcbf29ce484222325n);
  assert.equal(nameHash("json"), 0x20bc6ede170e3803n);
  assert.equal(nameHash("msgpack"), 0xc77cac73dc6306abn);
  assert.equal(nameHash(FRAMING_DATAGRAM), 0x061d8c9e6a1421b9n);
  assert.equal(nameHash("jsonrpc-2.0"), 0x25f94d83bdb63677n);
});

test("the frame is 31 bytes and round-trips", () => {
  const frame = sample().encode();
  assert.equal(frame.length, 31);

  const back = Handshake.decode(frame);
  assert.ok(back);
  assert.equal(back.irHash, sample().irHash);
  assert.equal(back.wireFormat, sample().wireFormat);
  assert.equal(back.framing, sample().framing);
  assert.equal(back.capabilities, 0b101);
});

test("decode rejects a truncated or foreign frame", () => {
  assert.equal(Handshake.decode(new Uint8Array(0)), undefined);
  assert.equal(Handshake.decode(new Uint8Array(31)), undefined); // bad magic
  assert.equal(Handshake.decode(sample().encode().subarray(0, 30)), undefined);
});

test("check agrees, ignores capability bits, and rejects real mismatches", () => {
  assert.doesNotThrow(() => sample().check(sample()));

  const capsDiffer = new Handshake({
    irHash: 0xdeadbeef01020304n,
    wireFormat: "msgpack",
    framing: FRAMING_DATAGRAM,
    capabilities: 0,
  });
  assert.doesNotThrow(() => sample().check(capsDiffer), "capability bits may differ");

  const fmtDiffer = new Handshake({
    irHash: 0xdeadbeef01020304n,
    wireFormat: "json",
    framing: FRAMING_DATAGRAM,
  });
  assert.throws(() => sample().check(fmtDiffer), (e: unknown) => e instanceof RuntimeError && e.is("handshake"));

  const schemaDiffer = new Handshake({
    irHash: 0n,
    wireFormat: "msgpack",
    framing: FRAMING_DATAGRAM,
  });
  assert.throws(() => sample().check(schemaDiffer), RuntimeError);
});
