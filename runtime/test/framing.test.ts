import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DatagramFraming,
  JsonRpcConnectionFraming,
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
    '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":1}',
    '{"jsonrpc":"2.0","error":{"code":70000,"message":"x"},"id":1}',
  ]) {
    assert.deepEqual(f.decodeResponse(enc.encode(body)), {
      requestId: 1n,
      envelope: { fault: true },
    });
  }
});

test("frames that aren't JSON-RPC 2.0 are refused (runtime#75)", () => {
  const f = new JsonRpcFraming();
  const conn = new JsonRpcConnectionFraming();
  for (const body of [
    '{"jsonrpc":"1.0","method":"greet","params":[],"id":1}',
    '{"method":"greet","params":[],"id":1}',
    '{"jsonrpc":"2.0","method":"greet","params":"x","id":1}',
    '{"jsonrpc":"2.0","method":"greet","params":7,"id":1}',
    '{"jsonrpc":"2.0","method":"greet","params":[],"id":null}',
  ]) {
    assert.equal(f.decodeRequest(enc.encode(body)), undefined, body);
    assert.equal(conn.decode(enc.encode(body)), undefined, body);
  }
  for (const body of [
    '{"jsonrpc":"2.0","result":1,"error":{"code":1,"message":"x"},"id":1}',
    '{"jsonrpc":"2.0","error":{"code":1},"id":1}',
    '{"jsonrpc":"2.0","error":{"code":1,"message":7},"id":1}',
    '{"result":1,"id":1}',
  ]) {
    assert.equal(f.decodeResponse(enc.encode(body)), undefined, body);
    assert.equal(conn.decode(enc.encode(body)), undefined, body);
  }
  assert.ok(f.decodeRequest(enc.encode('{"jsonrpc":"2.0","method":"greet","params":{"a":1},"id":1}')));
  assert.ok(f.decodeRequest(enc.encode('{"jsonrpc":"2.0","method":"greet","id":1}')));
});

test("jsonrpc ids and error codes are integers as written, as serde reads them (#75)", () => {
  const f = new JsonRpcFraming();
  for (const id of ["1.0", "1e0", "-0", "10e-1", "18446744073709551616", "-1"]) {
    const request = `{"jsonrpc":"2.0","method":"greet","params":[],"id":${id}}`;
    assert.equal(f.decodeRequest(enc.encode(request)), undefined, request);
    const response = `{"jsonrpc":"2.0","result":1,"id":${id}}`;
    assert.equal(f.decodeResponse(enc.encode(response)), undefined, response);
  }
  for (const code of ["1.0", "1e0", "-0"]) {
    const body = `{"jsonrpc":"2.0","error":{"code":${code},"message":"x"},"id":1}`;
    assert.equal(f.decodeResponse(enc.encode(body)), undefined, body);
    assert.equal(f.isPeerRefusal(enc.encode(body.replace('"id":1', '"id":null'))), false, body);
  }
  const max = f.decodeResponse(enc.encode('{"jsonrpc":"2.0","result":1,"id":18446744073709551615}'));
  assert.equal(max?.requestId, (1n << 64n) - 1n);
  assert.deepEqual(f.decodeResponse(enc.encode('{"jsonrpc":"2.0","error":{"code":0,"message":"x"},"id":0}')), {
    requestId: 0n,
    envelope: { err: { id: 0, body: enc.encode("null") } },
  });
});

test("jsonrpc result is checked as JSON and handed on as written", () => {
  const f = new JsonRpcFraming();
  const ok = (result: string) =>
    f.decodeResponse(enc.encode(`{"jsonrpc":"2.0","result":${result},"id":1}`));
  for (const result of [
    '{ "a" : [1, -2.5e3, true, false, null, {}, []], "a": "\\u00e9\\ud83d\\ude00\\n" }',
    '"plain"',
    "0",
    "null",
    "[ ]",
  ]) {
    const decoded = ok(result);
    assert.ok(decoded && "ok" in decoded.envelope, result);
    assert.equal(dec.decode(decoded.envelope.ok), result);
  }
  for (const result of [
    "[1,]",
    '{"a"}',
    '{"a":1,}',
    "01",
    "nul",
    '"\\ud800"',
    '"\\udc00"',
    '"\\ud800\\u0041"',
    '"\\x"',
    '"\\u12"',
    '"a\u0001"',
    '"open',
    "[",
  ]) {
    assert.equal(ok(result), undefined, result);
  }
  // `null` beside an error is no result, and anything else is one too many.
  assert.ok(f.decodeResponse(enc.encode('{"jsonrpc":"2.0","result":null,"error":{"code":1,"message":"x"},"id":1}')));
  assert.equal(
    f.decodeResponse(enc.encode('{"jsonrpc":"2.0","result":[],"error":{"code":1,"message":"x"},"id":1}')),
    undefined,
  );
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

test("JSON-RPC leaves params out when there are none, and still reads null as none", () => {
  const f = new JsonRpcFraming();
  const conn = new JsonRpcConnectionFraming();
  const ping = call(0, "ping");
  for (const none of ["", "null"]) {
    const params = enc.encode(none);
    assert.equal(dec.decode(f.encodeRequest(ping, 8n, params)), `{"jsonrpc":"2.0","method":"ping","id":8}`);
    assert.equal(dec.decode(conn.encodeRequest(0, ping, 8n, params)), `{"jsonrpc":"2.0","method":"ping","id":8}`);
    assert.equal(dec.decode(conn.encodeRequest(0, ping, 8n, params, true)), `{"jsonrpc":"2.0","method":"ping"}`);
  }
  // Params that say something are kept, empty ones too.
  for (const some of ["[]", "{}", "[null]"]) {
    assert.equal(
      dec.decode(f.encodeRequest(ping, 8n, enc.encode(some))),
      `{"jsonrpc":"2.0","method":"ping","params":${some},"id":8}`,
    );
  }
  for (const frame of [
    `{"jsonrpc":"2.0","method":"ping","id":8}`,
    `{"jsonrpc":"2.0","method":"ping","params":null,"id":8}`,
  ]) {
    const req = f.decodeRequest(enc.encode(frame));
    assert.equal(req && dec.decode(req.params), "null");
  }
});

test("JSON-RPC reads an error with a null id as the peer refusing, and nothing else", () => {
  const f = new JsonRpcFraming();
  const conn = new JsonRpcConnectionFraming();
  for (const frame of [
    `{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}`,
    `{"id":null,"error":{"code":-32600,"message":"x","data":[1]},"jsonrpc":"2.0"}`,
    `{"jsonrpc":"2.0","error":{"code":-32700,"message":"x"},"x":1,"id":null}`,
    `{"jsonrpc":"2.0","result":null,"error":{"code":-32700,"message":"x"},"id":null}`,
  ]) {
    const bytes = enc.encode(frame);
    assert.equal(f.decodeResponse(bytes), undefined, frame);
    assert.equal(conn.decode(bytes), undefined, frame);
    assert.ok(f.isPeerRefusal(bytes), frame);
    assert.ok(conn.isPeerRefusal(bytes), frame);
  }
  for (const frame of [
    `{"jsonrpc":"2.0","error":{"code":-32700,"message":"x"},"id":1}`,
    `{"jsonrpc":"2.0","error":{"code":-32700,"message":"x"}}`,
    `{"jsonrpc":"2.0","result":1,"id":null}`,
    `{"jsonrpc":"2.0","error":null,"id":null}`,
    `{"jsonrpc":"2.0","id":null}`,
    `{"jsonrpc":"2.0","result":1,"error":{"code":1,"message":"x"},"id":null}`,
    `{"jsonrpc":"2.0","error":{"code":-32700},"id":null}`,
    `{"jsonrpc":"1.0","error":{"code":-32700,"message":"x"},"id":null}`,
    `{"error":{"code":-32700,"message":"x"},"id":null}`,
    `{"jsonrpc":"2.0","error":{"code":1,"message":"x"},"id":null,"id":null}`,
    `{"jsonrpc":"2.0","method":"m","params":[],"id":null}`,
    "",
    "{",
  ]) {
    assert.ok(!f.isPeerRefusal(enc.encode(frame)), frame);
  }
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

test("JSON-RPC ids are read exactly, and a response must carry one", () => {
  const f = new JsonRpcFraming();
  const max = (1n << 64n) - 1n;
  assert.equal(f.decodeResponse(f.encodeResponseFault(max))?.requestId, max);
  assert.equal(f.decodeRequest(f.encodeRequest(call(0, "ping"), max, enc.encode("[]")))?.requestId, max);

  assert.equal(f.decodeResponse(enc.encode('{"jsonrpc":"2.0","result":1}')), undefined);
  assert.equal(f.decodeResponse(enc.encode('{"jsonrpc":"2.0","result":1,"id":-1}')), undefined);
  assert.equal(f.decodeRequest(enc.encode('{"jsonrpc":"2.0","method":"m","id":1.5}')), undefined);
  // A notification: no id is request 0.
  assert.equal(f.decodeRequest(enc.encode('{"jsonrpc":"2.0","method":"m"}'))?.requestId, 0n);
});

test("JSON-RPC payloads pass through as written", () => {
  const f = new JsonRpcFraming();
  const payload = '{"n":9007199254740993,"f":1.0}';
  const back = f.decodeResponse(f.encodeResponseOk(1n, enc.encode(payload)));
  assert.ok(back && "ok" in back.envelope);
  assert.equal(dec.decode(back.envelope.ok), payload);
});
