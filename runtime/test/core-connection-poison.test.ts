import assert from "node:assert/strict";
import { test } from "node:test";

import { Status } from "#core/comline.mjs";
import { currentCore } from "../src/core/core.js";
import { loadCore } from "../src/core/load.js";
import type { Wire } from "../src/core/wire.js";
import { Connection, JsonCodec, RuntimeError, call, duplex, type Kind, type Reply } from "../src/index.js";

// Its own file: it poisons the realm's instance (node --test runs each file
// in its own process).

const IR_HASH = 0x78n;

function wireOf(conn: Connection): Wire | undefined {
  return (conn as unknown as { wire: Wire | undefined }).wire;
}

async function pair() {
  const [dialler, acceptor] = duplex();
  const codec = new JsonCodec();
  const [client, server] = await Promise.all([
    Connection.connect(dialler, codec, IR_HASH),
    Connection.accept(acceptor, codec, IR_HASH),
  ]);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  server.provide(0, {
    calls: () => ["echo"],
    dispatch: () => Promise.reject(new Error("unused")),
    async dispatchWith(_k: Kind, params: Uint8Array, reply: Reply) {
      await gate;
      reply.ok(params.slice());
    },
  });
  return { client, server, open, dialler };
}

test("a poisoned core fails every connection on it with `poisoned`, and the next connects on a fresh one", async () => {
  const first = await pair();
  const second = await pair();
  const lib = await loadCore();
  assert.ok(wireOf(first.client) && wireOf(second.client));

  const one = first.client.call(0, call(0, "echo"), "a");
  const two = second.client.call(0, call(0, "echo"), "b");
  // A trap can't be planted in the release build: the glue's answer to one
  // is ERR_POISONED from every call, which the first reply now meets.
  const abi = (wireOf(first.client) as unknown as { conn: { feed: unknown } }).conn;
  Object.defineProperty(abi, "feed", {
    value: () => ({ status: Status.ERR_POISONED, consumed: 0, event: {} }),
  });
  first.open();
  const poisoned = (e: unknown) => e instanceof RuntimeError && e.is("poisoned");
  await assert.rejects(one, poisoned);
  // The other connection on the same instance fails too, without a frame.
  await assert.rejects(two, poisoned);
  await assert.rejects(second.client.call(0, call(0, "echo"), "c"), poisoned);
  assert.equal(currentCore(), undefined);

  const third = await pair();
  assert.notEqual(await loadCore(), lib);
  third.open();
  const reply = await third.client.call(0, call(0, "echo"), "d");
  assert.ok("ok" in reply);
  for (const p of [first, second, third]) p.dialler.close();
});
