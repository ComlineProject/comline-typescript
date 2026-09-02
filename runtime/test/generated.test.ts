// Exercises real generator output against the runtime. `generated/chat.ts` is
// written by `comline-codegen-typescript`'s `generated_chat_matches_the_
// runtime_test_fixture` test; this proves it type-checks and runs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { JsonCodec, duplex } from "../src/index.js";
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
