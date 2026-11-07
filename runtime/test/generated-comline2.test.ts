// Exercises `datagram@3` and `comline@2` as generated: three packages from
// `generated/comline2/`, written by `comline-codegen-typescript`'s
// `generated_comline2_matches_the_runtime_test_fixture` test. `new` (0.2.0)
// reorders `old`'s (0.1.0) functions and adds one; `alien` is `old`'s schema
// under another package id.

import assert from "node:assert/strict";
import { test } from "node:test";

import { duplex, RuntimeError, type Peer } from "../src/index.js";
import * as alien from "./generated/comline2/alien/connection.js";
import * as alienChat from "./generated/comline2/alien/chat.js";
import * as neu from "./generated/comline2/new/connection.js";
import { ChatSender } from "./generated/comline2/new/chat.js";
import * as old from "./generated/comline2/old/connection.js";
import type { Chat as OldChat } from "./generated/comline2/old/chat.js";

const oldChat: OldChat = {
  async hello(_peer: Peer, { name }): Promise<number> {
    return name.length;
  },
  async shout(_peer: Peer, { text }): Promise<number> {
    return 100 + text.length;
  },
};

test("a newer client calls an older server by number, and degrades", async () => {
  const [dialler, acceptor] = duplex();
  const served = old.serve(acceptor, { chat: oldChat });
  const conn = await neu.connect(dialler);
  assert.deepEqual(neu.negotiated(conn)?.peerVersion, { major: 0, minor: 1, patch: 0, pre: "" });

  const chat = new ChatSender(conn);
  // By number: `hello` and `shout` reach their own handlers though `new`
  // declares them in another order.
  assert.equal(await chat.hello({ name: "ana" }), 3);
  assert.equal(await chat.shout({ text: "hey" }), 103);

  // `whisper` is new: the old server lacks it, so the call fails here,
  // naming it, and never reaches the wire.
  await assert.rejects(chat.whisper({ text: "psst" }), (e: unknown) => {
    assert.ok(e instanceof RuntimeError && e.is("unavailable"));
    assert.deepEqual(e.unavailable, { protocol: "chat::Chat", function: "whisper" });
    assert.equal(e.message, "`chat::Chat.whisper` wasn't called: the peer lacks it");
    return true;
  });
  assert.deepEqual(neu.warnings(conn), []);
  assert.equal(await chat.hello({ name: "bo" }), 2);

  dialler.close();
  await served;
});

test("another package is refused at both ends", async () => {
  const [dialler, acceptor] = duplex();
  const impl: alienChat.Chat = {
    async hello(): Promise<number> {
      return 0;
    },
    async shout(): Promise<number> {
      return 0;
    },
  };
  const served = alien.serve(acceptor, { chat: impl });
  const refused = (e: unknown) => {
    assert.ok(e instanceof RuntimeError && e.is("refused"), String(e));
    assert.deepEqual(e.refusal, { reason: "package_mismatch", side: "responder" });
    assert.equal(e.message, "the responder refused the connection: package_mismatch");
    return true;
  };
  await assert.rejects(neu.connect(dialler), refused);
  await assert.rejects(served, refused);
});
