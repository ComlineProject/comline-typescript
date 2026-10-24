// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The framing-agnostic RPC contract — the TypeScript mirror of
 * `comline-runtime`'s `contract` module. Generated bindings and (later) a
 * `Client` / `Server` are written against these types.
 */

import type { Shape } from "./json.js";
import type { Layout } from "./packed.js";

/** Every way a call can fail below the application layer. */
export type RuntimeErrorKind =
  | "transport" // the transport failed to send or receive
  | "serialization" // a payload would not encode / decode against its type
  | "framing" // the call frame was malformed
  | "timeout" // no response within the call's window
  | "unknownCall" // the peer addressed a call this side does not have
  | "remote" // the peer raised a schema error this side's code does not know
  | "provider" // the peer's provider failed outside what its schema describes
  | "handshake"; // the connection handshake disagreed

export class RuntimeError extends Error {
  override readonly name = "RuntimeError";
  readonly kind: RuntimeErrorKind;
  /** Schema-global error ordinal, set only when `kind === "remote"`. */
  readonly remoteId?: number;

  constructor(kind: RuntimeErrorKind, remoteId?: number) {
    super(remoteId === undefined ? kind : `${kind} (#${remoteId})`);
    this.kind = kind;
    this.remoteId = remoteId;
  }

  static transport(): RuntimeError {
    return new RuntimeError("transport");
  }
  static serialization(): RuntimeError {
    return new RuntimeError("serialization");
  }
  static framing(): RuntimeError {
    return new RuntimeError("framing");
  }
  static timeout(): RuntimeError {
    return new RuntimeError("timeout");
  }
  static unknownCall(): RuntimeError {
    return new RuntimeError("unknownCall");
  }
  static remote(id: number): RuntimeError {
    return new RuntimeError("remote", id);
  }
  static provider(): RuntimeError {
    return new RuntimeError("provider");
  }
  static handshake(): RuntimeError {
    return new RuntimeError("handshake");
  }

  is(kind: RuntimeErrorKind): boolean {
    return this.kind === kind;
  }
}

/**
 * How a call is addressed on the wire. A datagram framing carries the ordinal
 * (`id`); a name-oriented framing (JSON-RPC) carries the method `name`. A
 * generated stub supplies both and lets the framing pick.
 */
export type Kind = { id: number } | { name: string };

/** Resolve a {@link Kind} to a call ordinal against the protocol's call list. */
export function resolveKind(kind: Kind, calls: readonly string[]): number | undefined {
  if ("id" in kind) {
    return kind.id < calls.length ? kind.id : undefined;
  }
  const i = calls.indexOf(kind.name);
  return i === -1 ? undefined : i;
}

/** A `Call` a generated stub passes — both addresses, the framing picks one. */
export interface Call {
  readonly id: number;
  readonly name: string;
}

export function call(id: number, name: string): Call {
  return { id, name };
}

/**
 * A decoded response body: an `ok` payload for the stub to decode as its return
 * type, an `err` payload keyed by the schema-global error ordinal for the
 * generated error table to map, or a `fault` — the provider failed in a way its
 * schema does not describe.
 *
 * A fault carries no body. There is no wire representation for arbitrary
 * provider detail, and inventing one would leak an implementation's internals
 * to every caller.
 */
export type Envelope =
  | { readonly ok: Uint8Array }
  | { readonly err: { readonly id: number; readonly body: Uint8Array } }
  | { readonly fault: true };

/**
 * What a dispatched handler recorded — nothing (one-way), an ok, a schema
 * error, or a fault.
 */
export type Outcome =
  | { readonly kind: "none" }
  | { readonly kind: "ok" }
  | { readonly kind: "err"; readonly id: number }
  | { readonly kind: "fault" };

/**
 * The framing-agnostic sink a generated dispatcher writes its result into. The
 * `Server` (a later PR) turns the {@link Outcome} + body into whatever envelope
 * the active framing wants.
 */
export class Reply {
  outcome: Outcome = { kind: "none" };
  body: Uint8Array = new Uint8Array(0);

  ok(body: Uint8Array): void {
    this.body = body;
    this.outcome = { kind: "ok" };
  }

  err(id: number, body: Uint8Array): void {
    this.body = body;
    this.outcome = { kind: "err", id };
  }

  /**
   * Record a failure the schema does not describe — a handler threw something
   * it never declared, or the params would not decode. Writes no body.
   */
  fault(): void {
    this.body = new Uint8Array(0);
    this.outcome = { kind: "fault" };
  }
}

/** A call outcome for a generated client method: an app error, or a runtime one. */
export type CallError<E> = { readonly app: E } | { readonly runtime: RuntimeError };

/**
 * A serialization format — the TypeScript `WireFormat`. `name` is folded into
 * the {@link Handshake} so the two ends can catch "one side JSON, one side
 * MessagePack" before exchanging real frames.
 */
export interface Codec {
  readonly name: string;
  /**
   * `layout`, from generated code, is the value's type. A self-describing
   * format (JSON) ignores it; a positional one (`packed@1`) needs it.
   */
  encode(value: unknown, layout?: Layout): Uint8Array;
  /**
   * `shape`, from generated code, says where the value holds integers too
   * wide for `number`; without one, every number is a `number`. A
   * {@link Layout} says that and the rest of the type, which a positional
   * format needs.
   */
  decode<T>(bytes: Uint8Array, shape?: Shape | Layout): T;
}

/**
 * A generated dispatcher implements this: the ordered call list, and a
 * `dispatch` that decodes params, runs the handler, and records the result on
 * the {@link Reply}.
 */
export interface Dispatch {
  calls(): readonly string[];
  dispatch(call: Kind, params: Uint8Array, codec: Codec, reply: Reply): Promise<void>;
  /**
   * {@link Dispatch.dispatch} on a {@link Connection}, with the {@link Peer}
   * that made the call, so a handler can call it back. Optional: without it
   * a connection calls `dispatch` with the peer's codec.
   */
  dispatchWith?(call: Kind, params: Uint8Array, reply: Reply, peer: Peer): Promise<void>;
}

/** A connection's id, unique within the process. The runtime assigns it. */
export type ConnectionId = number;

/**
 * The other end of a connection, as this side's code sees it: what a
 * generated sender calls through, and what a handler is given to call back
 * the peer that called it. Mirrors `comline_runtime::contract::Peer`.
 */
export interface Peer {
  readonly codec: Codec;
  readonly id: ConnectionId;
  /** Typed data the application keeps on this connection. */
  readonly extensions: Extensions;
  /** Call `call` on the peer's `protocol` and wait for the reply. */
  call(protocol: number, call: Call, params: unknown, options?: CallOptions): Promise<Envelope>;
  /** Send a one-way call: no reply is awaited. */
  notify(protocol: number, call: Call, params: unknown): Promise<void>;
}

export interface CallOptions {
  /** Give up after this many milliseconds with `RuntimeError("timeout")`. */
  readonly timeoutMs?: number;
}

/**
 * Typed data kept on a connection, one value per class, like
 * `http::Extensions`: a session, a user id, a rate-limit bucket.
 */
export class Extensions {
  private readonly values = new Map<abstract new (...args: never[]) => unknown, unknown>();

  /** Store `value` under its class, returning the one stored before. */
  set<T extends object>(value: T): T | undefined {
    const key = value.constructor as abstract new (...args: never[]) => T;
    const old = this.values.get(key) as T | undefined;
    this.values.set(key, value);
    return old;
  }

  get<T>(type: abstract new (...args: never[]) => T): T | undefined {
    return this.values.get(type) as T | undefined;
  }

  delete<T>(type: abstract new (...args: never[]) => T): T | undefined {
    const old = this.values.get(type) as T | undefined;
    this.values.delete(type);
    return old;
  }
}

/** Whichever call address a framing put on the wire. */
export type RequestCall = { readonly id: number } | { readonly name: string };

/** A decoded request frame. */
export interface DecodedRequest {
  readonly call: RequestCall;
  readonly requestId: bigint;
  /** The params sub-frame, independently decodable with the peer's {@link Codec}. */
  readonly params: Uint8Array;
}

/**
 * A decoded {@link ConnectionFraming} frame: the peer calls one of this
 * side's protocols, or answers a call this side made.
 */
export type Frame =
  | {
      readonly kind: "request";
      /**
       * The protocol called, or `undefined` when the framing names only the
       * call (JSON-RPC): the receiver looks it up among the protocols it
       * provides.
       */
      readonly protocol: number | undefined;
      readonly request: DecodedRequest;
      /** The frame asked for no reply (a JSON-RPC notification): send none. */
      readonly oneWay: boolean;
    }
  | {
      readonly kind: "reply";
      /** Matched by `requestId` alone; there when the framing carries it. */
      readonly protocol: number | undefined;
      readonly requestId: bigint;
      readonly envelope: Envelope;
    };

/**
 * How a {@link Connection} puts calls on the wire when either end may start
 * one: every frame says whether it's a request or a reply. A request names its
 * protocol by number ({@link Datagram2Framing}, `datagram@2`), or only by its
 * call's name ({@link JsonRpcConnectionFraming}).
 */
export interface ConnectionFraming {
  readonly name: string;
  /** A `oneWay` call gets no reply; a framing that can say so on the wire does. */
  encodeRequest(
    protocol: number,
    call: Call,
    requestId: bigint,
    params: Uint8Array,
    oneWay?: boolean,
  ): Uint8Array;
  encodeReply(protocol: number, requestId: bigint, reply: Envelope): Uint8Array;
  decode(frame: Uint8Array): Frame | undefined;
}

/** A decoded response frame: the correlation id and its {@link Envelope}. */
export interface DecodedResponse {
  readonly requestId: bigint;
  readonly envelope: Envelope;
}

/**
 * How a call becomes bytes and back — the axis orthogonal to {@link Codec}
 * (which serializes the *parts*). {@link DatagramFraming} is the default;
 * {@link JsonRpcFraming} is the name-oriented alternative. `params` / `payload`
 * / `body` arrive already {@link Codec}-encoded; the framing only positions
 * them. Both ends of a connection must agree — the {@link Handshake} carries
 * `name`, hashed.
 */
export interface Framing {
  readonly name: string;
  encodeRequest(call: Call, requestId: bigint, params: Uint8Array): Uint8Array;
  decodeRequest(frame: Uint8Array): DecodedRequest | undefined;
  encodeResponseOk(requestId: bigint, payload: Uint8Array): Uint8Array;
  encodeResponseErr(requestId: bigint, id: number, body: Uint8Array): Uint8Array;
  /**
   * Frame a `fault` response — no ordinal, no body.
   *
   * Deliberately required, with no default. A default would have to pick some
   * wire shape and every framing written afterwards would inherit it silently,
   * including ones whose wire already has a native way to say "internal
   * error". Whatever it writes, {@link Framing.decodeResponse} must read back
   * as a `fault` envelope.
   */
  encodeResponseFault(requestId: bigint): Uint8Array;
  decodeResponse(frame: Uint8Array): DecodedResponse | undefined;
}
