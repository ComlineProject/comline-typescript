// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The shared benchmarks: the work every runtime measures, from the vendored
// definitions in test/conformance/benches/ (ComlineProject/runtime's
// runtime/conformance/benches/), under the ids its README gives. Each id maps
// to one iteration's work, everything it reads built here, outside it.
// `count.mjs` runs them by id; `node bench/shared.mjs` lists the ids this
// runtime measures, each with its iterations. Left out: msgpack@1 (not shipped) and `comline2/*` (the
// `comline@2` hello runs on the wasm core, not in TypeScript).

import { readFileSync } from "node:fs";

const BENCHES = new URL("../test/conformance/benches/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, BENCHES), "utf8"));

const FORMATS = ["json@1", "packed@1"];

/** A `generate` value expanded, as the benches README describes. */
function expand(value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== "object") return value;
  if ("generate" in value) {
    const { count, item } = value.generate;
    return { array: Array.from({ length: count }, (_, i) => instance(item, i)) };
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
}

function instance(item, i) {
  if (Array.isArray(item)) return item.map((x) => instance(x, i));
  if (item === null || typeof item !== "object") return item;
  if ("start" in item && "step" in item) {
    const n = item.start + item.step * i;
    return item.modulo === undefined ? n : ((n % item.modulo) + item.modulo) % item.modulo;
  }
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, instance(v, i)]));
}

/** Every id this runtime measures, in the definitions' order. */
export function ids() {
  const out = [];
  const formats = read("formats.json");
  for (const op of ["encode", "decode"])
    for (const shape of formats.shapes)
      for (const format of formats.formats.filter((f) => FORMATS.includes(f)))
        out.push(`format/${op}/${shape.id}/${format}`);
  const framings = read("framings.json");
  for (const op of ["encode", "decode"])
    for (const framing of framings.framings)
      for (const size of framings.payload_sizes) out.push(`framing/${op}/${framing}/${size}`);
  for (const op of read("handshake.json").ops) out.push(`handshake/${op}`);
  out.push("connection/step");
  return out;
}

/**
 * The workload for `id`: `{ work, async }`. `sink(x)` takes each result, so
 * none is dead code; `drain()` runs queued promise reactions (an async
 * workload's).
 */
export async function workload(id, sink, drain) {
  const rt = await import("../dist/src/index.js");
  const { toJs, layoutOfType } = await import("../dist/test/values.js");
  const [group, op, a, b] = id.split("/");
  const codecs = { "json@1": () => new rt.JsonCodec(), "packed@1": () => new rt.PackedCodec() };
  const shapeOf = (name) => {
    const shape = read("formats.json").shapes.find((s) => s.id === name);
    if (!shape) throw new Error(`no shape ${name}`);
    return { value: toJs(expand(shape.value)), layout: layoutOfType(shape.type) };
  };

  if (group === "format" && (op === "encode" || op === "decode") && codecs[b]) {
    const codec = codecs[b]();
    const { value, layout } = shapeOf(a);
    const bytes = codec.encode(value, layout);
    if (op === "encode") return { work: () => sink(codec.encode(value, layout).length) };
    return { work: () => sink(codec.decode(bytes, layout) === undefined ? 0 : 1) };
  }

  if (group === "framing" && (op === "encode" || op === "decode")) {
    const { frame: def, payload_sizes } = read("framings.json");
    const size = Number(b);
    if (!payload_sizes.includes(size)) throw new Error(`no payload size ${b}`);
    const payload = new TextEncoder().encode(`"${def.payload_fill.repeat(size - 2)}"`);
    const requestId = BigInt(def.request_id);
    let encode, decode;
    if (a === "datagram@1" || a === "jsonrpc@1") {
      const f = a === "datagram@1" ? new rt.DatagramFraming() : new rt.JsonRpcFraming();
      encode = () => f.encodeResponseOk(requestId, payload);
      decode = (frame) => f.decodeResponse(frame);
    } else if (a === "datagram@2" || a === "datagram@3") {
      const f = a === "datagram@2" ? new rt.Datagram2Framing() : new rt.Datagram3Framing();
      const reply = { ok: payload };
      encode = () => f.encodeReply(def.protocol, requestId, reply);
      decode = (frame) => f.decode(frame);
    } else {
      throw new Error(`no framing ${a}`);
    }
    if (op === "encode") return { work: () => sink(encode().length) };
    const frame = encode();
    if (!decode(frame)) throw new Error(`${id}: the frame doesn't decode`);
    return { work: () => sink(decode(frame) ? 1 : 0) };
  }

  if (group === "handshake") {
    const { frame } = read("handshake.json");
    const facts = {
      irHash: BigInt(frame.ir_hash),
      wireFormat: frame.wire_format,
      framing: frame.framing,
      capabilities: frame.capabilities,
    };
    const ours = new rt.HandshakeFrame(facts);
    const bytes = ours.encode();
    const peer = rt.HandshakeFrame.decode(bytes);
    if (op === "encode") return { work: () => sink(new rt.HandshakeFrame(facts).encode().length) };
    if (op === "decode") return { work: () => sink(rt.HandshakeFrame.decode(bytes).capabilities) };
    if (op === "check")
      return {
        work: () => {
          ours.check(peer);
          sink(1);
        },
      };
  }

  if (id === "connection/step") return connectionStep(rt, shapeOf, sink, drain);

  throw new Error(`unknown or unsupported shared bench ${id}`);
}

// One call on a connection and its reply: the call's params encoded and
// framed, then the reply frame received and matched to it. The peer is a
// transport that answers each request with the reply to it, its frames built
// beforehand (request ids run 0, 1, ...), so only the connection's work is
// in the iteration (and the transport's promise handoff).
async function connectionStep(rt, shapeOf, sink, drain) {
  const def = JSON.parse(readFileSync(new URL("connection.json", BENCHES), "utf8"));
  if (def.framing !== "datagram@2" || def.format !== "packed@1") throw new Error("connection/step: new framing or format");
  const framing = new rt.Datagram2Framing();
  const { value, layout } = shapeOf(def.params);
  const payload = Uint8Array.from(Buffer.from(def.reply.payload, "hex"));
  if (def.reply.kind !== "ok") throw new Error("connection/step: a reply other than ok");
  const REPLIES = 40000;
  const replies = Array.from({ length: REPLIES }, (_, i) => framing.encodeReply(def.protocol, BigInt(i), { ok: payload }));
  let sent = 0;
  let parked;
  const queue = [];
  const transport = {
    send() {
      if (sent >= REPLIES) throw new Error("connection/step: out of prebuilt replies");
      const reply = replies[sent++];
      if (parked) {
        const r = parked;
        parked = undefined;
        r(reply);
      } else queue.push(reply);
      return Promise.resolve();
    },
    recv() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((r) => (parked = r));
    },
  };
  const conn = rt.Connection.unverified(transport, new rt.PackedCodec(), framing);
  if (conn.wire !== undefined) throw new Error("connection/step: the connection is on the core");
  const call = rt.call(def.call.id, def.call.name);
  const options = { layout };
  let done = 0;
  const got = (envelope) => {
    sink(envelope.ok.length);
    done++;
  };
  return {
    async: true,
    work: () => {
      const before = done;
      conn.call(def.protocol, call, value, options).then(got);
      drain();
      if (done !== before + 1) throw new Error("connection/step: the reply didn't arrive in the iteration");
    },
  };
}

/**
 * The measured and warm-up iterations for `id`, `[K, W, K opt, W opt]`:
 * fewer for the heaviest, which take milliseconds an iteration at `--no-opt`
 * and a hundred times that under callgrind; with the optimizing tier on, a
 * warm-up long enough for TurboFan to have compiled the work (checked: a
 * longer one, 20000 or 100, gives the same counts within 1%).
 */
export function iterations(id) {
  if (id.includes("/large-array/")) return [20, 40, 20, 40];
  if (id.endsWith("/65536")) return [200, 200, 200, 1000];
  return [1000, 1000, 1000, 5000];
}

// `node bench/shared.mjs` prints each id with its `K W Kopt Wopt`.
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const id of ids()) console.log(id, ...iterations(id));
}
