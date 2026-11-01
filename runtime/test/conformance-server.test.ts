// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The stdio ops server's replies, in the shapes `comline-reference`'s README
 * gives. The cases themselves are `conformance.test.ts`'s; CI also drives the
 * built server with `comline conformance` (see the README).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PROTOCOL, handleLine } from "./conformance-server.js";

const reply = (line: string): unknown => JSON.parse(handleLine(line));

test("version lists what the runtime ships", () => {
  assert.deepEqual(reply('{"id": null, "op": "version"}'), {
    id: null,
    version: {
      protocol: PROTOCOL,
      ops: [
        "name_hash",
        "handshake",
        "handshake_check",
        "envelope",
        "request",
        "response",
        "encode",
        "decode",
        "stream_prefix",
        "stream_split",
        "version",
      ],
      formats: ["json@1", "packed@1"],
      framings: ["datagram@1", "datagram@2", "jsonrpc@1"],
    },
  });
});

test("encodes without bytes, decodes with them, and refuses what it must", () => {
  const input = { kind: "err", id: 258, body: "6669656c6473" };
  assert.deepEqual(reply(JSON.stringify({ id: 1, op: "envelope", input })), {
    id: 1,
    bytes: "0102016669656c6473",
  });
  assert.deepEqual(
    reply(JSON.stringify({ id: "e", op: "envelope", input, bytes: "0102016669656c6473" })),
    { id: "e", accept: true, input },
  );
  assert.deepEqual(reply('{"id": 3, "op": "request", "input": {"framing": "datagram@1"}, "bytes": ""}'), {
    id: 3,
    accept: false,
  });
});

test("handshake_check accepts an agreeing peer, refuses a differing one, and is decode-only", () => {
  const input = { capabilities: 0, framing: "datagram@1", ir_hash: "1", wire_format: "json@1" };
  const agree = "434f0101000000000000003885b0bd1f9f6c85d153a199ba45a44405000000";
  const otherHash = "434f0102000000000000003885b0bd1f9f6c85d153a199ba45a44400000000";
  assert.deepEqual(reply(JSON.stringify({ id: 1, op: "handshake_check", input, bytes: agree })), {
    id: 1,
    accept: true,
    input,
  });
  assert.deepEqual(reply(JSON.stringify({ id: 2, op: "handshake_check", input, bytes: otherHash })), {
    id: 2,
    accept: false,
  });
  assert.deepEqual(reply(JSON.stringify({ id: 3, op: "handshake_check", input, bytes: "00" })), {
    id: 3,
    accept: false,
  });
  assert.deepEqual(reply(JSON.stringify({ id: 4, op: "handshake_check", input })), {
    id: 4,
    error: "handshake_check is decode-only: send its bytes",
  });
});

test("answers a batch in order, and a bad line with an error", () => {
  const got = reply(
    '[{"id": "a", "op": "version"}, {"id": "b", "op": "nope"}, 3, {"id": "d", "op": "name_hash", "input": {"name": "x"}, "bytes": "00"}, {"id": 5, "op": "encode", "input": {"format": "nope@1", "value": {"u8": 1}}}]',
  ) as Record<string, unknown>[];
  assert.equal(got.length, 5);
  assert.ok(got[0]?.version);
  assert.deepEqual(got[1], { id: "b", error: "unknown op `nope`" });
  assert.equal(got[2]?.id, null);
  assert.equal(typeof got[2]?.error, "string");
  assert.deepEqual(got[3], { id: "d", error: "name_hash is encode-only: send it without bytes" });
  assert.equal(got[4]?.id, 5);
  assert.equal(typeof got[4]?.not_implemented, "string");

  for (const line of ["{", "", "nonsense", '{"id": 1}', '{"op": 5}']) {
    assert.equal(typeof (reply(line) as { error?: unknown }).error, "string", line);
  }
});
