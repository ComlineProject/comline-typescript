// Exercises real generator output against the runtime. `generated/chat.ts` is
// written by `comline-codegen-typescript`'s `generated_chat_matches_the_
// runtime_test_fixture` test; this proves it type-checks and runs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { JsonCodec, RuntimeError, duplex } from "../src/index.js";
import {
  type Chat,
  ChatClient,
  RejectedError,
  serveChat,
  IR_HASH,
} from "./generated/chat.js";

test("the generated Chat carries a bigint IR_HASH", () => {
  assert.equal(typeof IR_HASH, "bigint");
});

test("a generated client ⇆ provider round-trip", async () => {
  const [clientSide, providerSide] = duplex();
  const seen: string[] = [];

  const impl: Chat = {
    async send({ text }) {
      if (text === "") throw new RejectedError({ reason: "empty" });
      return { body: `echo: ${text}`, seq: 1 };
    },
    async history({ limit }) {
      return Array.from({ length: limit }, (_, i) => ({ body: `m${i}`, seq: i }));
    },
    async wipe() {
      seen.length = 0;
    },
    async note({ text }) {
      seen.push(text);
    },
  };

  const provider = serveChat(impl, providerSide, new JsonCodec());
  const chat = await ChatClient.connect(clientSide, new JsonCodec());

  assert.equal((await chat.send({ text: "hi" })).body, "echo: hi");
  assert.equal((await chat.history({ limit: 3 })).length, 3);

  await assert.rejects(
    chat.send({ text: "" }),
    (e: unknown) => e instanceof RejectedError && e.data.reason === "empty",
  );

  await chat.note({ text: "saved" }); // one-way
  await chat.wipe(); // `()` return
  assert.deepEqual(seen, []);

  clientSide.close();
  await provider;
});

/// A handler that throws something its schema never declared used to unwind
/// out of the server loop: the connection died and the caller waited out its
/// timeout. Now it answers, and the next call still works.
test("a provider that fails outside its schema answers with a fault", async () => {
  const [clientSide, providerSide] = duplex();

  const impl: Chat = {
    async send() {
      throw new Error("the database is on fire");
    },
    async history() {
      // `history` declares no `!` at all, and can still fail.
      throw new Error("still on fire");
    },
    async wipe() {},
    async note() {},
  };

  const provider = serveChat(impl, providerSide, new JsonCodec());
  const chat = await ChatClient.connect(clientSide, new JsonCodec());

  await assert.rejects(
    chat.send({ text: "hi" }),
    (e: unknown) => e instanceof RuntimeError && e.is("provider"),
  );
  await assert.rejects(
    chat.history({ limit: 1 }),
    (e: unknown) => e instanceof RuntimeError && e.is("provider"),
  );
  // The connection survived both.
  await chat.wipe();

  clientSide.close();
  await provider;
});
