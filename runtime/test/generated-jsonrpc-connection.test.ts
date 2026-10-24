// Exercises real generator output on a JSON-RPC `Connection`. `generated/link_jsonrpc.ts` is
// written by `comline-codegen-typescript`'s `generated_jsonrpc_link_matches_the_
// runtime_test_fixture` test; this proves it type-checks and runs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Connection, JsonCodec, JsonRpcConnectionFraming, duplex, type Peer } from "../src/index.js";
import {
  type Chat,
  type Events,
  type ChatSendParams,
  type EventsMessageParams,
  ChatDispatcher,
  ChatSender,
  CONNECTION_IR_HASH,
  EventsDispatcher,
  EventsSender,
} from "./generated/link_jsonrpc.js";

class Sent {
  constructor(public count: bigint) {}
}

const chat: Chat = {
  async send(peer: Peer, { text }: ChatSendParams): Promise<bigint> {
    assert.equal(await new EventsSender(peer).message({ text }), true);
    const sent = peer.extensions.get(Sent) ?? new Sent(0n);
    sent.count++;
    peer.extensions.set(sent);
    return sent.count;
  },
  async count(peer: Peer): Promise<bigint> {
    return peer.extensions.get(Sent)?.count ?? 0n;
  },
};

function events(seen: string[]): Events {
  return {
    async message(_peer: Peer, { text }: EventsMessageParams): Promise<boolean> {
      seen.push(text);
      return true;
    },
    async ping(): Promise<void> {
      seen.push("ping");
    },
  };
}

test("over JSON-RPC, a generated handler calls back, and the accepting side calls on its own", async () => {
  const [dialler, acceptor] = duplex();
  const codec = new JsonCodec();
  const [client, server] = await Promise.all([
    Connection.connect(dialler, codec, CONNECTION_IR_HASH, new JsonRpcConnectionFraming()),
    Connection.accept(acceptor, codec, CONNECTION_IR_HASH, new JsonRpcConnectionFraming()),
  ]);
  new ChatDispatcher(chat).provideOn(server);
  const seen: string[] = [];
  new EventsDispatcher(events(seen)).provideOn(client);

  const sender = new ChatSender(client);
  assert.equal(await sender.send({ text: "hi" }), 1n);
  assert.equal(await sender.send({ text: "again" }), 2n);
  assert.equal(await sender.count(), 2n);

  assert.equal(await new EventsSender(server).message({ text: "pushed" }), true);
  await new EventsSender(server).ping();
  acceptor.close();
  await client.closed;
  assert.deepEqual(seen, ["hi", "again", "pushed", "ping"]);
});
