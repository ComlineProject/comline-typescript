import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Connection,
  JsonCodec,
  JsonRpcConnectionFraming,
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

// Mirrors the Rust runtime's `tests/jsonrpc_connection.rs`:
//
//   @framing = { name = "jsonrpc", method_names = qualified }
//   protocol Chat {                        // provided by the accepting side, #0
//     function send(text: str) -> u64;     // calls Events.message back
//     function count() -> u64;
//   }
//   @framing = { name = "jsonrpc", method_names = qualified }
//   @provider = Client
//   protocol Events {                      // provided by the dialling side, #1
//     function message(text: str) -> bool;
//     function ping();                     // one-way
//   }

const CHAT = 0;
const EVENTS = 1;
const CHAT_CALLS = ["app.Chat/send", "app.Chat/count"];
const EVENTS_CALLS = ["app.Events/message", "app.Events/ping"];
const IR_HASH = 0x1234n;

const enc = new TextEncoder();
const dec = new TextDecoder();

function okValue<T>(codec: Codec, envelope: Envelope): T {
  if ("ok" in envelope) return codec.decode<T>(envelope.ok);
  throw "fault" in envelope ? RuntimeError.provider() : RuntimeError.remote(envelope.err.id);
}

class ChatDispatcher implements Dispatch {
  sent = 0;

  calls(): readonly string[] {
    return CHAT_CALLS;
  }

  async dispatch(): Promise<void> {
    throw new Error("only served on a connection");
  }

  async dispatchWith(kind: Kind, params: Uint8Array, reply: Reply, peer: Peer): Promise<void> {
    switch ("id" in kind ? kind.id : -1) {
      case 0: {
        const { text } = peer.codec.decode<{ text: string }>(params);
        const shown = okValue<boolean>(peer.codec, await peer.call(EVENTS, call(0, EVENTS_CALLS[0]!), { text }));
        assert.equal(shown, true);
        reply.ok(peer.codec.encode(++this.sent));
        return;
      }
      case 1:
        reply.ok(peer.codec.encode(this.sent));
        return;
      default:
        throw RuntimeError.unknownCall();
    }
  }
}

class EventsDispatcher implements Dispatch {
  readonly seen: string[] = [];

  calls(): readonly string[] {
    return EVENTS_CALLS;
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

test("JSON-RPC connection frames: a one-way call is a notification", () => {
  const f = new JsonRpcConnectionFraming();
  const params = enc.encode(`["hi"]`);
  const notification = f.encodeRequest(0, call(1, "app.Events/ping"), 4n, params, true);
  assert.equal(dec.decode(notification), `{"jsonrpc":"2.0","method":"app.Events/ping","params":["hi"]}`);
  assert.deepEqual(f.decode(notification), {
    kind: "request",
    protocol: undefined,
    oneWay: true,
    request: { call: { name: "app.Events/ping" }, requestId: 0n, params },
  });

  const request = f.encodeRequest(0, call(0, "send"), 4n, params);
  assert.equal(dec.decode(request), `{"jsonrpc":"2.0","method":"send","params":["hi"],"id":4}`);
  const decoded = f.decode(request);
  assert.ok(decoded?.kind === "request" && !decoded.oneWay && decoded.request.requestId === 4n);

  const reply = f.encodeReply(0, 9n, { err: { id: 3, body: enc.encode(`{"why":"no"}`) } });
  assert.deepEqual(f.decode(reply), {
    kind: "reply",
    protocol: undefined,
    requestId: 9n,
    envelope: { err: { id: 3, body: enc.encode(`{"why":"no"}`) } },
  });
  // A reply has to say which call it answers.
  assert.equal(f.decode(enc.encode(`{"jsonrpc":"2.0","result":1}`)), undefined);
});

test("over JSON-RPC, calls go both ways, named by protocol", async () => {
  const [dialler, acceptor] = duplex();
  const codec = new JsonCodec();
  const [client, server] = await Promise.all([
    Connection.connect(dialler, codec, IR_HASH, new JsonRpcConnectionFraming()),
    Connection.accept(acceptor, codec, IR_HASH, new JsonRpcConnectionFraming()),
  ]);
  const chat = new ChatDispatcher();
  server.provide(CHAT, chat);
  const events = new EventsDispatcher();
  client.provide(EVENTS, events);

  assert.equal(okValue<number>(codec, await client.call(CHAT, call(0, CHAT_CALLS[0]!), { text: "hi" })), 1);
  assert.equal(okValue<boolean>(codec, await server.call(EVENTS, call(0, EVENTS_CALLS[0]!), { text: "pushed" })), true);
  await server.notify(EVENTS, call(1, EVENTS_CALLS[1]!), null);
  assert.equal(okValue<number>(codec, await client.call(CHAT, call(1, CHAT_CALLS[1]!), null)), 1);
  assert.deepEqual(events.seen, ["hi", "pushed", "ping"]);

  // A method no protocol here has is a fault, and the connection survives it.
  assert.deepEqual(await client.call(CHAT, call(0, "app.Chat/nope"), null), { fault: true });
  assert.equal(okValue<number>(codec, await client.call(CHAT, call(1, CHAT_CALLS[1]!), null)), 1);
  dialler.close();
});

test("over JSON-RPC, a notification gets no reply", async () => {
  const [raw, side] = duplex();
  const conn = Connection.unverified(side, new JsonCodec(), new JsonRpcConnectionFraming());
  conn.provide(CHAT, new ChatDispatcher());

  // `count` returns a value, but asked without an id it answers nothing: the
  // next frame back is the reply to the call after it.
  await raw.send(enc.encode(`{"jsonrpc":"2.0","method":"app.Chat/count","params":null}`));
  await raw.send(enc.encode(`{"jsonrpc":"2.0","method":"app.Chat/count","params":null,"id":3}`));
  assert.equal(dec.decode(await raw.recv()), `{"jsonrpc":"2.0","result":0,"id":3}`);
  raw.close();
});
