import assert from "node:assert/strict";
import { test } from "node:test";

import { duplex } from "../src/index.js";

// The `Transport` contract: `send(frame)` lends `frame` until its promise
// settles; after that the sender may reuse or overwrite it.

test("a sender reusing its buffer after `await send()` never changes what the receiver got", async () => {
  const [a, b] = duplex();
  const buffer = new Uint8Array(64);
  const expected: Uint8Array[] = [];
  for (let i = 0; i < 100; i++) {
    const len = 1 + ((i * 37) % buffer.length);
    for (let j = 0; j < len; j++) buffer[j] = (i * 13 + j) & 0xff;
    const frame = buffer.subarray(0, len);
    expected.push(Uint8Array.from(frame));
    await a.send(frame);
    buffer.fill(0xee); // the sender owns it again: overwrite all of it
  }
  for (const want of expected) assert.deepEqual(await b.recv(), want);
});

test("frames already queued keep their bytes while the sender overwrites its buffer", async () => {
  const [a, b] = duplex();
  const buffer = new Uint8Array(8);
  buffer.fill(1);
  await a.send(buffer);
  buffer.fill(2);
  await a.send(buffer);
  buffer.fill(3);
  const first = await b.recv();
  const second = await b.recv();
  buffer.fill(4);
  assert.deepEqual(first, new Uint8Array(8).fill(1));
  assert.deepEqual(second, new Uint8Array(8).fill(2));
  assert.notEqual(first.buffer, buffer.buffer);
});

test("a receiver handed a frame owns it: the sender's later frames don't touch it", async () => {
  const [a, b] = duplex();
  const buffer = new Uint8Array([9, 9, 9]);
  const received = b.recv(); // parked before the frame arrives
  await a.send(buffer);
  buffer.set([7, 7, 7]);
  await a.send(buffer);
  assert.deepEqual(await received, new Uint8Array([9, 9, 9]));
  assert.deepEqual(await b.recv(), new Uint8Array([7, 7, 7]));
});
