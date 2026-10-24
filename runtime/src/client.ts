// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Call, CallOptions, Codec, Envelope, Framing } from "./contract.js";
import { RuntimeError } from "./contract.js";
import { ComlineHandshake, type Handshake } from "./handshake.js";
import type { Transport } from "./transport.js";
import { DatagramFraming } from "./framing/datagram.js";

/**
 * The consumer side. Frames a call, sends it, waits for the matching response,
 * and hands the generated stub the raw {@link Envelope} to decode. Generic over
 * the {@link Framing}; defaults to {@link DatagramFraming}.
 */
export class Client {
  private nextId = 0n;

  private constructor(
    private readonly transport: Transport,
    readonly codec: Codec,
    readonly framing: Framing,
  ) {}

  /**
   * Bind to a transport **without a handshake**. Use when the peer can't take
   * part (a legacy server); a mismatch then surfaces later as a decode or
   * framing error. {@link Client.connect} is the checked path.
   */
  static unverified(
    transport: Transport,
    codec: Codec,
    framing: Framing = new DatagramFraming(),
  ): Client {
    return new Client(transport, codec, framing);
  }

  /**
   * Bind and run `handshake`'s consumer side (`comline@1` unless given):
   * refuse (`RuntimeError("handshake")`) if it does.
   */
  static async connect(
    transport: Transport,
    codec: Codec,
    irHash: bigint,
    framing: Framing = new DatagramFraming(),
    handshake: Handshake = new ComlineHandshake(),
  ): Promise<Client> {
    await handshake.initiate(transport, {
      irHash,
      wireFormat: codec.name,
      framing: framing.name,
    });
    return new Client(transport, codec, framing);
  }

  /** Make `call` with `params`, block for the response, return its {@link Envelope}. */
  async call(call: Call, params: unknown, options?: CallOptions): Promise<Envelope> {
    const requestId = this.nextId++;
    await this.transport.send(
      this.framing.encodeRequest(call, requestId, this.codec.encode(params, options?.layout)),
    );
    const res = this.framing.decodeResponse(await this.transport.recv());
    if (!res) throw RuntimeError.framing();
    if (res.requestId !== requestId) throw RuntimeError.framing();
    return res.envelope;
  }

  /** Fire-and-forget: send the call, expect no response (a one-way function). */
  async notify(call: Call, params: unknown, options?: CallOptions): Promise<void> {
    const requestId = this.nextId++;
    await this.transport.send(
      this.framing.encodeRequest(call, requestId, this.codec.encode(params, options?.layout)),
    );
  }
}
