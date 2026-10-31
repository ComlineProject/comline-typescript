import assert from "node:assert/strict";
import { test } from "node:test";

import { currentCore, loadedCore } from "../src/core/core.js";
import { MAX_WAITING, Wire } from "../src/core/wire.js";
import {
  Connection,
  Datagram2Framing,
  JsonCodec,
  JsonRpcConnectionFraming,
  RuntimeError,
  call,
  duplex,
  type Call,
  type ConnectionFraming,
  type Dispatch,
  type Envelope,
  type Frame,
  type Kind,
  type Reply,
} from "../src/index.js";

// `Connection` on the Comline core: what the binding adds over the
// TypeScript framing and state (busy-queueing, STALE, malformed frames,
// JSON-RPC's absent bodies and escaped names, freeing, poisoning).
// `core-connection-poison.test.ts` poisons the realm's instance in a process
// of its own.

const IR_HASH = 0x77n;
const ECHO = 0;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Answers `echo` (call 0) with its params, once `gate` opens. */
class Echo implements Dispatch {
  gate: Promise<void> = Promise.resolve();
  served = 0;
  calls() {
    return ["echo"];
  }
  dispatch(): Promise<void> {
    return Promise.reject(new Error("served only on a connection"));
  }
  async dispatchWith(_kind: Kind, params: Uint8Array, reply: Reply): Promise<void> {
    await this.gate;
    this.served++;
    reply.ok(params.slice());
  }
}

function wireOf(conn: Connection): Wire | undefined {
  return (conn as unknown as { wire: Wire | undefined }).wire;
}

async function pair(framing: () => ConnectionFraming = () => new Datagram2Framing()) {
  const [dialler, acceptor] = duplex();
  const codec = new JsonCodec();
  const [client, server] = await Promise.all([
    Connection.connect(dialler, codec, IR_HASH, framing()),
    Connection.accept(acceptor, codec, IR_HASH, framing()),
  ]);
  const echo = new Echo();
  server.provide(ECHO, echo);
  return { client, server, echo, dialler, acceptor, codec };
}

const ECHO_CALL: Call = call(0, "echo");

function okText(codec: JsonCodec, envelope: Envelope): string {
  assert.ok("ok" in envelope, `not ok: ${JSON.stringify(envelope)}`);
  return codec.decode<string>(envelope.ok);
}

test("connect and accept run on the core with a built-in framing", async () => {
  for (const framing of [() => new Datagram2Framing(), () => new JsonRpcConnectionFraming()]) {
    const { client, server, dialler, codec } = await pair(framing);
    assert.ok(wireOf(client) && wireOf(server));
    assert.equal(okText(codec, await client.call(ECHO, ECHO_CALL, "hi")), "hi");
    dialler.close();
  }
});

test("a custom ConnectionFraming runs on the TypeScript", async () => {
  class Mine extends Datagram2Framing {}
  const { client, server, dialler, codec } = await pair(() => new Mine());
  assert.equal(wireOf(client), undefined);
  assert.equal(wireOf(server), undefined);
  assert.equal(okText(codec, await client.call(ECHO, ECHO_CALL, "hi")), "hi");
  dialler.close();
});

test(`more than ${MAX_WAITING} calls in flight queue for room, and all are answered in order`, async () => {
  const { client, echo, dialler, codec } = await pair();
  let open!: () => void;
  echo.gate = new Promise((resolve) => (open = resolve));
  const n = MAX_WAITING * 3 + 5;
  const calls = Array.from({ length: n }, (_, i) => client.call(ECHO, ECHO_CALL, `m${i}`));
  await new Promise((r) => setImmediate(r));
  // The server has the first MAX_WAITING; the rest wait in the client.
  assert.equal(echo.served, 0);
  open();
  const replies = await Promise.all(calls);
  assert.deepEqual(
    replies.map((r) => okText(codec, r)),
    Array.from({ length: n }, (_, i) => `m${i}`),
  );
  assert.equal(echo.served, n);
  dialler.close();
});

test("a call timing out while queued for room is never sent, and frees nothing it didn't hold", async () => {
  const { client, echo, dialler, codec } = await pair();
  let open!: () => void;
  echo.gate = new Promise((resolve) => (open = resolve));
  const held = Array.from({ length: MAX_WAITING }, (_, i) => client.call(ECHO, ECHO_CALL, `h${i}`));
  const queued = client.call(ECHO, ECHO_CALL, "late", { timeoutMs: 5 });
  await assert.rejects(queued, (e: unknown) => e instanceof RuntimeError && e.is("timeout"));
  const after = client.call(ECHO, ECHO_CALL, "after");
  open();
  assert.equal((await Promise.all(held)).length, MAX_WAITING);
  assert.equal(okText(codec, await after), "after");
  assert.equal(echo.served, MAX_WAITING + 1); // "late" never reached the server
  dialler.close();
});

test("a reply to a call that timed out is STALE on the core, and dropped", async () => {
  const { client, echo, dialler, codec } = await pair();
  let open!: () => void;
  echo.gate = new Promise((resolve) => (open = resolve));
  const fed: (Frame | "stale" | undefined)[] = [];
  const wire = wireOf(client)!;
  const feed = wire.feed.bind(wire);
  wire.feed = (frame) => {
    const d = feed(frame);
    fed.push(d);
    return d;
  };
  await assert.rejects(client.call(ECHO, ECHO_CALL, "slow", { timeoutMs: 5 }), (e: unknown) =>
    e instanceof RuntimeError && e.is("timeout"),
  );
  open();
  assert.equal(okText(codec, await client.call(ECHO, ECHO_CALL, "next")), "next");
  assert.deepEqual(fed[0], "stale");
  dialler.close();
});

test("a malformed frame closes a connection on the core, failing its calls", async () => {
  for (const [framing, bad] of [
    [() => new Datagram2Framing(), new Uint8Array([9, 9, 9])],
    [() => new JsonRpcConnectionFraming(), enc.encode("{not json")],
  ] as const) {
    const [mine, theirs] = duplex();
    const conn = Connection.unverified(mine, new JsonCodec(), framing());
    assert.ok(wireOf(conn));
    const waiting = conn.call(ECHO, ECHO_CALL, "x");
    await theirs.recv();
    await theirs.send(bad);
    await conn.closed;
    await assert.rejects(waiting, (e: unknown) => e instanceof RuntimeError && e.is("transport"));
    await assert.rejects(conn.call(ECHO, ECHO_CALL, "y"), (e: unknown) => e instanceof RuntimeError && e.is("transport"));
  }
});

test("jsonrpc@1 on the core: an absent params, result or error data reads as null", async () => {
  const [mine, theirs] = duplex();
  const conn = Connection.unverified(mine, new JsonCodec(), new JsonRpcConnectionFraming());
  assert.ok(wireOf(conn));
  const seen: string[] = [];
  conn.provide(ECHO, {
    calls: () => ["echo"],
    dispatch: () => Promise.reject(new Error("unused")),
    async dispatchWith(_k: Kind, params: Uint8Array, reply: Reply) {
      seen.push(dec.decode(params));
      reply.ok(enc.encode("1"));
    },
  });
  await theirs.send(enc.encode(`{"jsonrpc":"2.0","method":"echo","id":4}`));
  assert.equal(dec.decode(await theirs.recv()), `{"jsonrpc":"2.0","result":1,"id":4}`);
  assert.deepEqual(seen, ["null"]);

  const result = conn.call(ECHO, ECHO_CALL, "x");
  const req = JSON.parse(dec.decode(await theirs.recv())) as { id: number };
  await theirs.send(enc.encode(`{"jsonrpc":"2.0","id":${req.id}}`));
  assert.equal(dec.decode((await result as { ok: Uint8Array }).ok), "null");

  const failed = conn.call(ECHO, ECHO_CALL, "x");
  const req2 = JSON.parse(dec.decode(await theirs.recv())) as { id: number };
  await theirs.send(enc.encode(`{"jsonrpc":"2.0","error":{"code":3,"message":"m"},"id":${req2.id}}`));
  const err = (await failed) as { err: { id: number; body: Uint8Array } };
  assert.equal(err.err.id, 3);
  assert.equal(dec.decode(err.err.body), "null");
  theirs.close();
});

test("jsonrpc@1 on the core: a method name spelled with escapes is unescaped", async () => {
  const [mine, theirs] = duplex();
  const conn = Connection.unverified(mine, new JsonCodec(), new JsonRpcConnectionFraming());
  assert.ok(wireOf(conn));
  const names: string[] = [];
  conn.provide(ECHO, {
    calls: () => ["chat.Chat/send"],
    dispatch: () => Promise.reject(new Error("unused")),
    async dispatchWith(_k: Kind, params: Uint8Array, reply: Reply) {
      names.push(dec.decode(params));
      reply.ok(enc.encode("true"));
    },
  });
  await theirs.send(enc.encode(String.raw`{"jsonrpc":"2.0","method":"chat.Chat\/send","params":7,"id":1}`));
  assert.equal(dec.decode(await theirs.recv()), `{"jsonrpc":"2.0","result":true,"id":1}`);
  assert.deepEqual(names, ["7"]);
  theirs.close();
});

test("closing frees the core's connection, once", async () => {
  const { client, server, dialler, acceptor } = await pair();
  const frees: string[] = [];
  for (const [name, conn] of [["client", client], ["server", server]] as const) {
    const abi = (wireOf(conn) as unknown as { conn: { free(): void } }).conn;
    const free = abi.free.bind(abi);
    abi.free = () => {
      frees.push(name);
      free();
    };
  }
  dialler.close();
  acceptor.close();
  await Promise.all([client.closed, server.closed]);
  assert.deepEqual(frees.sort(), ["client", "server"]);
});

test("large frames come from the pool and survive the buffer's reuse", async () => {
  const { client, dialler, codec } = await pair();
  const texts = Array.from({ length: 20 }, (_, i) => String.fromCharCode(97 + i).repeat(3000 + i));
  for (const text of texts) assert.equal(okText(codec, await client.call(ECHO, ECHO_CALL, text)), text);
  const together = await Promise.all(texts.map((t) => client.call(ECHO, ECHO_CALL, t)));
  assert.deepEqual(together.map((r) => okText(codec, r)), texts);
  dialler.close();
});

test("the core stays loaded for later connections", async () => {
  await loadedCore();
  assert.ok(currentCore());
});
