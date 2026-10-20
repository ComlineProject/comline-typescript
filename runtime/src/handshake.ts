// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The connection handshake, a declared axis beside format and framing,
 * matching `comline-runtime`'s `handshake` module. A {@link Handshake} runs on
 * a connection before the first call: Comline's own `comline@1`
 * ({@link ComlineHandshake}, one fixed 31-byte frame each way, byte-compatible
 * with the Rust runtime), `none` ({@link NoHandshake}), or a custom one.
 */

import { RuntimeError } from "./contract.js";
import type { Transport } from "./transport.js";

const MAGIC = Uint8Array.of(0x43, 0x4f); // "CO"
const VERSION = 1;
/** `[MAGIC:2][VERSION:1][ir_hash:u64][wire_format:u64][framing:u64][caps:u32]`, LE. */
const LEN = 2 + 1 + 8 + 8 + 8 + 4;

const U64_MASK = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x00000100000001b3n;

// Encoding names are versioned, `name@major`, matching the Rust runtime: a later
// `msgpack@2` must never be mistaken for `msgpack@1`. The handshake hashes them.

/** Name of Comline's default datagram framing. */
export const FRAMING_DATAGRAM = "datagram@1";
/** Name of the datagram framing with a request/reply kind and a protocol number ({@link Datagram2Framing}). */
export const FRAMING_DATAGRAM2 = "datagram@2";

/** Name of the JSON-RPC 2.0 framing ({@link JsonRpcFraming}). */
export const FRAMING_JSONRPC = "jsonrpc@1";
/** Name of the JSON wire format ({@link JsonCodec}). */
export const FORMAT_JSON = "json@1";

/** Name of Comline's own handshake ({@link ComlineHandshake}). */
export const HANDSHAKE_COMLINE = "comline@1";
/** Name of the official "no handshake" choice ({@link NoHandshake}). Unversioned. */
export const HANDSHAKE_NONE = "none";

/**
 * 64-bit FNV-1a over a name's UTF-8 bytes. Folds a wire-format / framing name
 * into the fixed-size handshake without a registry; matches
 * `comline_runtime::contract::name_hash`.
 */
export function nameHash(name: string): bigint {
  let h = FNV_OFFSET;
  for (const b of new TextEncoder().encode(name)) {
    h = (h ^ BigInt(b)) & U64_MASK;
    h = (h * FNV_PRIME) & U64_MASK;
  }
  return h;
}

/**
 * What one end knows when a connection opens, handed to its
 * {@link Handshake}. More facts follow (the package version, per-protocol
 * lines) as handshakes that use them do.
 */
export interface Facts {
  /** Fingerprint of the frozen IR both ends generated from (the `IR_HASH` const). */
  irHash: bigint;
  /** The wire format's name, e.g. `"json"` — hashed in. */
  wireFormat: string;
  /** The framing's name, e.g. {@link FRAMING_DATAGRAM} — hashed in. */
  framing: string;
  /** Transport capability bits. Advisory: a difference here is not a mismatch. */
  capabilities?: number;
}

/**
 * The frame of the `comline@1` handshake: what each end declares when a
 * connection opens.
 */
export class HandshakeFrame {
  readonly irHash: bigint;
  readonly wireFormat: bigint;
  readonly framing: bigint;
  readonly capabilities: number;

  constructor(init: Facts) {
    this.irHash = init.irHash & U64_MASK;
    this.wireFormat = nameHash(init.wireFormat);
    this.framing = nameHash(init.framing);
    this.capabilities = (init.capabilities ?? 0) >>> 0;
  }

  /** The fixed 31-byte frame. */
  encode(): Uint8Array {
    const frame = new Uint8Array(LEN);
    const view = new DataView(frame.buffer);
    frame.set(MAGIC, 0);
    frame[2] = VERSION;
    view.setBigUint64(3, this.irHash, true);
    view.setBigUint64(11, this.wireFormat, true);
    view.setBigUint64(19, this.framing, true);
    view.setUint32(27, this.capabilities, true);
    return frame;
  }

  /** Parse a frame; `undefined` if truncated or the magic / version is wrong. */
  static decode(frame: Uint8Array): HandshakeFrame | undefined {
    if (frame.length < LEN) return undefined;
    if (frame[0] !== MAGIC[0] || frame[1] !== MAGIC[1] || frame[2] !== VERSION) {
      return undefined;
    }
    const view = new DataView(frame.buffer, frame.byteOffset, LEN);
    const h = Object.create(HandshakeFrame.prototype) as HandshakeFrame;
    return Object.assign(h, {
      irHash: view.getBigUint64(3, true),
      wireFormat: view.getBigUint64(11, true),
      framing: view.getBigUint64(19, true),
      capabilities: view.getUint32(27, true),
    });
  }

  /**
   * Check a peer's declaration against this one. Throws
   * `RuntimeError("handshake")` if `irHash`, `wireFormat`, or `framing`
   * disagree; capability bits are allowed to differ.
   */
  check(peer: HandshakeFrame): void {
    const agree =
      this.irHash === peer.irHash &&
      this.wireFormat === peer.wireFormat &&
      this.framing === peer.framing;
    if (!agree) throw RuntimeError.handshake();
  }
}

/**
 * What runs on a connection before the first call. The consumer side
 * `initiate`s, the provider side `respond`s; for a symmetric handshake the two
 * are the same. Either refuses the connection by throwing (by convention
 * `RuntimeError("handshake")`).
 */
export interface Handshake {
  /** The versioned name: {@link HANDSHAKE_COMLINE}, {@link HANDSHAKE_NONE}, or a namespaced custom one. */
  readonly name: string;
  /** Run the consumer's side over `transport`. */
  initiate(transport: Transport, local: Facts): Promise<void>;
  /** Run the provider's side over `transport`. */
  respond(transport: Transport, local: Facts): Promise<void>;
}

/**
 * `comline@1`: each end sends its {@link HandshakeFrame} and refuses unless the
 * peer's names the same schema, format and framing.
 */
export class ComlineHandshake implements Handshake {
  readonly name = HANDSHAKE_COMLINE;

  initiate(transport: Transport, local: Facts): Promise<void> {
    return ComlineHandshake.exchange(transport, local);
  }

  respond(transport: Transport, local: Facts): Promise<void> {
    return ComlineHandshake.exchange(transport, local);
  }

  private static async exchange(transport: Transport, local: Facts): Promise<void> {
    const ours = new HandshakeFrame(local);
    await transport.send(ours.encode());
    const peer = HandshakeFrame.decode(await transport.recv());
    if (!peer) throw RuntimeError.handshake();
    ours.check(peer);
  }
}

/** `none`: nothing is sent or checked. Gives up schema and encoding agreement. */
export class NoHandshake implements Handshake {
  readonly name = HANDSHAKE_NONE;

  async initiate(): Promise<void> {}

  async respond(): Promise<void> {}
}
