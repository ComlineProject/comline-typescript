import assert from "node:assert/strict";
import { test } from "node:test";

import { Status } from "#core/comline.mjs";
import { currentCore, loadedCore } from "../src/core/core.js";
import { loadCore } from "../src/core/load.js";
import { ComlineHandshake, duplex, RuntimeError } from "../src/index.js";

// Its own file: it starts with no core loaded, and poisons the realm's
// instance (node --test runs each file in its own process).
const facts = { irHash: 7n, wireFormat: "json@1", framing: "datagram@2" };

test("comline@1 never loads the core itself: without one it runs on the TypeScript", async () => {
  assert.equal(currentCore(), undefined);
  const [a, b] = duplex();
  const hs = new ComlineHandshake();
  await Promise.all([hs.initiate(a, facts), hs.respond(b, facts)]);
  assert.equal(currentCore(), undefined);
});

test("comline@1 runs on the core once the realm has loaded it", async () => {
  const core = await loadedCore();
  let calls = 0;
  const encode = core.handshakeEncode.bind(core);
  core.handshakeEncode = (...args: Parameters<typeof encode>) => {
    calls++;
    return encode(...args);
  };
  const [a, b] = duplex();
  const hs = new ComlineHandshake();
  await Promise.all([hs.initiate(a, facts), hs.respond(b, facts)]);
  assert.equal(calls, 2);
});

test("a poisoned core fails the handshake with `poisoned`, and the next one loads afresh", async () => {
  const hs = new ComlineHandshake();
  const first = await loadCore();
  await loadedCore();
  // A trap can't be planted in the release build (no test hooks), so the
  // glue's answer to one is: every call returns ERR_POISONED.
  Object.defineProperty(first, "handshakeEncode", {
    value: () => ({ status: Status.ERR_POISONED, written: 0 }),
  });
  const [a, b] = duplex();
  await assert.rejects(hs.initiate(a, facts), (e: unknown) => e instanceof RuntimeError && e.is("poisoned"));
  void b;
  assert.equal(currentCore(), undefined);

  const second = await loadCore();
  assert.notEqual(second, first);
  await loadedCore();
  const [c, d] = duplex();
  await Promise.all([hs.initiate(c, facts), hs.respond(d, facts)]);
  assert.ok(currentCore() !== undefined);
});
