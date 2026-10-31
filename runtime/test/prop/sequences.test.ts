// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Connection sequences: a random list of events (local calls, frames from
 * the peer, abandoned calls, replies to the peer's requests) run through
 * this runtime's `Connection` and through `comline-reference`'s `session`
 * op, which drives the Rust runtime's sans-IO `connection::State`. Each
 * event's step must be the same on both sides: the frame a call writes and
 * its request id, what a received frame means (a request, the reply to a
 * waiting call, a stale reply, a malformed frame), and the frame a reply
 * writes. Under `datagram@2` and `jsonrpc@1`, against the reference's
 * ordered (nested, blocking) and unordered (async) state.
 *
 * TypeScript has no sans-IO state: its `Connection` owns the read loop. The
 * harness drives one over an in-memory transport and reads its steps off
 * what it does:
 *
 * - **a call** is `Connection.call` (or `notify`, one-way), whose frame the
 *   transport sees at once. Its request id is read back from the frame; a
 *   JSON-RPC notification's isn't on the wire, so it's compared through the
 *   next call's.
 * - **a received frame** is what the connection's framing decoded it to
 *   (the framing is wrapped to record that) and what the connection did: a
 *   call's promise settling is the reply event, nothing settling is `stale`,
 *   and the connection closing is `framing`. TypeScript ends the connection
 *   on a malformed frame, as both Rust drivers do (the State itself changes
 *   nothing, and leaves that to its driver), so a sequence ends there. A
 *   malformed frame is only ever generated last.
 * - **an abandon** fires the call's timeout: every waited-on call is made
 *   with `timeoutMs`, and the harness keeps its timer instead of scheduling
 *   it.
 * - **a reply to the peer's request** is the handler finishing with that
 *   envelope. TypeScript serves the peer's requests one at a time, in order
 *   (as the Rust drivers do; the State doesn't schedule handlers), so a
 *   handler for a request answered before an earlier one waits its turn, and
 *   the frame its step compares is the one the connection sends for that
 *   request whenever it does. At the end every unanswered handler finishes
 *   with no reply, so the rest are served. The handlers record what they're
 *   dispatched, which must be the requests the framing decoded, in order.
 *
 * Kept within what the State decides: the peer's requests name a protocol
 * this side provides and a call it has (a provider lookup that fails is the
 * driver's fault reply, not the State's), and a request id doesn't reach
 * `u64::MAX` (the session starts at 0, as the State does, so the wrap at
 * 2^64 can't be reached in a sequence).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import {
  Connection,
  Datagram2Framing,
  JsonRpcConnectionFraming,
  RuntimeError,
  type Call,
  type Codec,
  type ConnectionFraming,
  type Dispatch,
  type Envelope,
  type Frame,
  type Kind,
  type Reply,
  type Transport,
} from "../../src/index.js";
import { FRAMING_DATAGRAM2, FRAMING_JSONRPC } from "../../src/index.js";
import { jsonEqual, parseJson } from "../../src/json.js";
import { currentCore, loadedCore } from "../../src/core/core.js";
import { Wire } from "../../src/core/wire.js";
import { hex, unhex } from "../ops.js";
import { stringify } from "../reference.js";
import type { Json } from "../values.js";
import { known, params, withReference } from "./harness.js";

type FramingName = typeof FRAMING_DATAGRAM2 | typeof FRAMING_JSONRPC;
type Obj = { [key: string]: Json };

/** A provider's calls, and the names calls use. */
const METHODS = ["ping", "send", "chat.Chat/send", "a", "b", "c.D/e", "f", "g"] as const;
/** The protocols this side provides, which the peer's requests name. */
const PROVIDED = 4;
/**
 * JSON texts, for bodies under `jsonrpc@1`, whose frames carry them inline:
 * written as `serde_json` writes them back, with no spaces.
 */
const JSON_TEXTS = ["null", "1", '"x"', "[1,2]", '{"a":true}', "-3.5"] as const;

const utf8 = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

function framingOf(name: FramingName): ConnectionFraming {
  return name === FRAMING_DATAGRAM2 ? new Datagram2Framing() : new JsonRpcConnectionFraming();
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

/** A body: raw bytes under `datagram@2`, one of `JSON_TEXTS` under `jsonrpc@1`. */
interface Body {
  raw: number[];
  json: number;
}

type EnvelopeIn = { kind: "ok"; body: Body } | { kind: "err"; id: number; body: Body } | { kind: "fault" };

/** Which request id a reply from the peer, or an abandon, names. */
type Target =
  /** A waiting call; when ordered, the innermost unless `deep`. Else `spent`. */
  | { to: "waiting"; deep: boolean; pick: number }
  /** An id handed out and no longer waited on: answered, abandoned, one-way. Else `never`. */
  | { to: "spent"; pick: number }
  /** An id not handed out yet: the next one plus `ahead`. */
  | { to: "never"; ahead: bigint };

type Step =
  | { step: "call"; protocol: number; callId: number; method: number; oneWay: boolean; params: Body }
  | { step: "request"; protocol: number; callId: number; method: number; requestId: bigint; oneWay: boolean; params: Body }
  | { step: "reply"; target: Target; protocol: number; envelope: EnvelopeIn }
  /** This side answers one of the peer's requests it hasn't answered. */
  | { step: "answer"; pick: number; envelope: EnvelopeIn }
  | { step: "abandon"; target: Target };

/** A frame neither side reads, chosen per framing. */
type Malformed =
  | { kind: "empty" }
  /** `datagram@2`: a kind byte other than 0 or 1. `jsonrpc@1`: text that can't start JSON. */
  | { kind: "bad-start"; first: number; rest: number[] }
  /** A valid reply frame cut short by at least one byte. */
  | { kind: "truncated"; cut: number; requestId: bigint; envelope: EnvelopeIn }
  /** `datagram@2`: an unknown envelope tag. `jsonrpc@1`: a reply with no `id`. */
  | { kind: "bad-reply"; requestId: bigint; tag: number };

interface Sequence {
  steps: Step[];
  malformed: Malformed | undefined;
}

const u16 = fc.integer({ min: 0, max: 0xffff });
const u64 = fc.oneof(fc.bigInt({ min: 0n, max: 1000n }), fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }));
const bodyArb: fc.Arbitrary<Body> = fc.record({
  raw: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 12 }),
  json: fc.nat(JSON_TEXTS.length - 1),
});
const envelopeArb: fc.Arbitrary<EnvelopeIn> = fc.oneof(
  bodyArb.map((body): EnvelopeIn => ({ kind: "ok", body })),
  fc.record({ id: u16, body: bodyArb }).map((e): EnvelopeIn => ({ kind: "err", ...e })),
  fc.constant<EnvelopeIn>({ kind: "fault" }),
);
const targetArb: fc.Arbitrary<Target> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .record({ deep: fc.integer({ min: 0, max: 9 }).map((n) => n === 0), pick: fc.nat() })
      .map((t): Target => ({ to: "waiting", ...t })),
  },
  { weight: 2, arbitrary: fc.nat().map((pick): Target => ({ to: "spent", pick })) },
  {
    weight: 1,
    arbitrary: fc
      .oneof(fc.bigInt({ min: 0n, max: 1000n }), fc.constant(1n << 62n))
      .map((ahead): Target => ({ to: "never", ahead })),
  },
);
const method = fc.nat(METHODS.length - 1);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .record({
        protocol: fc.oneof(fc.integer({ min: 0, max: 3 }), u16),
        callId: u16,
        method,
        oneWay: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
        params: bodyArb,
      })
      .map((s): Step => ({ step: "call", ...s })),
  },
  {
    weight: 3,
    arbitrary: fc
      .record({
        protocol: fc.nat(PROVIDED - 1),
        callId: fc.nat(METHODS.length - 1),
        method,
        requestId: u64,
        oneWay: fc.boolean(),
        params: bodyArb,
      })
      .map((s): Step => ({ step: "request", ...s })),
  },
  {
    weight: 5,
    arbitrary: fc
      .record({ target: targetArb, protocol: fc.oneof(fc.integer({ min: 0, max: 3 }), u16), envelope: envelopeArb })
      .map((s): Step => ({ step: "reply", ...s })),
  },
  {
    weight: 4,
    arbitrary: fc.record({ pick: fc.nat(), envelope: envelopeArb }).map((s): Step => ({ step: "answer", ...s })),
  },
  { weight: 2, arbitrary: targetArb.map((target): Step => ({ step: "abandon", target })) },
);

const malformedArb: fc.Arbitrary<Malformed> = fc.oneof(
  fc.constant<Malformed>({ kind: "empty" }),
  fc
    .record({ first: fc.nat(), rest: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 16 }) })
    .map((m): Malformed => ({ kind: "bad-start", ...m })),
  fc.record({ cut: fc.nat(), requestId: u64, envelope: envelopeArb }).map((m): Malformed => ({ kind: "truncated", ...m })),
  fc.record({ requestId: u64, tag: fc.nat() }).map((m): Malformed => ({ kind: "bad-reply", ...m })),
);

const sequenceArb: fc.Arbitrary<Sequence> = fc.record({
  steps: fc.array(stepArb, { maxLength: 32 }),
  malformed: fc.oneof(
    { weight: 3, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: malformedArb },
  ),
});

/** A session: the events the reference takes, and which of the peer's requests each answer answers. */
interface Session {
  framing: FramingName;
  ordered: boolean;
  events: Obj[];
  /** For a `reply` event, by its index: the ordinal of the request it answers among those received. */
  answers: Map<number, number>;
}

function bodyBytes(framing: FramingName, b: Body): Uint8Array {
  return framing === FRAMING_JSONRPC ? utf8.encode(JSON_TEXTS[b.json]!) : Uint8Array.from(b.raw);
}

function envelopeOf(framing: FramingName, e: EnvelopeIn): Envelope {
  if (e.kind === "ok") return { ok: bodyBytes(framing, e.body) };
  if (e.kind === "err") return { err: { id: e.id, body: bodyBytes(framing, e.body) } };
  return { fault: true };
}

/** An envelope in the vectors' form. */
function vectorEnvelope(e: Envelope): Obj {
  if ("ok" in e) return { kind: "ok", payload: hex(e.ok) };
  if ("err" in e) return { kind: "err", id: e.err.id, body: hex(e.err.body) };
  return { kind: "fault" };
}

function fromVector(e: Obj): Envelope {
  if (e.kind === "ok") return { ok: unhex(e.payload as string) };
  if (e.kind === "err") return { err: { id: e.id as number, body: unhex(e.body as string) } };
  return { fault: true };
}

/**
 * The events a sequence makes, kept to the model a reader of the State
 * would hold: the next request id and the ids waiting on a reply.
 */
function concretize(framing: FramingName, ordered: boolean, seq: Sequence): Session {
  const f = framingOf(framing);
  const json = framing === FRAMING_JSONRPC;
  let next = 0n;
  const waiting: bigint[] = [];
  const spent: bigint[] = [];
  const received: { protocol: number; requestId: bigint; oneWay: boolean; answered: boolean }[] = [];
  const events: Obj[] = [];
  const answers = new Map<number, number>();

  const resolve = (t: Target): { id: bigint; at?: number } => {
    if (t.to === "waiting" && waiting.length > 0) {
      let at: number;
      if (!ordered) at = t.pick % waiting.length;
      else if (t.deep && waiting.length > 1) at = t.pick % (waiting.length - 1);
      else at = waiting.length - 1;
      return { id: waiting[at]!, at };
    }
    if (t.to !== "never" && spent.length > 0) return { id: spent[t.pick % spent.length]! };
    return { id: next + (t.to === "never" ? t.ahead : 0n) };
  };
  const stopWaiting = (at: number) => spent.push(...waiting.splice(at, 1));

  for (const s of seq.steps) {
    switch (s.step) {
      case "call": {
        events.push({
          call: {
            protocol: s.protocol,
            call_id: s.callId,
            method: METHODS[s.method]!,
            one_way: s.oneWay,
            params: hex(bodyBytes(framing, s.params)),
          },
        });
        (s.oneWay ? spent : waiting).push(next++);
        break;
      }
      case "request": {
        // Only JSON-RPC can say a request wants no reply.
        const oneWay = json && s.oneWay;
        const requestId = oneWay ? 0n : s.requestId;
        const call: Call = { id: s.callId, name: METHODS[s.method]! };
        events.push({ receive: hex(f.encodeRequest(s.protocol, call, requestId, bodyBytes(framing, s.params), oneWay)) });
        received.push({ protocol: s.protocol, requestId, oneWay, answered: false });
        break;
      }
      case "reply": {
        const { id, at } = resolve(s.target);
        events.push({ receive: hex(f.encodeReply(s.protocol, id, envelopeOf(framing, s.envelope))) });
        // An ordered State refuses a reply that skips the innermost call, and keeps waiting.
        if (at !== undefined && (!ordered || at === waiting.length - 1)) stopWaiting(at);
        break;
      }
      case "answer": {
        const open = received.flatMap((r, i) => (!r.oneWay && !r.answered ? [i] : []));
        if (open.length === 0) break;
        const r = open[s.pick % open.length]!;
        received[r]!.answered = true;
        answers.set(events.length, r);
        events.push({
          reply: {
            protocol: json ? 0 : received[r]!.protocol,
            request_id: String(received[r]!.requestId),
            envelope: vectorEnvelope(envelopeOf(framing, s.envelope)),
          },
        });
        break;
      }
      case "abandon": {
        const { id, at } = resolve(s.target);
        if (at !== undefined) stopWaiting(at);
        events.push({ abandon: String(id) });
        break;
      }
    }
  }

  const m = seq.malformed;
  if (m) {
    let frame: Uint8Array;
    if (m.kind === "empty") frame = new Uint8Array(0);
    else if (m.kind === "bad-start") {
      const first = json ? "x]}:,".charCodeAt(m.first % 5) : 2 + (m.first % 254);
      frame = Uint8Array.from([first, ...m.rest]);
    } else if (m.kind === "truncated") {
      const valid = f.encodeReply(0, m.requestId, envelopeOf(framing, m.envelope));
      frame = valid.subarray(0, m.cut % valid.length);
    } else if (json) {
      frame = utf8.encode('{"jsonrpc":"2.0","result":1}');
    } else {
      const valid = f.encodeReply(0, m.requestId, { fault: true });
      valid[valid.length - 1] = 3 + (m.tag % 253);
      frame = valid;
    }
    events.push({ receive: hex(frame) });
  }
  return { framing, ordered, events, answers };
}

// ---------------------------------------------------------------------------
// Running a session through TypeScript's Connection
// ---------------------------------------------------------------------------

/** Params already encoded, written as they are: as the reference's `Preencoded`. */
const PREENCODED: Codec = {
  name: "preencoded",
  encode: (value) => value as Uint8Array,
  decode: () => {
    throw new Error("the sessions decode nothing");
  },
};

/** An in-memory transport whose far end is the harness. */
class Pipe implements Transport {
  onSend: (frame: Uint8Array) => void = () => {};
  private readonly inbox: Uint8Array[] = [];
  private waiter: ((frame: Uint8Array) => void) | undefined;

  send(frame: Uint8Array): Promise<void> {
    this.onSend(frame.slice());
    return Promise.resolve();
  }

  recv(): Promise<Uint8Array> {
    const frame = this.inbox.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve) => (this.waiter = resolve));
  }

  push(frame: Uint8Array): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) waiter(frame);
    else this.inbox.push(frame);
  }
}

/** The connection's framing, recording what it decodes each frame to. */
class Recording implements ConnectionFraming {
  readonly name: string;
  readonly decoded: (Frame | undefined)[] = [];
  onDecode: (decoded: Frame | undefined) => void = () => {};

  constructor(private readonly inner: ConnectionFraming) {
    this.name = inner.name;
  }

  encodeRequest(protocol: number, call: Call, requestId: bigint, params: Uint8Array, oneWay?: boolean): Uint8Array {
    return this.inner.encodeRequest(protocol, call, requestId, params, oneWay);
  }

  encodeReply(protocol: number, requestId: bigint, reply: Envelope): Uint8Array {
    return this.inner.encodeReply(protocol, requestId, reply);
  }

  decode(frame: Uint8Array): Frame | undefined {
    const decoded = this.inner.decode(frame);
    this.decoded.push(decoded);
    this.onDecode(decoded);
    return decoded;
  }
}

/** Lets the connection's microtasks and pending reads run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface LocalCall {
  /** Its request id, read off its frame; not there for a notification. */
  id: bigint | undefined;
  /** Fires its timeout. */
  fire: (() => void) | undefined;
  settled: { envelope: Envelope } | { error: unknown } | undefined;
}

interface PeerRequest {
  frame: Extract<Frame, { kind: "request" }>;
  /** The envelope this side answers with, once the session says. */
  answer: Envelope | "none" | undefined;
  /** Finishes the handler, when it's waiting on its answer. */
  release: ((answer: Envelope | "none") => void) | undefined;
  /** What the connection sent for it. */
  sent: Uint8Array[];
}

/**
 * What the core's wires decode, for {@link runTs} on the core: `Wire.feed`,
 * recorded, as the `Recording` framing records the TypeScript's decode.
 */
let onWireFeed: ((decoded: Frame | undefined) => void) | undefined;
const feed = Wire.prototype.feed;
Wire.prototype.feed = function (this: Wire, frame: Uint8Array) {
  const decoded = feed.call(this, frame);
  // A stale reply reads as a reply nobody waits on, as the TypeScript's does.
  onWireFeed?.(decoded === "stale" ? { kind: "reply", protocol: undefined, requestId: -1n, envelope: { fault: true } } : decoded);
  return decoded;
};

/**
 * Run `session` through a `Connection`, one step per event, on the core
 * (`onCore`: a built-in framing, the core loaded) or the TypeScript (a
 * custom framing, which never runs on it). Steps after the connection
 * closes aren't there.
 */
async function runTs(session: Session, onCore: boolean): Promise<Json[]> {
  const inner = framingOf(session.framing);
  const framing = new Recording(inner);
  if (onCore) {
    await loadedCore();
    onWireFeed = (d) => {
      framing.decoded.push(d);
      framing.onDecode(d);
    };
  } else onWireFeed = undefined;
  const json = session.framing === FRAMING_JSONRPC;
  const pipe = new Pipe();
  const calls: LocalCall[] = [];
  const requests: PeerRequest[] = [];
  const dispatched: { protocol: number; index: number; params: string }[] = [];
  const stray: string[] = [];
  let settledNow: number[] = [];
  let callFrame: Uint8Array | undefined;
  let inCall = false;
  let servedBy: number | undefined;

  pipe.onSend = (frame) => {
    if (inCall) callFrame = frame;
    else if (servedBy !== undefined) requests[servedBy]!.sent.push(frame);
    else stray.push(hex(frame));
  };

  // Before the connection acts on it, so its handler finds it.
  framing.onDecode = (d) => {
    if (d?.kind === "request") requests.push({ frame: d, answer: undefined, release: undefined, sent: [] });
  };

  const connection = Connection.unverified(pipe, PREENCODED, onCore ? inner : framing);
  // On the core exactly when asked: `unverified` uses it once it's loaded.
  assert.equal((connection as unknown as { wire: unknown }).wire !== undefined, onCore && currentCore() !== undefined);
  let closed = false;
  void connection.closed.then(() => (closed = true));

  const provider = (protocol: number): Dispatch => ({
    calls: () => METHODS,
    dispatch: () => Promise.reject(new Error("served only on a connection")),
    async dispatchWith(kind: Kind, params: Uint8Array, reply: Reply): Promise<void> {
      const r = dispatched.length;
      dispatched.push({ protocol, index: "id" in kind ? kind.id : -1, params: hex(params) });
      const request = requests[r];
      if (!request || request.frame.oneWay) return;
      const answer = request.answer ?? (await new Promise<Envelope | "none">((resolve) => (request.release = resolve)));
      request.release = undefined;
      if (answer === "none") return;
      if ("ok" in answer) reply.ok(answer.ok);
      else if ("err" in answer) reply.err(answer.err.id, answer.err.body);
      else reply.fault();
      servedBy = r;
    },
  });
  for (let p = 0; p < PROVIDED; p++) connection.provide(p, provider(p));

  /** A reply's step, whose frame the connection may send later. */
  type Unserved = { unserved: number };
  const steps: (Json | Unserved)[] = [];
  for (const [i, event] of session.events.entries()) {
    settledNow = [];
    const decodedBefore = framing.decoded.length;
    let step: Json | Unserved;

    if ("call" in event) {
      const c = event.call as Obj;
      const ordinal = calls.length;
      const local: LocalCall = { id: undefined, fire: undefined, settled: undefined };
      calls.push(local);
      const call: Call = { id: c.call_id as number, name: c.method as string };
      const params = unhex(c.params as string);
      callFrame = undefined;
      inCall = true;
      if (c.one_way) {
        connection.notify(c.protocol as number, call, params).catch(() => {});
      } else {
        // The call's timeout timer, kept here instead of scheduled: an
        // abandon fires it.
        const setTimer = globalThis.setTimeout;
        globalThis.setTimeout = ((fire: () => void) => {
          local.fire = fire;
          return {};
        }) as unknown as typeof setTimeout;
        try {
          connection.call(c.protocol as number, call, params, { timeoutMs: 1 }).then(
            (envelope) => {
              local.settled = { envelope };
              settledNow.push(ordinal);
            },
            (error: unknown) => {
              local.settled = { error };
              settledNow.push(ordinal);
            },
          );
        } finally {
          globalThis.setTimeout = setTimer;
        }
      }
      inCall = false;
      const frame = callFrame as Uint8Array | undefined;
      const decoded = frame && inner.decode(frame);
      if (decoded?.kind === "request" && !(json && c.one_way)) local.id = decoded.request.requestId;
      await flush();
      step = frame
        ? { frame: hex(frame), ...(local.id !== undefined ? { request_id: String(local.id) } : {}) }
        : { ts: "sent no frame" };
    } else if ("receive" in event) {
      pipe.push(unhex(event.receive as string));
      await flush();
      const decoded = framing.decoded.slice(decodedBefore);
      const d = decoded[0];
      if (decoded.length !== 1) step = { ts: `read ${decoded.length} frames` };
      else if (d === undefined) {
        if (!closed) step = { ts: "refused the frame and stayed open" };
        else {
          step = { error: "framing" };
          // Closing, the connection fails every waiting call.
          settledNow = settledNow.filter((o) => {
            const settled = calls[o]!.settled;
            return !(settled && "error" in settled && settled.error instanceof RuntimeError && settled.error.is("transport"));
          });
        }
      }
      else if (d.kind === "request") {
        const r = d.request;
        step = {
          event: {
            request: {
              ...(d.protocol !== undefined ? { protocol: d.protocol } : {}),
              ...("id" in r.call ? { call_id: r.call.id } : { method: r.call.name }),
              request_id: String(r.requestId),
              one_way: d.oneWay,
              params: hex(r.params),
            },
          },
        };
      } else if (settledNow.length === 0) step = { event: "stale" };
      else {
        const ordinal = settledNow.shift()!;
        const settled = calls[ordinal]!.settled!;
        step =
          "envelope" in settled
            ? {
                event: {
                  reply: { request_id: String(calls[ordinal]!.id), envelope: vectorEnvelope(settled.envelope) },
                },
              }
            : { ts: `failed call ${ordinal}: ${String(settled.error)}` };
      }
    } else if ("abandon" in event) {
      const id = BigInt(event.abandon as string);
      const local = calls.findIndex((c) => c.id === id && c.fire && !c.settled);
      calls[local]?.fire!();
      await flush();
      settledNow = settledNow.filter((o) => o !== local);
      step = {};
    } else {
      const r = session.answers.get(i)!;
      const request = requests[r];
      const answer = fromVector((event.reply as Obj).envelope as Obj);
      if (!request) step = { ts: "never read the request this answers" };
      else {
        request.answer = answer;
        request.release?.(answer);
        await flush();
        step = { unserved: r };
      }
    }

    // A call that settled where nothing should have.
    if (settledNow.length > 0) {
      step = { ts: stringify(step as Json), settled: settledNow };
    }
    steps.push(step);
    if (closed) break;
  }

  // Finish every handler still waiting, with no reply, so the requests
  // queued behind it are served.
  if (!closed) {
    for (let more = true; more; ) {
      more = false;
      for (const request of requests) {
        if (request.release) {
          request.answer ??= "none";
          request.release("none");
          more = true;
        }
      }
      await flush();
    }
  }

  const out: Json[] = steps.map((step) => {
    if (step === null || typeof step !== "object" || !("unserved" in step)) return step as Json;
    const sent = requests[(step as Unserved).unserved]!.sent;
    if (sent.length === 1) return { frame: hex(sent[0]!) };
    // The connection closed before it served the request: there's nothing
    // to compare.
    if (sent.length === 0 && closed) return { unsent: true };
    return { ts: `sent ${sent.length} frames for the request` };
  });

  // The handlers were dispatched what the framing decoded, in order.
  const wanted = requests.map((r) => ({
    protocol: r.frame.protocol ?? 0,
    index: "id" in r.frame.request.call ? r.frame.request.call.id : METHODS.indexOf(r.frame.request.call.name as never),
    params: hex(r.frame.request.params),
  }));
  const served = closed ? dispatched.length : wanted.length;
  if (stringify(dispatched) !== stringify(wanted.slice(0, served))) {
    out.push({ ts: `dispatched ${stringify(dispatched)}, but read ${stringify(wanted)}` });
  }
  if (stray.length > 0) out.push({ ts: `sent frames nothing asked for: ${stray.join(", ")}` });
  return out;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/** The members holding bytes that are JSON text under `jsonrpc@1`. */
const JSON_MEMBERS = new Set(["frame", "params", "payload", "body"]);

function sameJson(a: string, b: string): boolean {
  try {
    return jsonEqual(parseJson(strict.decode(unhex(a))), parseJson(strict.decode(unhex(b))));
  } catch {
    return false;
  }
}

/** Two steps are the same; under `jsonrpc@1`, frames and bodies compare as JSON. */
function same(json: boolean, a: Json | undefined, b: Json | undefined, key = ""): boolean {
  if (json && JSON_MEMBERS.has(key) && typeof a === "string" && typeof b === "string") {
    return a === b || sameJson(a, b);
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    k in b && same(json, (a as Obj)[k], (b as Obj)[k], Array.isArray(a) ? key : k),
  );
}

/** The reference's step as TypeScript can show it: a notification's request id isn't on the wire. */
function comparable(session: Session, i: number, step: Json): Json {
  const call = session.events[i]?.call as Obj | undefined;
  if (session.framing === FRAMING_JSONRPC && call?.one_way && step && typeof step === "object" && !Array.isArray(step)) {
    const { request_id: _, ...rest } = step;
    return rest;
  }
  return step;
}

/** The index of the first step the two sides disagree on, or `undefined`. */
function firstDifference(session: Session, ts: Json[], reference: Json[]): number | undefined {
  const json = session.framing === FRAMING_JSONRPC;
  for (let i = 0; i < Math.max(ts.length, reference.length); i++) {
    const ours = ts[i];
    // TypeScript ended the connection on the frame before.
    if (ours === undefined && i === ts.length && i > 0 && same(json, ts[i - 1], { error: "framing" })) return undefined;
    if (ours && typeof ours === "object" && !Array.isArray(ours) && ours.unsent === true) continue;
    if (!same(json, ours, comparable(session, i, reference[i]!))) return i;
  }
  return undefined;
}

withReference("sequences: TypeScript's Connection steps as the reference's State does", (reference) => {
  for (const [onCore, on] of [[false, "TypeScript"], [true, "the core"]] as const)
  for (const framing of [FRAMING_DATAGRAM2, FRAMING_JSONRPC] as const) {
    for (const ordered of [true, false]) {
      test(`${framing}, ${ordered ? "ordered" : "unordered"}, on ${on}: every step agrees with the reference`, async () => {
        await fc.assert(
          fc.asyncProperty(sequenceArb, async (seq) => {
            const session = concretize(framing, ordered, seq);
            const answer = await reference().one({
              op: "session",
              input: { framing, ordered, events: session.events },
            });
            if (answer.kind !== "steps") throw new Error(`no steps from the reference: ${JSON.stringify(answer)}`);
            const ts = await runTs(session, onCore);
            const at = firstDifference(session, ts, answer.steps);
            if (at === undefined) return;

            // What the reference reads the frame as, when it's one.
            const receive = session.events[at]?.receive;
            let referenceRead: string | undefined;
            if (typeof receive === "string") {
              const read = await reference().one({ op: "response", input: { framing }, bytes: receive });
              if (read.kind === "accept" && typeof read.input.request_id === "string") {
                referenceRead = read.input.request_id;
              }
            }
            const verdict = known({
              property: "session",
              framing,
              input: { ordered, events: session.events.slice(0, at + 1) },
              ts: `stepped ${stringify(ts[at])}`,
              reference: `stepped ${stringify(answer.steps[at])}`,
              session: {
                ordered,
                events: session.events,
                at,
                ts: ts.slice(0, at + 1),
                reference: answer.steps.slice(0, at + 1),
                ...(referenceRead !== undefined ? { referenceRead } : {}),
              },
            });
            if (verdict !== true) throw new Error(verdict);
          }),
          params(),
        );
      });
    }
  }
});
