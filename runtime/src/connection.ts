// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type {
  Call,
  CallOptions,
  Codec,
  ConnectionFraming,
  ConnectionId,
  DecodedRequest,
  Dispatch,
  Envelope,
  Peer,
} from "./contract.js";
import { Extensions, Reply, RuntimeError, resolveKind } from "./contract.js";
import { ComlineHandshake, type Handshake } from "./handshake.js";
import type { Transport } from "./transport.js";
import { Datagram2Framing } from "./framing/datagram2.js";
import { JsonRpcConnectionFraming } from "./framing/jsonrpc.js";
import { currentCore, loadedCore, type Core } from "./core/core.js";
import { Wire, release, type Encoded } from "./core/wire.js";

let nextConnectionId = 0;

interface Waiting {
  resolve(envelope: Envelope): void;
  reject(error: unknown): void;
}

/**
 * One end of a connection: calls in both directions over one transport,
 * several protocols each under its number. Mirrors
 * `comline_runtime::connection::Connection`; needs a
 * {@link ConnectionFraming}, `datagram@2` by default.
 *
 * A read loop starts with the connection and runs until the transport
 * closes ({@link Connection.closed}). Replies go straight to the call waiting
 * on them, so several calls can be in flight. The peer's requests are handled
 * one at a time, in order, except while every running handler waits on a call
 * to the peer: then the next request starts, since it may be that call's
 * nested request, which the handler can't finish without. The Rust driver
 * does the same: a waiting call serves whatever the peer sends.
 *
 * With one of the built-in framings (`Datagram2Framing`,
 * `JsonRpcConnectionFraming`), framing and connection state run on the
 * Comline core, which `connect` / `accept` load. A custom
 * {@link ConnectionFraming}, or a realm where the core can't load (a
 * Content-Security-Policy without `wasm-unsafe-eval`, say), runs the same
 * logic in TypeScript, with the same behaviour.
 */
export class Connection implements Peer {
  readonly id: ConnectionId = nextConnectionId++;
  readonly extensions = new Extensions();
  /** Resolves when the transport closes. */
  readonly closed: Promise<void>;

  private readonly providers = new Map<number, Dispatch>();
  private readonly waiting = new Map<bigint, Waiting>();
  private readonly queue: { protocol: number | undefined; request: DecodedRequest; oneWay: boolean }[] = [];
  private nextId = 0n;
  /** Handlers running now. */
  private running = 0;
  /** Calls to the peer that handlers are waiting on. */
  private handlersWaiting = 0;
  private open = true;
  /** Why the connection closed: the transport, or the core trapping. */
  private closedBy: RuntimeError | undefined;
  /** Calls waiting for room in the core's waiting set (`ERR_BUSY`). */
  private readonly busy: (() => void)[] = [];
  /** The framing and state on the core, or undefined to run them in TypeScript. */
  private readonly wire: Wire | undefined;

  private constructor(
    private readonly transport: Transport,
    readonly codec: Codec,
    readonly framing: ConnectionFraming,
    core: Core | undefined,
  ) {
    const wire = core && builtIn(framing) ? Wire.open(core, framing.name) : undefined;
    if (wire) wire.onPoison = () => this.shut(RuntimeError.poisoned());
    this.wire = wire;
    this.closed = this.readLoop();
  }

  /** A connection over `transport` **without a handshake**. */
  static unverified(
    transport: Transport,
    codec: Codec,
    framing: ConnectionFraming = new Datagram2Framing(),
  ): Connection {
    // Synchronous, so it can't load the core: it runs on it once the realm has.
    return new Connection(transport, codec, framing, currentCore());
  }

  /** Dial: run `handshake`'s consumer side (`comline@1` unless given). */
  static async connect(
    transport: Transport,
    codec: Codec,
    irHash: bigint,
    framing: ConnectionFraming = new Datagram2Framing(),
    handshake: Handshake = new ComlineHandshake(),
  ): Promise<Connection> {
    const core = await coreFor(framing);
    await handshake.initiate(transport, { irHash, wireFormat: codec.name, framing: framing.name });
    return new Connection(transport, codec, framing, core);
  }

  /** Answer: run `handshake`'s provider side (`comline@1` unless given). */
  static async accept(
    transport: Transport,
    codec: Codec,
    irHash: bigint,
    framing: ConnectionFraming = new Datagram2Framing(),
    handshake: Handshake = new ComlineHandshake(),
  ): Promise<Connection> {
    const core = await coreFor(framing);
    await handshake.respond(transport, { irHash, wireFormat: codec.name, framing: framing.name });
    return new Connection(transport, codec, framing, core);
  }

  /** Provide `protocol` on this connection: the peer's requests to it go to `dispatcher`. */
  provide(protocol: number, dispatcher: Dispatch): void {
    this.providers.set(protocol, dispatcher);
  }

  call(protocol: number, call: Call, params: unknown, options?: CallOptions): Promise<Envelope> {
    return this.callFrom(protocol, call, params, options, false);
  }

  async notify(protocol: number, call: Call, params: unknown, options?: CallOptions): Promise<void> {
    if (!this.open) throw this.gone();
    const body = this.codec.encode(params, options?.layout);
    if (this.wire) {
      const out = this.wire.encodeRequest(protocol, call, body, false) as Encoded;
      await this.sendFrame(out);
      return;
    }
    const requestId = this.nextId++;
    await this.transport.send(this.framing.encodeRequest(protocol, call, requestId, body, true));
  }

  /** Send `out`, then give its array back to the pool: the transport is done with it. */
  private async sendFrame(out: Encoded): Promise<void> {
    if (!out.pooled) return this.transport.send(out.frame);
    try {
      await this.transport.send(out.frame);
    } finally {
      release(out.pooled);
    }
  }

  private gone(): RuntimeError {
    return this.closedBy ?? RuntimeError.transport();
  }

  /**
   * Frame a call on the core once there's room: `MAX_WAITING` calls wait
   * already, so it queues behind any others, in order. The waiting map stays
   * unbounded.
   */
  private async encodeQueued(
    wire: Wire,
    protocol: number,
    call: Call,
    body: Uint8Array,
    cancelled: { now: boolean },
  ): Promise<Encoded & { requestId: bigint }> {
    for (let woken = false; ; woken = true) {
      await new Promise<void>((wake) => (woken ? this.busy.unshift(wake) : this.busy.push(wake)));
      if (!this.open) throw this.gone();
      if (cancelled.now) {
        this.wakeBusy(); // pass the room on
        throw RuntimeError.timeout();
      }
      const out = wire.encodeRequest(protocol, call, body, true);
      if (out !== "busy") return out;
    }
  }

  /** A waiting call ended: let the next queued one try. */
  private wakeBusy(): void {
    this.busy.shift()?.();
  }

  private async callFrom(
    protocol: number,
    call: Call,
    params: unknown,
    options: CallOptions | undefined,
    fromHandler: boolean,
  ): Promise<Envelope> {
    if (!this.open) throw this.gone();
    const wire = this.wire;
    let requestId: bigint | undefined;
    let waiter!: Waiting;
    const reply = new Promise<Envelope>((resolve, reject) => {
      waiter = { resolve, reject };
    });
    const cancelled = { now: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut =
      options?.timeoutMs === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              cancelled.now = true;
              this.forget(requestId);
              reject(RuntimeError.timeout());
            }, options.timeoutMs);
          });
    if (fromHandler) this.handlersWaiting++;
    try {
      const body = this.codec.encode(params, options?.layout);
      if (wire) {
        // Framed and sent at once, as the TypeScript does, unless calls queue for room.
        let out = this.busy.length === 0 ? wire.encodeRequest(protocol, call, body, true) : "busy";
        if (out === "busy") {
          const queued = this.encodeQueued(wire, protocol, call, body, cancelled);
          queued.catch(() => {}); // after a timeout, nothing waits on it
          out = await (timedOut ? Promise.race([queued, timedOut]) : queued);
        }
        requestId = out.requestId;
        this.waiting.set(requestId, waiter);
        await this.sendFrame(out);
      } else {
        requestId = this.nextId++;
        this.waiting.set(requestId, waiter);
        await this.transport.send(this.framing.encodeRequest(protocol, call, requestId, body));
      }
      return await (timedOut ? Promise.race([reply, timedOut]) : reply);
    } finally {
      clearTimeout(timer);
      this.forget(requestId);
      if (fromHandler) {
        this.handlersWaiting--;
      }
    }
  }

  /**
   * Stop waiting on `requestId` if it still waits (it timed out, or its send
   * failed): on the core, a late reply to it is then `STALE`, and its room
   * goes to the next queued call.
   */
  private forget(requestId: bigint | undefined): void {
    if (requestId === undefined || !this.waiting.delete(requestId) || !this.wire) return;
    if (this.open) this.wire.abandon(requestId);
    this.wakeBusy();
  }

  private async readLoop(): Promise<void> {
    for (;;) {
      let frame: Uint8Array;
      try {
        frame = await this.transport.recv();
      } catch {
        break;
      }
      if (!this.open) break; // the core trapped
      let decoded;
      try {
        decoded = this.wire ? this.wire.feed(frame) : this.framing.decode(frame);
      } catch (e) {
        this.shut(e instanceof RuntimeError ? e : RuntimeError.framing());
        break;
      }
      if (decoded === "stale") continue; // a reply to a call that timed out
      if (!decoded) break; // a malformed frame: the peer and this side disagree
      if (decoded.kind === "reply") {
        // A reply nobody waits on (its call timed out) is dropped.
        const waiting = this.waiting.get(decoded.requestId);
        if (waiting) {
          this.waiting.delete(decoded.requestId);
          waiting.resolve(decoded.envelope);
          if (this.wire) this.wakeBusy();
        }
        continue;
      }
      this.queue.push({ protocol: decoded.protocol, request: decoded.request, oneWay: decoded.oneWay });
      this.drain();
    }
    this.shut(RuntimeError.transport());
  }

  /** Close: fail every waiting and queued call with `why`, and free the core's connection. */
  private shut(why: RuntimeError): void {
    if (!this.open) return;
    this.open = false;
    this.closedBy = why;
    for (const waiting of this.waiting.values()) waiting.reject(why);
    this.waiting.clear();
    for (const wake of this.busy.splice(0)) wake();
    this.wire?.free();
  }

  /** Start queued requests while nothing runs, or while every running handler waits on the peer. */
  private drain(): void {
    while (this.queue.length > 0 && (this.running === 0 || this.handlersWaiting >= this.running)) {
      const next = this.queue.shift()!;
      this.running++;
      void this.serve(next.protocol, next.request, next.oneWay).finally(() => {
        this.running--;
        this.drain();
      });
    }
  }

  private async serve(
    protocol: number | undefined,
    request: DecodedRequest,
    oneWay: boolean,
  ): Promise<void> {
    const reply = new Reply();
    const found = this.find(protocol, request);
    const provider = found?.provider;
    const index = found?.index;
    if (provider === undefined || index === undefined) {
      // A protocol or call this side doesn't have: the caller hears a fault.
      reply.fault();
    } else {
      try {
        if (provider.dispatchWith) {
          await provider.dispatchWith({ id: index }, request.params, reply, this.handle());
        } else {
          await provider.dispatch({ id: index }, request.params, this.codec, reply);
        }
      } catch {
        reply.fault();
      }
    }

    const outcome = reply.outcome;
    if (oneWay || outcome.kind === "none" || !this.open) return;
    const envelope: Envelope =
      outcome.kind === "ok"
        ? { ok: reply.body }
        : outcome.kind === "err"
          ? { err: { id: outcome.id, body: reply.body } }
          : { fault: true };
    try {
      const number = found?.protocol ?? protocol ?? 0;
      if (this.wire) await this.sendFrame(this.wire.encodeReply(number, request.requestId, envelope));
      else await this.transport.send(this.framing.encodeReply(number, request.requestId, envelope));
    } catch {
      // The transport closed; the read loop ends the connection.
    }
  }

  /**
   * The provider a request is for and its call's index there: by protocol
   * number, or, when the framing names only the call, the protocol that has a
   * call by that name.
   */
  private find(
    protocol: number | undefined,
    request: DecodedRequest,
  ): { protocol: number; provider: Dispatch; index: number } | undefined {
    const numbers = protocol === undefined ? [...this.providers.keys()].sort((a, b) => a - b) : [protocol];
    for (const number of numbers) {
      const provider = this.providers.get(number);
      const index = provider && resolveKind(request.call, provider.calls());
      if (provider && index !== undefined) return { protocol: number, provider, index };
    }
    return undefined;
  }

  /** What a handler is given: this connection, with its calls counted as nested. */
  private handle(): Peer {
    return {
      codec: this.codec,
      id: this.id,
      extensions: this.extensions,
      call: (protocol, call, params, options) => {
        const made = this.callFrom(protocol, call, params, options, true);
        // A request may have queued while this handler ran; it can start now.
        this.drain();
        return made;
      },
      notify: (protocol, call, params, options) => this.notify(protocol, call, params, options),
    };
  }
}

/** Whether `framing` is one of the built-in framings, unchanged, which the core carries. */
function builtIn(framing: ConnectionFraming): boolean {
  const ctor = framing.constructor;
  return ctor === Datagram2Framing || ctor === JsonRpcConnectionFraming;
}

/**
 * The core, loaded, if `framing` runs on it; undefined (the TypeScript) if
 * it doesn't, or the core can't load here.
 */
async function coreFor(framing: ConnectionFraming): Promise<Core | undefined> {
  if (!builtIn(framing)) return undefined;
  try {
    return await loadedCore();
  } catch {
    return undefined;
  }
}
