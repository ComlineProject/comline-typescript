// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `comline@2`: the handshake that checks compatibility by what each version's
 * history records (the package id, each protocol's wire number, line and
 * shape hash, each function's wire number, the encodings' parameter hashes),
 * matching `comline_runtime::comline2`. It runs on the Comline core: the
 * messages and every decision are the core's, so both runtimes agree byte
 * for byte.
 *
 * Generated code embeds this end's Hello (its facts, encoded) and the
 * parameters its package states, runs a {@link Comline2Handshake} when a
 * connection opens, and keeps what it agreed ({@link Negotiated}) in the
 * connection's extensions, where each sender checks a call against it before
 * it's written ({@link checkCall}).
 */

import { EventFlag, EventKind, Handshake as AbiHandshake, Status, type Connection as AbiConnection } from "#core/comline.mjs";

import { RuntimeError, type Peer, type RefusalReason } from "./contract.js";
import { loadedCore } from "./core/core.js";
import { HANDSHAKE_COMLINE2, type Facts, type Handshake } from "./handshake.js";
import type { Transport } from "./transport.js";

/** `comline@2`'s parameters, as `config.idp` / `@handshake` state them. */
export interface Comline2Params {
  /** `protocol` (the default) or `package`: what a protocol's refusal refuses. */
  scope?: "protocol" | "package";
  /** `degrade` (the default) or `refuse`: when the consumer has functions the provider lacks. */
  newerConsumer?: "degrade" | "refuse";
  /** `refuse` (the default) or `warn`: when the same version has another shape. */
  sameVersionDiffers?: "refuse" | "warn";
  /** `offer` (the default) or `symmetric`. A wire parameter: both ends must share it. */
  exchange?: "offer" | "symmetric";
}

const REASONS: readonly RefusalReason[] = [
  "malformed",
  "handshake_version",
  "exchange_mismatch",
  "package_mismatch",
  "encoding_mismatch",
  "line_mismatch",
  "same_version_differs",
  "newer_consumer",
  "unknown_protocol",
];

function reasonName(code: number): RefusalReason {
  return REASONS[code - 1] ?? "malformed";
}

/** What one of this end's protocols came to. */
export type ProtocolState =
  | { readonly accepted: true; readonly peerLacks: readonly number[] }
  | { readonly accepted: false; readonly reason: RefusalReason };

/**
 * What a connection agreed: the peer's version; per protocol of this end's,
 * whether it's usable and which of its functions the peer lacks; and the
 * protocols that connected though their shape differs at the same version
 * (`same_version_differs = warn`).
 */
export class Negotiated {
  constructor(
    readonly peerVersion: { readonly major: number; readonly minor: number; readonly patch: number; readonly pre: string },
    readonly protocols: ReadonlyMap<number, ProtocolState>,
    readonly warnings: readonly number[],
  ) {}

  /**
   * Throws `RuntimeError("unavailable")`, naming `path` and `name`, unless
   * this end may call `fn` of `protocol`: the peer lacks the function, or the
   * protocol was refused.
   */
  checkCall(protocol: number, fn: number, path: string, name: string): void {
    const state = this.protocols.get(protocol);
    if (state === undefined) {
      throw RuntimeError.unavailable({ protocol: path, function: name, refused: "unknown_protocol" });
    }
    if (!state.accepted) throw RuntimeError.unavailable({ protocol: path, function: name, refused: state.reason });
    if (state.peerLacks.includes(fn)) throw RuntimeError.unavailable({ protocol: path, function: name });
  }
}

/**
 * Check a call against what the connection `peer` is on agreed, before it's
 * written: what generated senders run. A connection that didn't run
 * `comline@2` through generated code has nothing to check against, and every
 * call goes.
 */
export function checkCall(peer: Peer, protocol: number, fn: number, path: string, name: string): void {
  peer.extensions.get(Negotiated)?.checkCall(protocol, fn, path, name);
}

const CAP = 1 << 16;

/**
 * `comline@2` as a {@link Handshake}, run on the Comline core. After it
 * succeeds, {@link negotiated} holds what the connection agreed; a refusal
 * throws `RuntimeError("refused")` with its reason and the refusing side,
 * on both ends.
 */
export class Comline2Handshake implements Handshake {
  readonly name = HANDSHAKE_COMLINE2;
  #negotiated: Negotiated | undefined;

  /** `hello` is this end's encoded Hello message, as generated code embeds it. */
  constructor(
    readonly hello: Uint8Array,
    readonly params: Comline2Params = {},
  ) {}

  /** What the connection agreed, once the handshake succeeded. */
  get negotiated(): Negotiated | undefined {
    return this.#negotiated;
  }

  initiate(transport: Transport, local: Facts): Promise<void> {
    return this.run(transport, local, 0);
  }

  respond(transport: Transport, local: Facts): Promise<void> {
    return this.run(transport, local, 1);
  }

  private async run(transport: Transport, local: Facts, side: number): Promise<void> {
    const core = await loadedCore();
    const p = this.params;
    const conn = core.connectionNew({
      framing: local.framing,
      wireFormat: local.wireFormat,
      handshake: AbiHandshake.COMLINE2,
      comline2: {
        hello: this.hello,
        side,
        scope: p.scope === "package" ? 1 : 0,
        newerConsumer: p.newerConsumer === "refuse" ? 1 : 0,
        sameVersionDiffers: p.sameVersionDiffers === "warn" ? 1 : 0,
        exchange: p.exchange === "symmetric" ? 1 : 0,
      },
    });
    try {
      let done = false;
      let refused = false;
      // This end speaks first once, then whenever what it was fed says so.
      let send = true;
      for (;;) {
        if (send) {
          // Whatever this end has to say next: its hello, answer or verdict,
          // or its refusal.
          const out = conn.start(CAP);
          core.check(out.status, "handshake");
          if (out.written && out.bytes) {
            // A refusal is sent best-effort: the peer may already have gone.
            await transport.send(out.bytes.slice()).catch((e: unknown) => {
              if (!refused) throw e;
            });
          }
        }
        if (done || refused) break;
        const fed = conn.feed(await transport.recv());
        send = (fed.event.flags & EventFlag.SEND) !== 0;
        if (fed.status === Status.ERR_REFUSED) {
          refused = true;
          continue;
        }
        core.check(fed.status, "handshake");
        if (fed.event.kind === EventKind.HANDSHAKE_OK) done = true;
      }
      if (refused) {
        const { refusal } = conn.refusal();
        throw RuntimeError.refused({
          reason: reasonName(refusal?.reason ?? 1),
          side: refusal?.side === 1 ? "responder" : "initiator",
          ...(refusal?.protocol === undefined ? {} : { protocol: refusal.protocol }),
        });
      }
      this.#negotiated = negotiated(conn, (s) => core.check(s, "handshake"));
    } finally {
      conn.free();
    }
  }
}

/** Read what the core's connection agreed, into a {@link Negotiated}. */
function negotiated(conn: AbiConnection, check: (status: number) => void): Negotiated {
  const sized = <T extends { status: number; written: number }>(get: (cap: number) => T): T => {
    let got = get(64);
    if (got.status === Status.BUFFER_TOO_SMALL) got = get(got.written);
    check(got.status);
    return got;
  };
  const protocols = new Map<number, ProtocolState>();
  for (const { number, reason } of sized((cap) => conn.protocols(cap)).protocols ?? []) {
    protocols.set(
      number,
      reason === 0
        ? { accepted: true, peerLacks: sized((cap) => conn.peerLacks(number, cap)).numbers ?? [] }
        : { accepted: false, reason: reasonName(reason) },
    );
  }
  const warnings = sized((cap) => conn.warnings(cap)).numbers ?? [];
  const peer = sized((cap) => conn.peerVersion(cap));
  const version = peer.version ?? { major: 0, minor: 0, patch: 0 };
  return new Negotiated({ ...version, pre: peer.pre ?? "" }, protocols, warnings);
}
