// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A `Connection`'s framing and state on the Comline core: one ABI connection
// (`comline_connection_*`) per `Connection`, in `NONE` handshake mode (the
// `Handshake` plug-in has already run) and `unordered`, as the TypeScript
// `Connection` has always matched replies. The read loop, scheduling and
// dispatch stay in `connection.ts`. Internal.

import {
  EventFlag,
  EventKind,
  Envelope as EnvelopeTag,
  Handshake,
  MAX_FRAME_CEILING,
  Status,
  encodeBound,
  type Connection as AbiConnection,
  type Event,
} from "#core/comline.mjs";

import type { Call, Envelope, Frame, RequestCall } from "../contract.js";
import { FRAMING_DATAGRAM2, FRAMING_JSONRPC } from "../handshake.js";
import type { Core } from "./core.js";

/**
 * How many calls the ABI connection reserves room for. Past it the core
 * answers `ERR_BUSY` and the call waits in {@link Connection}'s queue for a
 * free slot, so the waiting map stays unbounded, as it always was.
 */
export const MAX_WAITING = 64;

/**
 * Bodies at least this long are encoded into a pooled array
 * (`encode*Into`); shorter ones into the fresh array the glue returns,
 * which costs less for a small frame (bench/README.md).
 */
const POOL_FROM = 256;

const NULL = new TextEncoder().encode("null");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A frame ready to send, and the pooled array it lives in (if it does). */
export interface Encoded {
  readonly frame: Uint8Array;
  readonly pooled: Uint8Array | undefined;
}

/** Free arrays by size class (a power of two), a few of each. */
const pool = new Map<number, Uint8Array[]>();
const POOL_DEPTH = 8;

function take(bound: number): Uint8Array {
  const size = 1 << (32 - Math.clz32(bound - 1));
  const free = pool.get(size);
  return free?.pop() ?? new Uint8Array(size);
}

/** Give back an array {@link Encoded.pooled} named, once the transport is done with it. */
export function release(pooled: Uint8Array | undefined): void {
  if (!pooled) return;
  let free = pool.get(pooled.length);
  if (!free) pool.set(pooled.length, (free = []));
  if (free.length < POOL_DEPTH) free.push(pooled);
}

/** Whether the core carries `framing` (the built-in framings the ABI has). */
export function coreFraming(name: string): name is typeof FRAMING_DATAGRAM2 | typeof FRAMING_JSONRPC {
  return name === FRAMING_DATAGRAM2 || name === FRAMING_JSONRPC;
}

/**
 * One ABI connection. Methods throw a `RuntimeError` for a status they don't
 * expect; `poisoned` is thrown (and `onPoison` called) once the instance
 * trapped.
 */
export class Wire {
  /** Called when the core's instance is found poisoned, by this wire or another. */
  onPoison: () => void = () => {};
  #freed = false;

  constructor(
    private readonly core: Core,
    private readonly conn: AbiConnection,
    private readonly framing: typeof FRAMING_DATAGRAM2 | typeof FRAMING_JSONRPC,
  ) {}

  static open(core: Core, framing: string): Wire | undefined {
    if (!coreFraming(framing)) return undefined;
    const conn = core.connectionNew({
      framing,
      handshake: Handshake.NONE,
      unordered: true,
      maxWaiting: MAX_WAITING,
      // TypeScript's `Connection` has no frame limit (ts#80): keep it so.
      maxFrame: MAX_FRAME_CEILING,
    });
    const wire = new Wire(core, conn, framing);
    core.track(wire);
    // A safety net only: a `Connection` frees its wire when it closes.
    unreached.register(wire, conn, wire);
    return wire;
  }

  /**
   * One frame from the peer: a request, a reply to a waiting call,
   * `"stale"` (a reply nobody waits on any more), or `undefined` for a
   * malformed frame (the connection closes).
   */
  feed(frame: Uint8Array): Frame | "stale" | undefined {
    const fed = this.conn.feed(frame);
    if (fed.status !== Status.OK) {
      if (fed.status === Status.ERR_FRAMING || fed.status === Status.ERR_FRAME_TOO_LARGE) return undefined;
      this.core.check(fed.status, "framing");
    }
    const ev = fed.event;
    const flags = ev.flags;
    const body =
      flags & EventFlag.BODY_ABSENT ? NULL : frame.subarray(ev.body.offset, ev.body.offset + ev.body.len);
    switch (ev.kind) {
      case EventKind.REQUEST:
        return {
          kind: "request",
          protocol: flags & EventFlag.HAS_PROTOCOL ? ev.protocol : undefined,
          request: { call: this.call(frame, ev), requestId: ev.requestId, params: body },
          oneWay: (flags & EventFlag.ONE_WAY) !== 0,
        };
      case EventKind.REPLY:
        return { kind: "reply", protocol: undefined, requestId: ev.requestId, envelope: envelope(ev, body) };
      case EventKind.STALE:
        return "stale";
      default:
        return undefined;
    }
  }

  private call(frame: Uint8Array, ev: Event): RequestCall {
    if (!(ev.flags & EventFlag.CALL_BY_NAME)) return { id: ev.callId };
    const spelled = frame.subarray(ev.callName.offset, ev.callName.offset + ev.callName.len);
    return {
      name: utf8.decode(ev.flags & EventFlag.NAME_ESCAPED ? this.core.methodNameUnescape(spelled) : spelled),
    };
  }

  /**
   * Frame a request, or `"busy"` when `MAX_WAITING` calls already wait (no id
   * is spent).
   */
  encodeRequest(
    protocol: number,
    call: Call,
    body: Uint8Array,
    expectsReply: boolean,
  ): (Encoded & { requestId: bigint }) | "busy" {
    const name = this.framing === FRAMING_JSONRPC ? call.name : "";
    const bound = encodeBound({ framing: this.framing, kind: "request", bodyLen: body.length, protocol, name, expectsReply });
    if (body.length < POOL_FROM) {
      const out = this.conn.encodeRequest(protocol, call.id, name, expectsReply, body, bound);
      if (out.status === Status.ERR_BUSY) return "busy";
      this.core.check(out.status, "framing");
      return { frame: out.bytes!, pooled: undefined, requestId: out.requestId! };
    }
    const pooled = take(bound);
    const out = this.conn.encodeRequestInto(pooled.subarray(0, bound), protocol, call.id, name, expectsReply, body);
    if (out.status !== Status.OK) release(pooled);
    if (out.status === Status.ERR_BUSY) return "busy";
    this.core.check(out.status, "framing");
    return { frame: pooled.subarray(0, out.written), pooled, requestId: out.requestId! };
  }

  /** Frame the reply to request `requestId`. */
  encodeReply(protocol: number, requestId: bigint, reply: Envelope): Encoded {
    const [tag, errorId, body] =
      "ok" in reply
        ? [EnvelopeTag.OK, 0, reply.ok]
        : "err" in reply
          ? [EnvelopeTag.ERR, reply.err.id, reply.err.body]
          : [EnvelopeTag.FAULT, 0, EMPTY];
    const bound = encodeBound({
      framing: this.framing,
      kind: "reply",
      bodyLen: body.length,
      protocol,
      envelope: tag,
      requestId,
      errorId,
    });
    if (body.length < POOL_FROM) {
      const out = this.conn.encodeReply(protocol, requestId, tag, errorId, body, bound);
      this.core.check(out.status, "framing");
      return { frame: out.bytes!, pooled: undefined };
    }
    const pooled = take(bound);
    const out = this.conn.encodeReplyInto(pooled.subarray(0, bound), protocol, requestId, tag, errorId, body);
    if (out.status !== Status.OK) release(pooled);
    this.core.check(out.status, "framing");
    return { frame: pooled.subarray(0, out.written), pooled };
  }

  /** Stop waiting on `requestId` (it timed out, or its send failed). */
  abandon(requestId: bigint): void {
    if (this.#freed) return;
    this.core.check(this.conn.abandon(requestId), "framing");
  }

  /** Free the ABI connection; idempotent. */
  free(): void {
    if (this.#freed) return;
    this.#freed = true;
    this.core.untrack(this);
    unreached.unregister(this);
    this.conn.free();
  }
}

const EMPTY = new Uint8Array(0);

/** Frees the ABI connection of a wire dropped without `free()`. */
const unreached = new FinalizationRegistry<AbiConnection>((conn) => conn.free());

function envelope(ev: Event, body: Uint8Array): Envelope {
  switch (ev.envelope) {
    case EnvelopeTag.OK:
      return { ok: body };
    case EnvelopeTag.ERR:
      return { err: { id: ev.errorId, body } };
    default:
      return { fault: true };
  }
}
