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

  private constructor(
    private readonly transport: Transport,
    readonly codec: Codec,
    readonly framing: ConnectionFraming,
  ) {
    this.closed = this.readLoop();
  }

  /** A connection over `transport` **without a handshake**. */
  static unverified(
    transport: Transport,
    codec: Codec,
    framing: ConnectionFraming = new Datagram2Framing(),
  ): Connection {
    return new Connection(transport, codec, framing);
  }

  /** Dial: run `handshake`'s consumer side (`comline@1` unless given). */
  static async connect(
    transport: Transport,
    codec: Codec,
    irHash: bigint,
    framing: ConnectionFraming = new Datagram2Framing(),
    handshake: Handshake = new ComlineHandshake(),
  ): Promise<Connection> {
    await handshake.initiate(transport, { irHash, wireFormat: codec.name, framing: framing.name });
    return new Connection(transport, codec, framing);
  }

  /** Answer: run `handshake`'s provider side (`comline@1` unless given). */
  static async accept(
    transport: Transport,
    codec: Codec,
    irHash: bigint,
    framing: ConnectionFraming = new Datagram2Framing(),
    handshake: Handshake = new ComlineHandshake(),
  ): Promise<Connection> {
    await handshake.respond(transport, { irHash, wireFormat: codec.name, framing: framing.name });
    return new Connection(transport, codec, framing);
  }

  /** Provide `protocol` on this connection: the peer's requests to it go to `dispatcher`. */
  provide(protocol: number, dispatcher: Dispatch): void {
    this.providers.set(protocol, dispatcher);
  }

  call(protocol: number, call: Call, params: unknown, options?: CallOptions): Promise<Envelope> {
    return this.callFrom(protocol, call, params, options, false);
  }

  async notify(protocol: number, call: Call, params: unknown, options?: CallOptions): Promise<void> {
    if (!this.open) throw RuntimeError.transport();
    const requestId = this.nextId++;
    await this.transport.send(
      this.framing.encodeRequest(protocol, call, requestId, this.codec.encode(params, options?.layout), true),
    );
  }

  private async callFrom(
    protocol: number,
    call: Call,
    params: unknown,
    options: CallOptions | undefined,
    fromHandler: boolean,
  ): Promise<Envelope> {
    if (!this.open) throw RuntimeError.transport();
    const requestId = this.nextId++;
    const reply = new Promise<Envelope>((resolve, reject) => {
      this.waiting.set(requestId, { resolve, reject });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut =
      options?.timeoutMs === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              this.waiting.delete(requestId);
              reject(RuntimeError.timeout());
            }, options.timeoutMs);
          });
    if (fromHandler) this.handlersWaiting++;
    try {
      await this.transport.send(
        this.framing.encodeRequest(protocol, call, requestId, this.codec.encode(params, options?.layout)),
      );
      return await (timedOut ? Promise.race([reply, timedOut]) : reply);
    } finally {
      clearTimeout(timer);
      this.waiting.delete(requestId);
      if (fromHandler) {
        this.handlersWaiting--;
      }
    }
  }

  private async readLoop(): Promise<void> {
    for (;;) {
      let frame: Uint8Array;
      try {
        frame = await this.transport.recv();
      } catch {
        break;
      }
      const decoded = this.framing.decode(frame);
      if (!decoded) break; // a malformed frame: the peer and this side disagree
      if (decoded.kind === "reply") {
        // A reply nobody waits on (its call timed out) is dropped.
        this.waiting.get(decoded.requestId)?.resolve(decoded.envelope);
        continue;
      }
      this.queue.push({ protocol: decoded.protocol, request: decoded.request, oneWay: decoded.oneWay });
      this.drain();
    }
    this.open = false;
    for (const waiting of this.waiting.values()) waiting.reject(RuntimeError.transport());
    this.waiting.clear();
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
      await this.transport.send(this.framing.encodeReply(number, request.requestId, envelope));
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
