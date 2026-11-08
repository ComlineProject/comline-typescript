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
import { currentCore } from "./core/core.js";
import type { Transport } from "./transport.js";

const MAGIC = Uint8Array.of(0x43, 0x4f); // "CO"
const VERSION = 1;
/** `[MAGIC:2][VERSION:1][ir_hash:u64][wire_format:u64][framing:u64][caps:u32]`, LE. */
const LEN = 2 + 1 + 8 + 8 + 8 + 4;

const U64_MASK = (1n << 64n) - 1n;

// Encoding names are versioned, `name@major`, matching the Rust runtime: a later
// `msgpack@2` must never be mistaken for `msgpack@1`. The handshake hashes them.

/** Name of Comline's default datagram framing. */
export const FRAMING_DATAGRAM = "datagram@1";
/** Name of the datagram framing with a request/reply kind and a protocol number ({@link Datagram2Framing}). */
export const FRAMING_DATAGRAM2 = "datagram@2";
/** Name of the datagram framing that addresses calls by wire numbers ({@link Datagram3Framing}). */
export const FRAMING_DATAGRAM3 = "datagram@3";

/** Name of the JSON-RPC 2.0 framing ({@link JsonRpcFraming}). */
export const FRAMING_JSONRPC = "jsonrpc@1";
/** Name of the JSON wire format ({@link JsonCodec}). */
export const FORMAT_JSON = "json@1";
/** Name of the packed wire format (`PackedCodec`): fixed-width fields back to back. */
export const FORMAT_PACKED = "packed@1";

/** Name of Comline's own handshake ({@link ComlineHandshake}). */
export const HANDSHAKE_COMLINE = "comline@1";
/** Name of the handshake that checks compatibility by each version's facts (`Comline2Handshake`). */
export const HANDSHAKE_COMLINE2 = "comline@2";
/** Name of the official "no handshake" choice ({@link NoHandshake}). Unversioned. */
export const HANDSHAKE_NONE = "none";

/**
 * 64-bit FNV-1a over a name's UTF-8 bytes. Folds a wire-format / framing name
 * into the fixed-size handshake without a registry; matches
 * `comline_runtime::contract::name_hash`.
 */
export function nameHash(name: string): bigint {
  nameHashWords(name);
  return join(WORDS[0]!, WORDS[1]!);
}

// The low and high 32 bits of the last `nameHashWords`.
const WORDS = new Uint32Array(2);

// FNV-1a 64 in two 32-bit halves, into `WORDS`: no BigInt per byte. The prime
// is 2^40 + 0x1b3, so `h * prime` is `h * 0x1b3 + (h << 40)` (mod 2^64).
function nameHashWords(name: string): void {
  let lo = 0x84222325;
  let hi = 0xcbf29ce4;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c >= 0x80) return nameHashUtf8(name);
    lo = (lo ^ c) >>> 0;
    const m = lo * 0x1b3; // < 2^41, exact
    hi = (Math.imul(hi, 0x1b3) + Math.floor(m / 0x100000000) + (lo << 8)) >>> 0;
    lo = m >>> 0;
  }
  WORDS[0] = lo;
  WORDS[1] = hi;
}

// The same over a non-ASCII name, through its UTF-8 bytes.
function nameHashUtf8(name: string): void {
  let lo = 0x84222325;
  let hi = 0xcbf29ce4;
  for (const b of new TextEncoder().encode(name)) {
    lo = (lo ^ b) >>> 0;
    const m = lo * 0x1b3;
    hi = (Math.imul(hi, 0x1b3) + Math.floor(m / 0x100000000) + (lo << 8)) >>> 0;
    lo = m >>> 0;
  }
  WORDS[0] = lo;
  WORDS[1] = hi;
}

const join = (lo: number, hi: number): bigint => (BigInt(hi) << 32n) | BigInt(lo);

function put32(frame: Uint8Array, at: number, x: number): void {
  frame[at] = x;
  frame[at + 1] = x >>> 8;
  frame[at + 2] = x >>> 16;
  frame[at + 3] = x >>> 24;
}

const get32 = (frame: Uint8Array, at: number): number =>
  (frame[at]! | (frame[at + 1]! << 8) | (frame[at + 2]! << 16) | (frame[at + 3]! << 24)) >>> 0;

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
  /** Transport capability bits. */
  readonly capabilities: number;
  // The three 64-bit fields as 32-bit halves: the frame's bytes are written
  // from and read into these, and `check` compares them, with no BigInt work.
  // The BigInt getters below are built only when asked for.
  private readonly irLo: number;
  private readonly irHi: number;
  private readonly formatLo: number;
  private readonly formatHi: number;
  private readonly framingLo: number;
  private readonly framingHi: number;

  constructor(init: Facts) {
    const ir = init.irHash & U64_MASK;
    this.irLo = Number(ir & 0xffffffffn);
    this.irHi = Number(ir >> 32n);
    nameHashWords(init.wireFormat);
    this.formatLo = WORDS[0]!;
    this.formatHi = WORDS[1]!;
    nameHashWords(init.framing);
    this.framingLo = WORDS[0]!;
    this.framingHi = WORDS[1]!;
    this.capabilities = (init.capabilities ?? 0) >>> 0;
  }

  /** Fingerprint of the frozen IR. */
  get irHash(): bigint {
    return join(this.irLo, this.irHi);
  }

  /** {@link nameHash} of the wire format's name. */
  get wireFormat(): bigint {
    return join(this.formatLo, this.formatHi);
  }

  /** {@link nameHash} of the framing's name. */
  get framing(): bigint {
    return join(this.framingLo, this.framingHi);
  }

  /** The fixed 31-byte frame. */
  encode(): Uint8Array {
    // Byte by byte rather than through a `DataView`: a frame this small lives
    // on the JS heap, and a `DataView` needs its `.buffer`, which moves it off
    // (that alone cost ~20x the rest of the encode).
    const frame = new Uint8Array(LEN);
    frame[0] = 0x43; // "CO"
    frame[1] = 0x4f;
    frame[2] = VERSION;
    put32(frame, 3, this.irLo);
    put32(frame, 7, this.irHi);
    put32(frame, 11, this.formatLo);
    put32(frame, 15, this.formatHi);
    put32(frame, 19, this.framingLo);
    put32(frame, 23, this.framingHi);
    put32(frame, 27, this.capabilities);
    return frame;
  }

  /** Parse a frame; `undefined` if truncated or the magic / version is wrong. */
  static decode(frame: Uint8Array): HandshakeFrame | undefined {
    if (frame.length < LEN) return undefined;
    if (frame[0] !== MAGIC[0] || frame[1] !== MAGIC[1] || frame[2] !== VERSION) {
      return undefined;
    }
    // Fields in their declaration order (the order a constructed frame
    // defines them in), so both share a shape.
    const h = Object.create(HandshakeFrame.prototype) as Fields;
    h.capabilities = get32(frame, 27);
    h.irLo = get32(frame, 3);
    h.irHi = get32(frame, 7);
    h.formatLo = get32(frame, 11);
    h.formatHi = get32(frame, 15);
    h.framingLo = get32(frame, 19);
    h.framingHi = get32(frame, 23);
    return h as unknown as HandshakeFrame;
  }

  /**
   * Check a peer's declaration against this one. Throws
   * `RuntimeError("handshake")` if `irHash`, `wireFormat`, or `framing`
   * disagree; capability bits are allowed to differ.
   */
  check(peer: HandshakeFrame): void {
    const agree =
      this.irLo === peer.irLo &&
      this.irHi === peer.irHi &&
      this.formatLo === peer.formatLo &&
      this.formatHi === peer.formatHi &&
      this.framingLo === peer.framingLo &&
      this.framingHi === peer.framingHi;
    if (!agree) throw RuntimeError.handshake();
  }
}

/** `HandshakeFrame`'s own fields, writable, for `decode`. */
interface Fields {
  capabilities: number;
  irLo: number;
  irHi: number;
  formatLo: number;
  formatHi: number;
  framingLo: number;
  framingHi: number;
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

  // The exchange runs on the Comline core when the realm has already loaded
  // it (byte for byte what the TypeScript below does, and fewer instructions
  // per handshake: see runtime/bench). It never loads the core itself: the
  // first load compiles the module, which would cost the first connection more
  // than the handshake saves. Until something else needs the core, the
  // TypeScript runs. `nameHash` and `HandshakeFrame` stay TypeScript: they're
  // synchronous, and the core loads asynchronously.
  private static async exchange(transport: Transport, local: Facts): Promise<void> {
    const core = currentCore();
    if (core) {
      const ours = core.handshakeEncode(local.irHash, local.wireFormat, local.framing, local.capabilities);
      await transport.send(ours);
      core.handshakeCheck(ours, await transport.recv());
      return;
    }
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
