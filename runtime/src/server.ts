// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Codec, Dispatch, Framing } from "./contract.js";
import { Reply, RuntimeError, resolveKind } from "./contract.js";
import { ComlineHandshake, type Handshake } from "./handshake.js";
import type { Transport } from "./transport.js";
import { DatagramFraming } from "./framing/datagram.js";

/**
 * The provider side. Reads a request frame, dispatches it, writes the response
 * frame — until the transport closes. Generic over the {@link Framing};
 * defaults to {@link DatagramFraming}.
 */
export class Server {
  constructor(
    private readonly dispatch: Dispatch,
    private readonly codec: Codec,
    private readonly framing: Framing = new DatagramFraming(),
  ) {}

  /** Handle one call. `true` — served; `false` — the transport closed. */
  async serveOne(transport: Transport): Promise<boolean> {
    let frame: Uint8Array;
    try {
      frame = await transport.recv();
    } catch {
      return false;
    }

    const req = this.framing.decodeRequest(frame);
    if (!req) throw RuntimeError.framing();

    // An address this side doesn't have, or a dispatcher that threw, is a
    // failure of *this call* — not of the connection. Answering with a fault
    // keeps the caller from waiting out its timeout for a reply that was
    // never coming, and keeps the loop alive for the next call. (Before this,
    // both threw out of `serve`, so one bad frame took the server down and
    // the caller hung.)
    //
    // This cannot see the call's arity: a one-way call that fails before the
    // dispatcher records an outcome has no caller reading a response, so a
    // fault frame it never consumes would sit in front of the next one. The
    // dispatcher is the layer that knows — a generated one records a fault
    // itself for a request/response call and stays silent for a one-way one.
    const reply = new Reply();
    const idx = resolveKind(req.call, this.dispatch.calls());
    if (idx === undefined) {
      reply.fault();
    } else {
      try {
        await this.dispatch.dispatch({ id: idx }, req.params, this.codec, reply);
      } catch {
        reply.fault();
      }
    }

    switch (reply.outcome.kind) {
      case "none":
        return true; // one-way call: nothing to reply
      case "ok":
        await transport.send(this.framing.encodeResponseOk(req.requestId, reply.body));
        return true;
      case "err":
        await transport.send(
          this.framing.encodeResponseErr(req.requestId, reply.outcome.id, reply.body),
        );
        return true;
      case "fault":
        await transport.send(this.framing.encodeResponseFault(req.requestId));
        return true;
    }
  }

  /**
   * Serve calls until the transport closes, **without a handshake**: pair
   * with a {@link Client.unverified} peer. {@link Server.serve} is the
   * checked path.
   */
  async serveUnverified(transport: Transport): Promise<void> {
    while (await this.serveOne(transport)) {
      /* keep serving */
    }
  }

  /**
   * Run `handshake`'s provider side (`comline@1` unless given) against the
   * connecting peer, then serve calls until the transport closes.
   */
  async serve(
    transport: Transport,
    irHash: bigint,
    handshake: Handshake = new ComlineHandshake(),
  ): Promise<void> {
    await handshake.respond(transport, {
      irHash,
      wireFormat: this.codec.name,
      framing: this.framing.name,
    });
    await this.serveUnverified(transport);
  }
}
