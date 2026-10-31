import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ABI_MAJOR, ABI_MINOR, Status } from "#core/comline.mjs";
import { loadCore } from "../src/core/load.js";
import { Core, loadedCore, statusError } from "../src/core/core.js";
import { HandshakeFrame, nameHash, RuntimeError, type RuntimeErrorKind } from "../src/index.js";
import { unhex, type Case } from "./ops.js";

test("loadCore loads the vendored core, once", async () => {
  const core = await loadCore();
  assert.equal(await loadCore(), core);
  assert.equal(core.poisoned, false);
});

test("the vendored core is ABI 0.1", async () => {
  const core = await loadCore();
  assert.equal(ABI_MAJOR, 0);
  assert.equal(ABI_MINOR, 1);
  assert.equal(core.abiVersion(), (0 << 16) | 1);
});

test("the core's nameHash is the TypeScript nameHash", async () => {
  const core = await loadCore();
  for (const name of ["comline", "comline@1", "datagram@2", "packed@1", "jsonrpc@1", "", "naïve"]) {
    assert.deepEqual(core.nameHash(name), { status: Status.OK, hash: nameHash(name) }, name);
  }
});

// ── the core and the TypeScript agree on every name-hash and handshake ──

const CORPUS = new URL("../../test/conformance/vectors/", import.meta.url);
const cases = (feature: string): Case[] =>
  (JSON.parse(readFileSync(new URL(`${feature}.json`, CORPUS), "utf8")) as { cases: Case[] }).cases;

/** mulberry32: a small seeded PRNG, so a failure reproduces. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random string: ASCII, two-, three- and four-byte UTF-8, and lone
 * surrogates (which both sides encode as U+FFFD). */
function randomName(next: () => number): string {
  const pools = [
    [0x20, 0x7f],
    [0x80, 0x800],
    [0x800, 0xd800],
    [0xd800, 0xe000],
    [0xe000, 0x10000],
    [0x10000, 0x110000],
  ] as const;
  const len = Math.floor(next() * 24);
  let s = "";
  for (let i = 0; i < len; i++) {
    const [lo, hi] = pools[next() < 0.6 ? 0 : 1 + Math.floor(next() * (pools.length - 1))]!;
    s += String.fromCodePoint(lo + Math.floor(next() * (hi - lo)));
  }
  return s;
}

const randomU64 = (next: () => number): bigint =>
  (BigInt(Math.floor(next() * 2 ** 32)) << 32n) | BigInt(Math.floor(next() * 2 ** 32));

test("every name-hash vector: the core and the TypeScript both give the vector's bytes", async () => {
  const core = await loadedCore();
  const all = cases("name-hash");
  assert.ok(all.length > 0);
  for (const c of all) {
    const name = c.input!.name as string;
    const want = new DataView(unhex(c.bytes).buffer).getBigUint64(0, true);
    assert.equal(core.nameHash(name), want, c.id);
    assert.equal(nameHash(name), want, c.id);
  }
});

test("every handshake vector: the core and the TypeScript encode, accept and refuse alike", async () => {
  const core = await loadedCore();
  const all = cases("handshake");
  assert.ok(all.some((c) => c.expect === "reject") && all.some((c) => c.expect !== "reject"));
  const valid = core.handshakeEncode(1n, "json@1", "datagram@1", 0);
  for (const c of all) {
    const bytes = unhex(c.bytes);
    if (c.expect === "reject") {
      assert.equal(HandshakeFrame.decode(bytes), undefined, c.id);
      const checked = (await loadCore()).handshakeCheck(valid, bytes);
      assert.deepEqual(checked, { status: Status.ERR_HANDSHAKE, peer: null }, c.id);
      assert.throws(() => core.handshakeCheck(valid, bytes), isKind("handshake"), c.id);
      continue;
    }
    const facts = {
      irHash: BigInt(c.input!.ir_hash as string),
      wireFormat: c.input!.wire_format as string,
      framing: c.input!.framing as string,
      capabilities: c.input!.capabilities as number,
    };
    assert.deepEqual(core.handshakeEncode(facts.irHash, facts.wireFormat, facts.framing, facts.capabilities), bytes, c.id);
    assert.deepEqual(new HandshakeFrame(facts).encode(), bytes, c.id);
    // Decoded alike: the core's peer is the TypeScript's frame.
    const ts = HandshakeFrame.decode(bytes)!;
    const { status, peer } = (await loadCore()).handshakeCheck(bytes, bytes);
    assert.equal(status, Status.OK, c.id);
    assert.deepEqual(peer, {
      irHash: ts.irHash,
      wireFormat: ts.wireFormat,
      framing: ts.framing,
      capabilities: ts.capabilities,
    });
    core.handshakeCheck(bytes, bytes);
  }
});

test("random names: the core's nameHash is the TypeScript's", async () => {
  const core = await loadedCore();
  const next = rng(0xc0471e);
  for (let i = 0; i < 4000; i++) {
    const name = randomName(next);
    assert.equal(core.nameHash(name), nameHash(name), JSON.stringify(name));
  }
});

test("random handshakes: the core and the TypeScript encode alike and agree on every check", async () => {
  const core = await loadedCore();
  const next = rng(0x4a5d5);
  const names = ["json@1", "packed@1", "msgpack@1", "datagram@1", "datagram@2", "jsonrpc@1"];
  const pick = () => (next() < 0.5 ? names[Math.floor(next() * names.length)]! : randomName(next));
  for (let i = 0; i < 3000; i++) {
    const facts = {
      irHash: next() < 0.1 ? -randomU64(next) : randomU64(next), // negatives wrap to 64 bits on both
      wireFormat: pick(),
      framing: pick(),
      capabilities: next() < 0.2 ? undefined : Math.floor(next() * 2 ** 32),
    };
    const ours = core.handshakeEncode(facts.irHash, facts.wireFormat, facts.framing, facts.capabilities);
    assert.deepEqual(ours, new HandshakeFrame(facts).encode(), JSON.stringify({ ...facts, irHash: String(facts.irHash) }));

    // A peer frame: the same, a field changed, a byte flipped, cut or grown.
    let peer: Uint8Array = ours.slice();
    const r = next();
    if (r < 0.2) {
      peer = core.handshakeEncode(facts.irHash, facts.wireFormat, facts.framing, Math.floor(next() * 2 ** 32));
    } else if (r < 0.6) {
      peer[Math.floor(next() * peer.length)]! ^= 1 << Math.floor(next() * 8);
    } else if (r < 0.7) {
      peer = peer.slice(0, Math.floor(next() * peer.length));
    } else if (r < 0.8) {
      const grown = new Uint8Array(peer.length + 1 + Math.floor(next() * 8));
      grown.set(peer);
      peer = grown;
    }
    const tsPeer = HandshakeFrame.decode(peer);
    let tsAgrees = tsPeer !== undefined;
    if (tsPeer) {
      try {
        HandshakeFrame.decode(ours)!.check(tsPeer);
      } catch {
        tsAgrees = false;
      }
    }
    let coreAgrees = true;
    try {
      core.handshakeCheck(ours, peer);
    } catch (e) {
      assert.ok(e instanceof RuntimeError && e.is("handshake"));
      coreAgrees = false;
    }
    assert.equal(coreAgrees, tsAgrees, `case ${i}`);
  }
});

const isKind = (kind: RuntimeErrorKind) => (e: unknown) => e instanceof RuntimeError && e.kind === kind;

test("every status maps to success only when it's OK", () => {
  const mapped: [number, RuntimeErrorKind][] = [
    [Status.ERR_FRAMING, "framing"],
    [Status.ERR_UNKNOWN_FRAMING, "framing"],
    [Status.ERR_HANDSHAKE, "handshake"],
    [Status.ERR_FRAME_TOO_LARGE, "frameTooLarge"],
    [Status.ERR_BUSY, "busy"],
    [Status.ERR_POISONED, "poisoned"],
    // Not errors of their own: the operation's kind.
    [Status.NEED_MORE, "transport"],
    [Status.BUFFER_TOO_SMALL, "transport"],
    [Status.ERR_INVALID_ARGUMENT, "transport"],
    [Status.ERR_STATE, "transport"],
    // Unknown codes, from a newer library or none: errors, never success.
    [3, "transport"],
    [15, "transport"],
    [24, "transport"],
    [255, "transport"],
    [-1, "transport"],
  ];
  for (const [status, kind] of mapped) {
    assert.equal(statusError(status, "transport").kind, kind, `status ${status}`);
  }
  const lib = {
    poisoned: false,
    handshakeCheck: () => ({ status: 99, peer: null }),
  } as unknown as ConstructorParameters<typeof Core>[0];
  assert.throws(() => new Core(lib).handshakeCheck(new Uint8Array(31), new Uint8Array(31)), isKind("handshake"));
});
