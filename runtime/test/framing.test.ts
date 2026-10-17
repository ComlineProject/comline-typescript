import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DatagramFraming,
  JsonRpcFraming,
  call,
  decodeEnvelope,
  encodeEnvelopeErr,
  encodeEnvelopeFault,
  encodeEnvelopeOk,
} from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("Envelope tag-byte form round-trips", () => {
  const ok = encodeEnvelopeOk(enc.encode("payload"));
  assert.equal(ok[0], 0);
  assert.deepEqual(decodeEnvelope(ok), { ok: enc.encode("payload") });

  const err = encodeEnvelopeErr(0x0102, enc.encode("fields"));
  assert.equal(err[0], 1);
  const back = decodeEnvelope(err);
  assert.ok(back && "err" in back);
  assert.equal(back.err.id, 0x0102);
  assert.equal(dec.decode(back.err.body), "fields");

  const fault = encodeEnvelopeFault();
  assert.deepEqual(fault, Uint8Array.of(2));
  assert.deepEqual(decodeEnvelope(fault), { fault: true });

  assert.equal(decodeEnvelope(Uint8Array.of(9)), undefined); // unknown tag
});

test("datagram response round-trips a fault", () => {
  const f = new DatagramFraming();
  const frame = f.encodeResponseFault(7n);
  assert.deepEqual(f.decodeResponse(frame), { requestId: 7n, envelope: { fault: true } });
});

/// JSON-RPC's own reserved code, not a Comline-shaped frame a peer must learn.
/// An ordinal is a `u16`, so schema codes are non-negative and cannot collide.
test("JSON-RPC sends a fault as the standard -32603 internal error", () => {
  const f = new JsonRpcFraming();
  const frame = f.encodeResponseFault(9n);
  assert.equal(
    dec.decode(frame),
    '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal error"},"id":9}',
  );
  assert.deepEqual(f.decodeResponse(frame), { requestId: 9n, envelope: { fault: true } });
});

test("a JSON-RPC code that cannot be an ordinal decodes as a fault", () => {
  const f = new JsonRpcFraming();
  for (const body of [
    '{"jsonrpc":"2.0","error":{"code":-32700},"id":1}',
    '{"jsonrpc":"2.0","error":{"code":70000},"id":1}',
  ]) {
    assert.deepEqual(f.decodeResponse(enc.encode(body)), {
      requestId: 1n,
      envelope: { fault: true },
    });
  }
});

test("datagram request: header layout matches the Rust framing", () => {
  const f = new DatagramFraming();
  const frame = f.encodeRequest(call(3, "send"), 42n, enc.encode("args"));

  // [call_id:u16 LE][request_id:u64 LE][params]
  assert.deepEqual([...frame.subarray(0, 2)], [3, 0]);
  assert.deepEqual([...frame.subarray(2, 10)], [42, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(dec.decode(frame.subarray(10)), "args");

  const req = f.decodeRequest(frame);
  assert.deepEqual(req?.call, { id: 3 });
  assert.equal(req?.requestId, 42n);
  assert.equal(dec.decode(req!.params), "args");
  assert.equal(f.decodeRequest(Uint8Array.of(0, 0, 0)), undefined);
});

test("datagram response round-trips ok and err with the ordinal", () => {
  const f = new DatagramFraming();

  const ok = f.encodeResponseOk(7n, enc.encode("payload"));
  assert.deepEqual(f.decodeResponse(ok), {
    requestId: 7n,
    envelope: { ok: enc.encode("payload") },
  });

  const err = f.encodeResponseErr(7n, 2, enc.encode("fields"));
  const back = f.decodeResponse(err);
  assert.equal(back?.requestId, 7n);
  assert.ok(back && "err" in back.envelope);
  assert.equal(back.envelope.err.id, 2);
});

test("JSON-RPC request matches the spec wording byte-for-byte", () => {
  const f = new JsonRpcFraming();
  const frame = f.encodeRequest(call(0, "greet"), 1n, enc.encode(JSON.stringify([7, "x"])));
  assert.equal(
    dec.decode(frame),
    '{"jsonrpc":"2.0","method":"greet","params":[7,"x"],"id":1}',
  );

  const req = f.decodeRequest(frame);
  assert.deepEqual(req?.call, { name: "greet" });
  assert.equal(req?.requestId, 1n);
  assert.equal(dec.decode(req!.params), '[7,"x"]');
});

test("JSON-RPC ok / err responses carry result / code+data", () => {
  const f = new JsonRpcFraming();

  const ok = f.encodeResponseOk(9n, enc.encode('{"body":"hi"}'));
  assert.equal(dec.decode(ok), '{"jsonrpc":"2.0","result":{"body":"hi"},"id":9}');
  assert.deepEqual(f.decodeResponse(ok), {
    requestId: 9n,
    envelope: { ok: enc.encode('{"body":"hi"}') },
  });

  const err = f.encodeResponseErr(9n, 3, enc.encode('{"why":"no"}'));
  const back = f.decodeResponse(err);
  assert.equal(back?.requestId, 9n);
  assert.ok(back && "err" in back.envelope);
  assert.equal(back.envelope.err.id, 3);
  assert.equal(dec.decode(back.envelope.err.body), '{"why":"no"}');
});
