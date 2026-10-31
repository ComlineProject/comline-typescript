// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Runs one workload W times to warm up, then K times inside the native
// region (region/region.c), then exits. Run it under callgrind with
// `--collect-atstart=no --toggle-collect=comline_bench_region` and only the
// measured loop is counted; `count.py` does that and divides by K.
//
//     node --allow-natives-syntax --predictable --no-opt bench/count.mjs <workload> <K> [W]
//
// Workloads: noop, {ts,wasm}-request-<bytes>, wasm-request-<bytes>-into,
// {ts,wasm}-name-hash, {ts,wasm}-handshake, binding-handshake,
// ts-duplex-send-<bytes>[-nocopy].
// `ts-duplex-send-<bytes>` is one frame through `duplex()`: `send`, then the
// peer's `recv`, its promises run to completion each iteration (a forced
// microtask checkpoint). `-nocopy` is the same with `send` queueing the
// caller's array itself, as `duplex()` would without its copy: the difference
// is what the `Transport` contract's copy costs.
// `wasm-request-<bytes>-into` is `wasm-request-<bytes>` encoding into one
// reused array (`encodeRequestInto`, comline-runtime PR #64) instead of a
// new one per frame; its TS counterpart is `ts-request-<bytes>`. The TS ones use the built runtime
// (`npm run build`); the wasm ones load the wasm32 build of
// `comline-runtime-ffi` and its JS glue from COMLINE_WASM and COMLINE_GLUE
// (default: `bench/.core/`). `binding-handshake` is the handshake as
// `ComlineHandshake` runs it: the runtime's binding (`src/core/core.ts`) over
// the vendored `core/`.
//
// COMLINE_REGION is the path of the built `region.node`; without it the loop
// runs uncounted (handy for checking that a workload runs at all).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

const [name, kArg, wArg = "1000"] = process.argv.slice(2);
const K = Number(kArg);
const W = Number(wArg);
if (!name || !Number.isInteger(K) || K < 0 || !Number.isInteger(W) || W < 0) {
  console.error("usage: count.mjs <workload> <K> [W]; workloads: noop, {ts,wasm}-request-<bytes>, wasm-request-<bytes>-into, {ts,wasm}-name-hash, {ts,wasm}-handshake, binding-handshake, ts-duplex-send-<bytes>[-nocopy]");
  process.exit(2);
}

const body = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
let sink = 0; // every workload folds its result in, so none is dead code

// Runs every queued promise reaction now, so an async workload finishes
// inside the iteration (and the region) that started it.
let runMicrotasks;
try {
  runMicrotasks = new Function("%PerformMicrotaskCheckpoint()");
} catch {
  console.error("count.mjs: run with --allow-natives-syntax");
  process.exit(2);
}

async function ts() {
  const rt = await import("../dist/src/index.js");
  const hs = await import("../dist/src/handshake.js");
  const framing = new rt.Datagram2Framing();
  const facts = { irHash: 0x0123456789abcdefn, wireFormat: "packed@1", framing: "datagram@2" };
  const ours = new hs.HandshakeFrame(facts);
  return {
    request: (n) => {
      const params = body(n);
      const call = { id: 0x0203 };
      let id = 0n;
      return () => {
        const frame = framing.encodeRequest(5, call, id++, params);
        const decoded = framing.decode(frame);
        sink ^= decoded.request.params.length ^ frame.length;
      };
    },
    duplexSend: (n, copy) => {
      const frame = body(n);
      const [a, b] = rt.duplex();
      if (!copy) {
        // `send` without the copy (`outbox` is private to TypeScript only).
        a.send = (f) => {
          a.outbox.push(f);
          return Promise.resolve();
        };
      }
      const got = (f) => {
        sink ^= f.length;
      };
      return () => {
        void a.send(frame);
        b.recv().then(got);
        runMicrotasks();
      };
    },
    "ts-name-hash": () => {
      sink ^= Number(hs.nameHash("datagram@2") & 0xffn);
    },
    "ts-handshake": () => {
      const bytes = new hs.HandshakeFrame(facts).encode();
      const peer = hs.HandshakeFrame.decode(bytes);
      ours.check(peer);
      sink ^= bytes.length;
    },
  };
}

async function wasm() {
  const glue = await import(
    process.env.COMLINE_GLUE ? pathToFileURL(process.env.COMLINE_GLUE).href : "./.core/comline.mjs"
  );
  const wasmPath = process.env.COMLINE_WASM ?? new URL("./.core/comline_runtime_ffi.wasm", import.meta.url);
  const lib = await glue.instantiate(readFileSync(wasmPath));
  const open = () => {
    const { status, connection } = lib.connectionNew({
      framing: "datagram@2",
      handshake: glue.Handshake.NONE,
    });
    if (status !== glue.Status.OK) throw new Error(`connectionNew: ${status}`);
    return connection;
  };
  const ours = lib.handshakeEncode(0x0123456789abcdefn, "packed@1", "datagram@2", 0, 64).bytes;
  return {
    request: (n) => {
      const params = body(n);
      const client = open();
      const server = open();
      const cap = n + 64;
      // One-way, so no call waits and the state stays the same size; the
      // `datagram@2` frame is the same bytes either way.
      return () => {
        const out = client.encodeRequest(5, 0x0203, "", 0, params, cap);
        const fed = server.feed(out.bytes);
        if (fed.status !== glue.Status.OK) throw new Error(`feed: ${fed.status}`);
        sink ^= fed.event.body.len ^ out.bytes.length;
      };
    },
    requestInto: (n) => {
      const params = body(n);
      const client = open();
      const server = open();
      const dest = new Uint8Array(n + 64);
      return () => {
        const out = client.encodeRequestInto(dest, 5, 0x0203, "", 0, params);
        if (out.status !== glue.Status.OK) throw new Error(`encode: ${out.status}`);
        const fed = server.feed(dest.subarray(0, out.written));
        if (fed.status !== glue.Status.OK) throw new Error(`feed: ${fed.status}`);
        sink ^= fed.event.body.len ^ out.written;
      };
    },
    "wasm-name-hash": () => {
      sink ^= Number(lib.nameHash("datagram@2").hash & 0xffn);
    },
    "wasm-handshake": () => {
      const bytes = lib.handshakeEncode(0x0123456789abcdefn, "packed@1", "datagram@2", 0, 64).bytes;
      const checked = lib.handshakeCheck(ours, bytes);
      if (checked.status !== glue.Status.OK) throw new Error(`check: ${checked.status}`);
      sink ^= bytes.length;
    },
  };
}

async function binding() {
  const { loadedCore } = await import("../dist/src/core/core.js");
  const core = await loadedCore();
  const ours = core.handshakeEncode(0x0123456789abcdefn, "packed@1", "datagram@2", 0);
  return {
    "binding-handshake": () => {
      const bytes = core.handshakeEncode(0x0123456789abcdefn, "packed@1", "datagram@2", undefined);
      core.handshakeCheck(ours, bytes);
      sink ^= bytes.length;
    },
  };
}

const workloads = name.startsWith("wasm-")
  ? await wasm()
  : name.startsWith("binding-")
    ? await binding()
    : name === "noop"
      ? { noop: () => {} }
      : await ts();
const sized = /^(?:ts|wasm)-request-(\d+)$/.exec(name);
const into = /^wasm-request-(\d+)-into$/.exec(name);
const duplexSend = /^ts-duplex-send-(\d+)(-nocopy)?$/.exec(name);
const work = sized
  ? workloads.request(Number(sized[1]))
  : into
    ? workloads.requestInto(Number(into[1]))
    : duplexSend
      ? workloads.duplexSend(Number(duplexSend[1]), !duplexSend[2])
      : workloads[name];
if (!work) {
  console.error(`unknown workload ${name}`);
  process.exit(2);
}

function measured(n) {
  for (let i = 0; i < n; i++) work();
}

// The loop itself is never optimised: otherwise V8 compiles it (by OSR or on
// a later entry) whenever its budget runs out, which can fall inside the
// region. It stays at a baseline tier, a constant few instructions per
// iteration for every workload (`noop` measures it).
try {
  new Function("f", "%NeverOptimizeFunction(f)")(measured);
} catch {
  console.error("count.mjs: run with --allow-natives-syntax, or the loop may be compiled in the region");
  process.exit(2);
}

// Warm up through the same loop, over several calls.
const ROUNDS = 4;
for (let r = 0; r < ROUNDS; r++) measured(Math.ceil(W / ROUNDS));

// Start the measured loop on an empty young generation, so where the first
// scavenge falls doesn't depend on what start-up allocated. Two full
// collections: the second finishes the first's lazy sweeping, which would
// otherwise land in the loop in varying amounts.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");
gc();
gc();

if (process.env.COMLINE_REGION) {
  createRequire(import.meta.url)(process.env.COMLINE_REGION).region(() => measured(K));
} else {
  measured(K);
}
if (sink === 0x7fffffff) console.log("");
