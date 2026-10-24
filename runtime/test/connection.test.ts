import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Connection,
  Datagram2Framing,
  JsonCodec,
  RuntimeError,
  call,
  duplex,
  type Codec,
  type Dispatch,
  type Envelope,
  type Kind,
  type Peer,
  type Reply,
} from "../src/index.js";

// Mirrors the Rust runtime's `tests/connection_roundtrip.rs`:
//
//   protocol Chat {                        // provided by the accepting side, #0
//     function send(text: str) -> u64;     // calls Events.message back
//     function count() -> u64;
//   }
//   @provider = Client
//   protocol Events {                      // provided by the dialling side, #1
//     function message(text: str) -> bool;
//     function ping();                     // one-way
//   }

const CHAT = 0;
const EVENTS = 1;
const IR_HASH = 0x1234n;

function okValue<T>(codec: Codec, envelope: Envelope): T {
  if ("ok" in envelope) return codec.decode<T>(envelope.ok);
  throw "fault" in envelope ? RuntimeError.provider() : RuntimeError.remote(envelope.err.id);
}

/** How many messages a connection's chat has sent, kept on the connection. */
class Sent {
  constructor(public count: number) {}
}

class ChatDispatcher implements Dispatch {
  calls(): readonly string[] {
    return ["send", "count"];
  }

  async dispatch(): Promise<void> {
    throw new Error("only served on a connection");
  }

  async dispatchWith(kind: Kind, params: Uint8Array, reply: Reply, peer: Peer): Promise<void> {
    switch ("id" in kind ? kind.id : -1) {
      case 0: {
        const { text } = peer.codec.decode<{ text: string }>(params);
        const shown = okValue<boolean>(peer.codec, await peer.call(EVENTS, call(0, "message"), { text }));
        assert.equal(shown, true);
        const sent = peer.extensions.get(Sent) ?? new Sent(0);
        sent.count++;
        peer.extensions.set(sent);
        reply.ok(peer.codec.encode(sent.count));
        return;
      }
      case 1:
        reply.ok(peer.codec.encode(peer.extensions.get(Sent)?.count ?? 0));
        return;
      default:
        throw RuntimeError.unknownCall();
    }
  }
}

class EventsDispatcher implements Dispatch {
  readonly seen: string[] = [];

  calls(): readonly string[] {
    return ["message", "ping"];
  }

  async dispatch(kind: Kind, params: Uint8Array, codec: Codec, reply: Reply): Promise<void> {
    switch ("id" in kind ? kind.id : -1) {
      case 0:
        this.seen.push(codec.decode<{ text: string }>(params).text);
        reply.ok(codec.encode(true));
        return;
      case 1:
        this.seen.push("ping");
        return;
      default:
        throw RuntimeError.unknownCall();
    }
  }
}

async function pair() {
  const [dialler, acceptor] = duplex();
  const codec = new JsonCodec();
  const [client, server] = await Promise.all([
    Connection.connect(dialler, codec, IR_HASH),
    Connection.accept(acceptor, codec, IR_HASH),
  ]);
  server.provide(CHAT, new ChatDispatcher());
  const events = new EventsDispatcher();
  client.provide(EVENTS, events);
  return { client, server, events, dialler, acceptor, codec };
}

test("a handler calls back the peer that called it", async () => {
  const { client, events, codec, dialler } = await pair();
  const first = okValue<number>(codec, await client.call(CHAT, call(0, "send"), { text: "hi" }));
  const second = okValue<number>(codec, await client.call(CHAT, call(0, "send"), { text: "again" }));
  const count = okValue<number>(codec, await client.call(CHAT, call(1, "count"), []));
  assert.deepEqual([first, second, count], [1, 2, 2]);
  assert.deepEqual(events.seen, ["hi", "again"]);
  dialler.close();
});

test("the accepting side starts calls of its own", async () => {
  const { server, events, codec, acceptor, client } = await pair();
  const shown = okValue<boolean>(codec, await server.call(EVENTS, call(0, "message"), { text: "pushed" }));
  assert.equal(shown, true);
  await server.notify(EVENTS, call(1, "ping"), []);
  acceptor.close();
  await client.closed;
  assert.deepEqual(events.seen, ["pushed", "ping"]);
});

test("several calls can be in flight at once", async () => {
  const { client, codec, dialler } = await pair();
  const replies = await Promise.all(
    ["a", "b", "c"].map((text) => client.call(CHAT, call(0, "send"), { text })),
  );
  // Each `send` waits on its call back, so the next one starts meanwhile;
  // the answers still come in order.
  assert.deepEqual(
    replies.map((r) => okValue<number>(codec, r)),
    [1, 2, 3],
  );
  dialler.close();
});

test("a protocol this side doesn't provide is a fault", async () => {
  const { client, codec, dialler } = await pair();
  assert.deepEqual(await client.call(7, call(0, "anything"), []), { fault: true });
  assert.equal(okValue<number>(codec, await client.call(CHAT, call(1, "count"), [])), 0);
  dialler.close();
});

test("a timed-out call rejects, and its late reply is dropped", async () => {
  const [dialler, acceptor] = duplex();
  const codec = new JsonCodec();
  const client = Connection.unverified(dialler, codec);
  const timedOut = client.call(CHAT, call(1, "count"), [], { timeoutMs: 10 });
  await assert.rejects(timedOut, (e: unknown) => e instanceof RuntimeError && e.is("timeout"));

  // Only now does the other side start serving: the first call's reply
  // arrives first, and is skipped.
  const server = Connection.unverified(acceptor, codec);
  server.provide(CHAT, new ChatDispatcher());
  assert.equal(okValue<number>(codec, await client.call(CHAT, call(1, "count"), [])), 0);
  dialler.close();
});

test("calls waiting when the transport closes reject", async () => {
  const [dialler, acceptor] = duplex();
  const client = Connection.unverified(dialler, new JsonCodec());
  const waiting = client.call(CHAT, call(1, "count"), []);
  acceptor.close();
  await assert.rejects(waiting, (e: unknown) => e instanceof RuntimeError && e.is("transport"));
});

test("connections get distinct ids", () => {
  const [a] = duplex();
  const [b] = duplex();
  const codec = new JsonCodec();
  assert.notEqual(Connection.unverified(a, codec).id, Connection.unverified(b, codec).id);
});

test("a mismatched handshake refuses the connection", async () => {
  const [dialler, acceptor] = duplex();
  const codec = new JsonCodec();
  const results = await Promise.allSettled([
    Connection.connect(dialler, codec, 1n),
    Connection.accept(acceptor, codec, 2n),
  ]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.ok((result as PromiseRejectedResult).reason instanceof RuntimeError);
  }
});

test("datagram@2 frames round trip", () => {
  const f = new Datagram2Framing();
  const request = f.encodeRequest(300, call(5, "x"), 42n, new Uint8Array([9]));
  assert.deepEqual(f.decode(request), {
    kind: "request",
    protocol: 300,
    oneWay: false,
    request: { call: { id: 5 }, requestId: 42n, params: new Uint8Array([9]) },
  });
  const reply = f.encodeReply(1, 7n, { err: { id: 2, body: new Uint8Array([1]) } });
  assert.deepEqual(f.decode(reply), {
    kind: "reply",
    protocol: 1,
    requestId: 7n,
    envelope: { err: { id: 2, body: new Uint8Array([1]) } },
  });
  assert.equal(f.decode(new Uint8Array([0, 0x80, 0x00])), undefined, "overlong protocol number");
  assert.throws(() => f.encodeRequest(0x10000, call(0, ""), 0n, new Uint8Array()));
});
