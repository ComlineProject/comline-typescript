// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The JS glue over the wasm32 build of `comline-runtime-ffi`: the same
// functions `comline.h` declares, for a host that has no pointers. It is a
// thin, faithful wrapper: every call is one ABI call, and returns the
// status with whatever the call wrote; it retries nothing and throws on no
// status. The only state it keeps is the module's, never the protocol's:
// where the memory regions are, and whether the instance is alive. A
// binding (exceptions, async, codecs) builds on it. No dependencies, no
// wasm-bindgen.
//
//     import { instantiate, Status } from "./comline.mjs";
//     const comline = await instantiate(await readFile("comline_runtime_ffi.wasm"));
//     const { status, connection } = comline.connectionNew({ framing: "datagram@2", handshake: Handshake.NONE, maxWaiting: 16 });
//
// Loading: `instantiate` (bytes or a compiled module), `instantiateSync`
// (the same, synchronously, for Node and workers) and
// `instantiateStreaming` (a `fetch` response, compiled as it downloads).
// All three check the module the same way before handing it out.
//
// How memory crosses: the module owns two regions, `in` and `out`
// (`comline_wasm_reserve_in/out`). A call copies its inputs (names, bodies,
// the config) into `in`, gives the ABI pointers into `out` for everything it
// writes (bytes, `*written`, the event, the handle), and copies the outputs
// back. The ABI refuses an input that overlaps an output, and the two
// regions never do. Byte outputs are fresh copies; nothing returned points
// into wasm memory.
//
// A region is reserved only when a call needs more than it holds, so a call
// is normally one crossing. That rests on what the module promises
// (`src/lib.rs`, `mod wasm`): a region moves, grows or is freed only inside
// its own reserve call, and only when that call asks for more than it
// holds; a reserve for no more returns the same address and changes
// nothing. So the addresses cached here stay valid from call to call.
// Memory itself may grow during any call (a reserve, or an allocation such
// as `connectionNew`'s), which detaches the `ArrayBuffer` views on it
// without moving anything, so every access goes through views taken again
// whenever `memory.buffer` has changed.
//
// Traps poison the instance. On wasm32 a panic in the module is a trap, not
// an unwind: the ABI's `catch_unwind` can't catch it, so the module itself
// never returns `ERR_POISONED`, and the trap leaves the whole instance (its
// stack pointer, its heap, every connection in it) in an unknown state.
// The glue marks the `Comline` instance dead on a trap: a
// `WebAssembly.RuntimeError`, or a `RangeError` from inside the module (the
// engine's stack exhaustion stops it just as hard). The call that trapped
// returns `Status.ERR_POISONED`, and so does every later call on that
// instance and on every `Connection` made from it, without entering the
// module. Natively the C ABI poisons only the handle that panicked, because
// a panic unwinds to its guard; here the instance is poisoned, not just the
// handle. Drop the instance and its connections, and instantiate again. Any
// other exception (a `TypeError` for an argument of the wrong type) is
// thrown as it was, and poisons nothing; so is the `RangeError` for memory
// that can't grow, which leaves the module as it was.
//
// Numbers: a `u64` is a BigInt both ways; everything else is a Number.
// Names (framings, wire formats, methods) are a string, encoded as UTF-8,
// or a Uint8Array of the bytes as they are.
//
// Where a call's out-pointer is written only on some outcomes, the result
// leaves that field out (or null) when the ABI didn't write it. A poisoned
// call's result is the status, with the fields its type always has zeroed
// (`written` and `consumed` 0, a zeroed `event`, `peer` and `connection`
// null). `supports` is false then, as the C function is when it panics.

/** The ABI version this glue is written against. Before 1.0 a minor counts
 * as a major, so `instantiate` accepts exactly this. */
export const ABI_MAJOR = 0;
export const ABI_MINOR = 1;

/** `comline_status`. Below 16 is an outcome, 16 and up an error. A number
 * not here is a code from a newer library. */
export const Status = Object.freeze({
  OK: 0,
  NEED_MORE: 1,
  BUFFER_TOO_SMALL: 2,
  ERR_FRAMING: 16,
  ERR_HANDSHAKE: 17,
  ERR_FRAME_TOO_LARGE: 18,
  ERR_UNKNOWN_FRAMING: 19,
  ERR_INVALID_ARGUMENT: 20,
  ERR_STATE: 21,
  ERR_POISONED: 22,
  ERR_BUSY: 23,
});

/** `comline_config.handshake`. */
export const Handshake = Object.freeze({ COMLINE: 0, NONE: 1 });

/** `comline_event.kind`. */
export const EventKind = Object.freeze({
  HANDSHAKE_OK: 0,
  REQUEST: 1,
  REPLY: 2,
  STALE: 3,
});

/** `comline_event.flags` bits. */
export const EventFlag = Object.freeze({
  HAS_PROTOCOL: 1 << 0,
  ONE_WAY: 1 << 1,
  CALL_BY_NAME: 1 << 2,
  BODY_ABSENT: 1 << 3,
  NAME_ESCAPED: 1 << 4,
});

/** `comline_event.envelope` and `encodeReply`'s `envelope`. */
export const Envelope = Object.freeze({ OK: 0, ERR: 1, FAULT: 2 });

export const DEFAULT_MAX_FRAME = 16 * 1024 * 1024;
export const MAX_FRAME_CEILING = 4294967291;
export const PREFIX_LEN = 4;
export const HANDSHAKE_LEN = 31;

// The layouts on wasm32 (4-byte pointers and `size_t`), as `src/lib.rs`
// asserts them.
const EVENT_SIZE = 48;
const EVENT = {
  kind: 0, flags: 1, protocol: 2, callId: 4, envelope: 6, errorId: 8,
  callName: 12, body: 20, frame: 28, capabilities: 36, requestId: 40,
};
const CONFIG_SIZE = 48;
const CONFIG = {
  irHash: 0, wireFormat: 8, wireFormatLen: 12, framing: 16, framingLen: 20,
  maxFrame: 24, capabilities: 32, maxWaiting: 36, handshake: 40, stream: 41,
  unordered: 42, reserved: 43,
};
const HANDSHAKE_SIZE = 32;

/** The least a region is reserved at, so small calls never reserve again. */
const REGION_MIN = 1024;

const POISONED = Status.ERR_POISONED;

const utf8 = new TextEncoder();

/** Bytes of a name or body: a string as UTF-8, bytes as they are. */
function bytesOf(value) {
  if (typeof value === "string") return utf8.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value == null) return new Uint8Array(0);
  throw new TypeError("expected a string or a Uint8Array");
}

const align8 = (n) => (n + 7) & ~7;

/** A `u64` argument as the ABI takes it: a BigInt, wrapped to 64 bits. */
const u64 = (value) => BigInt.asUintN(64, BigInt(value));

// ── loading ────────────────────────────────────────────────────────────────

/**
 * Instantiate the wasm32 build and check it: its ABI version must be
 * `ABI_MAJOR.ABI_MINOR`, and one fed frame must land in `comline_event` at
 * the offsets above, in 48 bytes.
 *
 * @param {BufferSource | WebAssembly.Module} source the `.wasm` bytes or a
 *   compiled module.
 */
export async function instantiate(source) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const instance = await WebAssembly.instantiate(module, {});
  return new Comline(instance.exports);
}

/**
 * `instantiate`, synchronously, with the same checks. For Node and
 * workers: a browser's main thread refuses to compile a module of this size
 * synchronously, so use `instantiateStreaming` or `instantiate` there (or
 * pass a module compiled elsewhere).
 *
 * @param {BufferSource | WebAssembly.Module} source
 */
export function instantiateSync(source) {
  const module = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source);
  return new Comline(new WebAssembly.Instance(module, {}).exports);
}

/**
 * Instantiate from a `fetch` response (or a promise of one), compiling it
 * as it downloads, with the same checks as `instantiate`.
 *
 * `WebAssembly.instantiateStreaming` takes only a response served as
 * `application/wasm`. When the engine has no streaming compile, or the
 * response names another content type (a server that doesn't know
 * `.wasm`), this reads the whole body and compiles the bytes instead:
 * slower to start, the same module. A response that isn't `ok` is refused
 * either way, as streaming refuses it.
 *
 * @param {Response | PromiseLike<Response>} source
 */
export async function instantiateStreaming(source) {
  const response = await source;
  if (!response.ok) {
    throw new TypeError(`comline: the module's response is HTTP ${response.status}`);
  }
  if (typeof WebAssembly.instantiateStreaming === "function" && isWasm(response)) {
    const { instance } = await WebAssembly.instantiateStreaming(response, {});
    return new Comline(instance.exports);
  }
  return instantiate(await response.arrayBuffer());
}

/** Whether a response's content type is `application/wasm`, the one
 * `WebAssembly.instantiateStreaming` takes (parameters aside). */
function isWasm(response) {
  const type = response.headers.get("content-type") ?? "";
  return type.split(";")[0].trim().toLowerCase() === "application/wasm";
}

// ── sizing ─────────────────────────────────────────────────────────────────

// `jsonrpc@1`'s fixed text, as `src/framing.rs` in `comline-runtime`
// writes it.
const JSONRPC_REQUEST_HEAD = '{"jsonrpc":"2.0","method":"'.length;
const JSONRPC_REQUEST_PARAMS = '","params":'.length;
const JSONRPC_ID = ',"id":'.length;
const JSONRPC_CLOSE = "}".length;
const JSONRPC_NULL = "null".length;
const JSONRPC_RESULT_HEAD = '{"jsonrpc":"2.0","result":'.length;
const JSONRPC_ERROR_HEAD = '{"jsonrpc":"2.0","error":{"code":'.length;
const JSONRPC_ERROR_DATA = ',"message":"application error","data":'.length;
const JSONRPC_ERROR_ID = '},"id":'.length;
const JSONRPC_FAULT_HEAD =
  '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal error"},"id":'.length;
/** The most digits an id takes: `u64::MAX`, and an error id's `u16::MAX`. */
const U64_DIGITS = 20;
const U16_DIGITS = 5;
/** The most bytes `jsonrpc@1` writes for one byte of a name: `\u00XX`. */
const ESCAPE_MAX = 6;
/** The most bytes `datagram@2`'s protocol varint takes (`u16::MAX`). */
const VARINT_MAX = 3;

const isU16 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffff;

/** The bytes the LEB128 varint of a `u16` takes. */
const varintLen = (n) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

/** A length argument: a non-negative safe integer. */
function lengthOf(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`comline: ${what} must be a non-negative integer`);
  }
  return value;
}

/** The bytes a name takes in a `jsonrpc@1` frame, between its quotes: its
 * UTF-8, with `"`, `\` and the control characters escaped as serde_json
 * escapes them (`put_method` in `comline-runtime`'s `src/framing.rs`). */
function escapedLen(name) {
  if (name instanceof Uint8Array) {
    let len = name.length;
    for (let i = 0; i < name.length; i++) len += escapeExtra(name[i]);
    return len;
  }
  if (typeof name !== "string") throw new TypeError("expected a string or a Uint8Array");
  // UTF-8 as `TextEncoder` writes it, which is what `encodeRequest` sends:
  // a lone surrogate becomes U+FFFD, 3 bytes.
  let len = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x80) {
      len += 1 + escapeExtra(c);
    } else if (c < 0x800) {
      len += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < name.length) {
      const next = name.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        len += 4;
        i++;
      } else {
        len += 3;
      }
    } else {
      len += 3;
    }
  }
  return len;
}

/** The bytes an escape adds to a byte of a name. */
function escapeExtra(b) {
  // `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`.
  if (b === 0x22 || b === 0x5c || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x08 || b === 0x0c) {
    return 1;
  }
  // `\u00XX`.
  if (b < 0x20) return 5;
  return 0;
}

/** The decimal digits of an id, wrapped to a `u64` as the encodes wrap it;
 * 20 when it isn't given. */
const idDigits = (id) => (id == null ? U64_DIGITS : u64(id).toString().length);

/**
 * The most bytes an encode can write (`*written`, a stream's prefix
 * included), so a binding can size `cap` and never retry. Pure: it needs no
 * instance.
 *
 * It is never smaller than what the ABI writes, and it is exactly that when
 * everything the frame holds is given:
 *
 * - `datagram@2`: `protocol`. Without it, the varint's most (3 bytes).
 * - `jsonrpc@1`: `name` (escaped exactly as the framing escapes it), a
 *   request's `expectsReply` and `requestId` (the id it will be given, when
 *   the binding knows it), a reply's `requestId`, and an error's `errorId`.
 *   Without them: `nameLen` bytes at the most a byte can take escaped
 *   (`\u00XX`, 6), 20 digits for an id (`u64::MAX`) and 5 for an error id
 *   (`u16::MAX`). A request whose `expectsReply` isn't given is counted
 *   with its `id`.
 *
 * A frame over the connection's `maxFrame` is `ERR_FRAME_TOO_LARGE` at any
 * `cap`; this doesn't look at the limit.
 *
 * @param {import("./comline.d.mts").EncodeBoundArgs} args
 */
export function encodeBound(args) {
  const { framing, kind, envelope } = args;
  const bodyLen = lengthOf(args.bodyLen, "bodyLen");
  const prefix = args.stream ? PREFIX_LEN : 0;
  if (kind !== "request" && kind !== "reply") {
    throw new TypeError('comline: kind must be "request" or "reply"');
  }
  if (
    kind === "reply" &&
    envelope !== Envelope.OK && envelope !== Envelope.ERR && envelope !== Envelope.FAULT
  ) {
    throw new TypeError("comline: a reply's envelope must be an Envelope");
  }

  if (framing === "datagram@2") {
    // Request: [0][protocol varint][call_id u16][request_id u64][params]
    // Reply:   [1][protocol varint][request_id u64][envelope]
    // Envelope: [0][payload] | [1][error id u16][body] | [2]
    const varint = isU16(args.protocol) ? varintLen(args.protocol) : VARINT_MAX;
    if (kind === "request") return prefix + 1 + varint + 2 + 8 + bodyLen;
    const sealed =
      envelope === Envelope.OK ? 1 + bodyLen : envelope === Envelope.ERR ? 3 + bodyLen : 1;
    return prefix + 1 + varint + 8 + sealed;
  }

  if (framing === "jsonrpc@1") {
    // An empty body is written as `null`.
    const body = bodyLen === 0 ? JSONRPC_NULL : bodyLen;
    if (kind === "request") {
      const name =
        args.name != null
          ? escapedLen(args.name)
          : lengthOf(args.nameLen, "nameLen (or name)") * ESCAPE_MAX;
      // A one-way call is a notification, with no `id`.
      const oneWay = args.expectsReply === false || args.expectsReply === 0;
      const id = oneWay ? 0 : JSONRPC_ID + idDigits(args.requestId);
      return (
        prefix + JSONRPC_REQUEST_HEAD + name + JSONRPC_REQUEST_PARAMS + body + id + JSONRPC_CLOSE
      );
    }
    const id = idDigits(args.requestId);
    if (envelope === Envelope.OK) {
      return prefix + JSONRPC_RESULT_HEAD + body + JSONRPC_ID + id + JSONRPC_CLOSE;
    }
    if (envelope === Envelope.ERR) {
      const code = isU16(args.errorId) ? String(args.errorId).length : U16_DIGITS;
      return (
        prefix + JSONRPC_ERROR_HEAD + code + JSONRPC_ERROR_DATA + body + JSONRPC_ERROR_ID + id +
        JSONRPC_CLOSE
      );
    }
    return prefix + JSONRPC_FAULT_HEAD + id + JSONRPC_CLOSE;
  }

  throw new TypeError(`comline: no encode bound for framing ${String(framing)}`);
}

// ── the library ────────────────────────────────────────────────────────────

/** The glue's own errors, which are never a trap. */
const glueErrors = new WeakSet();

/** A trap: the module stopped mid-call. A `RangeError` from inside an
 * export is the engine's stack exhaustion, which stops the module just as
 * hard. Typed-array access in the `try`s that ask this stays inside the
 * regions, so it can't raise one. */
const isTrap = (e) =>
  e instanceof WebAssembly.RuntimeError || (e instanceof RangeError && !glueErrors.has(e));

/** The library: its free functions, and `connectionNew`. */
export class Comline {
  #x;
  #dead = false;
  #version;
  // The regions: 8-aligned addresses, and how many bytes from there are
  // the glue's (0 before the first reserve).
  #inPtr = 0;
  #inCap = 0;
  #outPtr = 0;
  #outCap = 0;
  // Views of memory as it was when last seen.
  #buffer = null;
  #u8 = null;
  #dv = null;

  /** Prefer `instantiate`. Checks the version and the layout, as it says. */
  constructor(exports) {
    this.#x = exports;
    const version = exports.comline_abi_version() >>> 0;
    if (version !== ((ABI_MAJOR << 16) | ABI_MINOR)) {
      throw new Error(
        `comline: the module is ABI ${version >>> 16}.${version & 0xffff}, this glue ${ABI_MAJOR}.${ABI_MINOR}`,
      );
    }
    this.#version = version;
    this.#checkLayout();
  }

  /**
   * The layouts above, proven against the module: a `datagram@2` request
   * fed through a connection (which proves `comline_config` too) must read
   * back field by field, and `feed` must write nothing past 48 bytes.
   */
  #checkLayout() {
    const { status, connection } = this.connectionNew({
      framing: "datagram@2",
      handshake: Handshake.NONE,
    });
    if (status !== Status.OK) {
      throw new Error(`comline: the layout check's connection gave status ${status}`);
    }
    try {
      // Kind 0, protocol 5, call 0x0203, request id 0x0807060504030201, body "x".
      const frame = Uint8Array.of(0, 5, 3, 2, 1, 2, 3, 4, 5, 6, 7, 8, 0x78);
      const want = {
        kind: EventKind.REQUEST, flags: EventFlag.HAS_PROTOCOL, protocol: 5, callId: 0x0203,
        envelope: 0, errorId: 0, callName: { offset: 0, len: 0 }, body: { offset: 12, len: 1 },
        frame: { offset: 0, len: 13 }, capabilities: 0, requestId: 0x0807060504030201n,
      };
      const fed = this._feed(connection.handle, frame, 8);
      const same = JSON.stringify(fed.event, big) === JSON.stringify(want, big);
      if (fed.status !== Status.OK || fed.consumed !== 13 || !same || !fed.tailIntact) {
        throw new Error(`comline: comline_event isn't the ${EVENT_SIZE}-byte layout this glue reads`);
      }
    } finally {
      connection.free();
    }
  }

  /** Whether a trap killed this instance: every call now returns
   * `ERR_POISONED` without entering the module. */
  get poisoned() {
    return this.#dead;
  }

  // ── memory ──────────────────────────────────────────────────────────────

  /** Make sure `in` holds `inLen` bytes and `out` holds `outLen`, reserving
   * only a region that is too small, and take the views again if memory
   * grew. */
  #room(inLen, outLen) {
    if (inLen > this.#inCap) {
      const [ptr, cap] = this.#reserve(this.#x.comline_wasm_reserve_in, inLen, this.#inCap);
      this.#inPtr = ptr;
      this.#inCap = cap;
    }
    if (outLen > this.#outCap) {
      const [ptr, cap] = this.#reserve(this.#x.comline_wasm_reserve_out, outLen, this.#outCap);
      this.#outPtr = ptr;
      this.#outCap = cap;
    }
    this.#sync();
  }

  /** Reserve room for at least `len` bytes, 8-aligned, growing by half at
   * least, so a slowly growing size doesn't reserve on every call. */
  #reserve(reserve, len, cap) {
    const want = Math.max(len, cap + (cap >>> 1), REGION_MIN);
    const ptr = reserve(want + 8) >>> 0;
    if (ptr === 0) {
      const e = new RangeError("comline: wasm memory can't grow");
      glueErrors.add(e);
      throw e;
    }
    const aligned = align8(ptr);
    return [aligned, want + 8 - (aligned - ptr)];
  }

  /** Take the views again if memory grew since they were taken. */
  #sync() {
    const buffer = this.#x.memory.buffer;
    if (buffer !== this.#buffer) {
      this.#buffer = buffer;
      this.#u8 = new Uint8Array(buffer);
      this.#dv = new DataView(buffer);
    }
  }

  /** Lay `parts` out in `in` from `base`, each 8-aligned; their addresses. */
  static #place(u8, base, parts) {
    const ptrs = [];
    let at = base;
    for (const part of parts) {
      u8.set(part, at);
      ptrs.push(at);
      at = align8(at + part.length);
    }
    return ptrs;
  }

  static #size(parts) {
    return parts.reduce((n, p) => n + align8(p.length), 0);
  }

  /** A call that threw: a trap kills the instance and gives `result`;
   * anything else is thrown on. */
  #fail(e, result) {
    if (!isTrap(e)) throw e;
    this.#dead = true;
    return result;
  }

  // ── free functions ──────────────────────────────────────────────────────

  /** `comline_abi_version`: `(major << 16) | minor`, as read at load. */
  abiVersion() {
    return this.#version;
  }

  /** `comline_supports`: whether the named framing or handshake works on a
   * connection. False on a poisoned instance. */
  supports(name) {
    if (this.#dead) return false;
    const n = bytesOf(name);
    try {
      this.#room(n.length, 0);
      this.#u8.set(n, this.#inPtr);
      return this.#x.comline_supports(this.#inPtr, n.length) === 1;
    } catch (e) {
      return this.#fail(e, false);
    }
  }

  /** `comline_name_hash`: `{ status, hash }`, `hash` a BigInt. */
  nameHash(name) {
    if (this.#dead) return { status: POISONED };
    const n = bytesOf(name);
    try {
      this.#room(n.length, 8);
      const outPtr = this.#outPtr;
      this.#u8.set(n, this.#inPtr);
      const status = this.#x.comline_name_hash(this.#inPtr, n.length, outPtr);
      this.#sync();
      const hash = status === Status.OK ? this.#dv.getBigUint64(outPtr, true) : undefined;
      return { status, hash };
    } catch (e) {
      return this.#fail(e, { status: POISONED });
    }
  }

  /**
   * `comline_handshake_encode`: `{ status, written, bytes }`. `written` is
   * the size needed on `BUFFER_TOO_SMALL`; `bytes` is there on `OK`.
   */
  handshakeEncode(irHash, wireFormat, framing, capabilities, cap) {
    if (this.#dead) return { status: POISONED, written: 0 };
    const w = bytesOf(wireFormat);
    const f = bytesOf(framing);
    const ir = u64(irHash);
    try {
      this.#room(Comline.#size([w, f]), 8 + cap);
      const outPtr = this.#outPtr;
      const [wPtr, fPtr] = Comline.#place(this.#u8, this.#inPtr, [w, f]);
      this.#dv.setUint32(outPtr, 0, true);
      const status = this.#x.comline_handshake_encode(
        ir, wPtr, w.length, fPtr, f.length, capabilities >>> 0, outPtr + 8, cap, outPtr,
      );
      return this.#written(status, outPtr, outPtr + 8);
    } catch (e) {
      return this.#fail(e, { status: POISONED, written: 0 });
    }
  }

  /**
   * `comline_handshake_check`: `{ status, peer }`. `peer` is the peer's
   * frame (names hashed) whenever it parses, agreeing or not, and null when
   * the ABI didn't write it.
   */
  handshakeCheck(ours, peer) {
    if (this.#dead) return { status: POISONED, peer: null };
    const o = bytesOf(ours);
    const p = bytesOf(peer);
    try {
      this.#room(Comline.#size([o, p]), HANDSHAKE_SIZE);
      const outPtr = this.#outPtr;
      const [oPtr, pPtr] = Comline.#place(this.#u8, this.#inPtr, [o, p]);
      // A sentinel in `_reserved`, which a written frame holds as 0.
      this.#u8.fill(0, outPtr, outPtr + HANDSHAKE_SIZE);
      this.#dv.setUint32(outPtr + 28, 0xdead, true);
      const status = this.#x.comline_handshake_check(oPtr, o.length, pPtr, p.length, outPtr);
      this.#sync();
      const dv = this.#dv;
      const written = dv.getUint32(outPtr + 28, true) !== 0xdead;
      return {
        status,
        peer: written
          ? {
              irHash: dv.getBigUint64(outPtr, true),
              wireFormat: dv.getBigUint64(outPtr + 8, true),
              framing: dv.getBigUint64(outPtr + 16, true),
              capabilities: dv.getUint32(outPtr + 24, true),
            }
          : null,
      };
    } catch (e) {
      return this.#fail(e, { status: POISONED, peer: null });
    }
  }

  /**
   * `comline_method_name_unescape`: `{ status, written, bytes }`, as
   * `handshakeEncode`. `spelled` is a `callName` span's bytes.
   */
  methodNameUnescape(spelled, cap) {
    if (this.#dead) return { status: POISONED, written: 0 };
    const s = bytesOf(spelled);
    try {
      this.#room(s.length, 8 + cap);
      const outPtr = this.#outPtr;
      this.#u8.set(s, this.#inPtr);
      this.#dv.setUint32(outPtr, 0, true);
      const status = this.#x.comline_method_name_unescape(
        this.#inPtr, s.length, outPtr + 8, cap, outPtr,
      );
      return this.#written(status, outPtr, outPtr + 8);
    } catch (e) {
      return this.#fail(e, { status: POISONED, written: 0 });
    }
  }

  /**
   * `comline_connection_new`: `{ status, connection }`, `connection` a
   * `Connection` on `OK` and null otherwise. Fields left out are 0, as in a
   * zeroed `comline_config` (so `handshake` defaults to `COMLINE`).
   *
   * @param {import("./comline.d.mts").Config} config
   */
  connectionNew(config) {
    if (this.#dead) return { status: POISONED, connection: null };
    const w = bytesOf(config.wireFormat ?? "");
    const f = bytesOf(config.framing ?? "");
    const irHash = u64(config.irHash ?? 0);
    const maxFrame = u64(config.maxFrame ?? 0);
    try {
      this.#room(CONFIG_SIZE + Comline.#size([w, f]), 4);
      const c = this.#inPtr;
      const outPtr = this.#outPtr;
      const u8 = this.#u8;
      const dv = this.#dv;
      const [wPtr, fPtr] = Comline.#place(u8, c + CONFIG_SIZE, [w, f]);
      u8.fill(0, c, c + CONFIG_SIZE);
      dv.setBigUint64(c + CONFIG.irHash, irHash, true);
      dv.setUint32(c + CONFIG.wireFormat, wPtr, true);
      dv.setUint32(c + CONFIG.wireFormatLen, w.length, true);
      dv.setUint32(c + CONFIG.framing, fPtr, true);
      dv.setUint32(c + CONFIG.framingLen, f.length, true);
      dv.setBigUint64(c + CONFIG.maxFrame, maxFrame, true);
      dv.setUint32(c + CONFIG.capabilities, (config.capabilities ?? 0) >>> 0, true);
      dv.setUint32(c + CONFIG.maxWaiting, (config.maxWaiting ?? 0) >>> 0, true);
      dv.setUint8(c + CONFIG.handshake, config.handshake ?? 0);
      dv.setUint8(c + CONFIG.stream, config.stream ? 1 : 0);
      dv.setUint8(c + CONFIG.unordered, config.unordered ? 1 : 0);
      dv.setUint32(outPtr, 0, true);
      const status = this.#x.comline_connection_new(c, outPtr);
      // `new` allocates the handle, which may grow memory.
      this.#sync();
      const handle = this.#dv.getUint32(outPtr, true);
      return {
        status,
        connection: status === Status.OK ? new Connection(this, handle) : null,
      };
    } catch (e) {
      return this.#fail(e, { status: POISONED, connection: null });
    }
  }

  // ── for Connection ──────────────────────────────────────────────────────

  /** `{ status, written, bytes }` from a `*written` at `writtenPtr` and
   * bytes at `bytesPtr`. */
  #written(status, writtenPtr, bytesPtr) {
    this.#sync();
    const written = this.#dv.getUint32(writtenPtr, true);
    const result = { status, written };
    if (status === Status.OK) {
      result.bytes = this.#u8.slice(bytesPtr, bytesPtr + written);
    }
    return result;
  }

  /** @internal */
  _start(handle, cap) {
    if (this.#dead) return { status: POISONED, written: 0 };
    try {
      this.#room(0, 8 + cap);
      const outPtr = this.#outPtr;
      this.#dv.setUint32(outPtr, 0, true);
      const status = this.#x.comline_connection_start(handle, outPtr + 8, cap, outPtr);
      return this.#written(status, outPtr, outPtr + 8);
    } catch (e) {
      return this.#fail(e, { status: POISONED, written: 0 });
    }
  }

  /** @internal `watch` bytes after the event are checked untouched
   * (`tailIntact`), for the layout check. */
  _feed(handle, input, watch = 0) {
    if (this.#dead) return { status: POISONED, consumed: 0, event: zeroEvent() };
    const i = bytesOf(input);
    try {
      this.#room(i.length, 8 + EVENT_SIZE + watch);
      const outPtr = this.#outPtr;
      const evPtr = outPtr + 8;
      const u8 = this.#u8;
      u8.set(i, this.#inPtr);
      u8.fill(0, outPtr, evPtr + EVENT_SIZE);
      u8.fill(0xa5, evPtr + EVENT_SIZE, evPtr + EVENT_SIZE + watch);
      const status = this.#x.comline_connection_feed(handle, this.#inPtr, i.length, outPtr, evPtr);
      // `jsonrpc@1`'s decode can allocate (runtime#58), which may grow
      // memory.
      this.#sync();
      const dv = this.#dv;
      const result = {
        status,
        consumed: dv.getUint32(outPtr, true),
        event: readEvent(dv, evPtr),
      };
      if (watch) {
        const tail = evPtr + EVENT_SIZE;
        result.tailIntact = this.#u8.subarray(tail, tail + watch).every((b) => b === 0xa5);
      }
      return result;
    } catch (e) {
      return this.#fail(e, { status: POISONED, consumed: 0, event: zeroEvent() });
    }
  }

  /** @internal */
  _encodeRequest(handle, protocol, callId, name, expectsReply, body, cap) {
    if (this.#dead) return { status: POISONED, written: 0 };
    const n = bytesOf(name);
    const b = bytesOf(body);
    const reply = typeof expectsReply === "boolean" ? (expectsReply ? 1 : 0) : expectsReply;
    try {
      this.#room(Comline.#size([n, b]), 16 + cap);
      const outPtr = this.#outPtr;
      const [nPtr, bPtr] = Comline.#place(this.#u8, this.#inPtr, [n, b]);
      this.#dv.setUint32(outPtr, 0, true);
      this.#dv.setBigUint64(outPtr + 8, 0n, true);
      const status = this.#x.comline_connection_encode_request(
        handle, protocol, callId, nPtr, n.length, reply, bPtr, b.length,
        outPtr + 16, cap, outPtr, outPtr + 8,
      );
      const result = this.#written(status, outPtr, outPtr + 16);
      if (status === Status.OK) {
        result.requestId = this.#dv.getBigUint64(outPtr + 8, true);
      }
      return result;
    } catch (e) {
      return this.#fail(e, { status: POISONED, written: 0 });
    }
  }

  /** @internal */
  _encodeReply(handle, protocol, requestId, envelope, errorId, body, cap) {
    if (this.#dead) return { status: POISONED, written: 0 };
    const b = bytesOf(body);
    const id = u64(requestId);
    try {
      this.#room(b.length, 8 + cap);
      const outPtr = this.#outPtr;
      this.#u8.set(b, this.#inPtr);
      this.#dv.setUint32(outPtr, 0, true);
      const status = this.#x.comline_connection_encode_reply(
        handle, protocol, id, envelope, errorId, this.#inPtr, b.length, outPtr + 8, cap, outPtr,
      );
      return this.#written(status, outPtr, outPtr + 8);
    } catch (e) {
      return this.#fail(e, { status: POISONED, written: 0 });
    }
  }

  /** @internal */
  _abandon(handle, requestId) {
    if (this.#dead) return POISONED;
    const id = u64(requestId);
    try {
      return this.#x.comline_connection_abandon(handle, id);
    } catch (e) {
      return this.#fail(e, POISONED);
    }
  }

  /** @internal */
  _isWaiting(handle) {
    if (this.#dead) return { status: POISONED };
    try {
      this.#room(0, 1);
      const outPtr = this.#outPtr;
      this.#dv.setUint8(outPtr, 0xff);
      const status = this.#x.comline_connection_is_waiting(handle, outPtr);
      this.#sync();
      const waiting = this.#dv.getUint8(outPtr);
      return { status, waiting: status === Status.OK ? waiting === 1 : undefined };
    } catch (e) {
      return this.#fail(e, { status: POISONED });
    }
  }

  /** @internal On a poisoned instance there's nothing to free: the module
   * goes with the instance. */
  _free(handle) {
    if (this.#dead) return;
    try {
      this.#x.comline_connection_free(handle);
    } catch (e) {
      this.#fail(e, undefined);
    }
  }
}

/** One end of a connection: a `comline_connection *`. Free it with
 * `free()`; nothing frees it for you. Once its instance is poisoned, every
 * call returns `ERR_POISONED`. */
export class Connection {
  #lib;
  #handle;

  /** @internal Made by `Comline.connectionNew`. */
  constructor(lib, handle) {
    this.#lib = lib;
    this.#handle = handle;
  }

  /** @internal The `comline_connection *`, 0 once freed. */
  get handle() {
    return this.#handle;
  }

  /** `comline_connection_start`: `{ status, written, bytes }`. */
  start(cap) {
    return this.#lib._start(this.#live(), cap);
  }

  /**
   * `comline_connection_feed`: `{ status, consumed, event }`. Spans in
   * `event` are offsets into `input`.
   */
  feed(input) {
    return this.#lib._feed(this.#live(), input);
  }

  /**
   * `comline_connection_encode_request`: `{ status, written, bytes,
   * requestId }`; `requestId` (a BigInt) and `bytes` on `OK`.
   */
  encodeRequest(protocol, callId, name, expectsReply, body, cap) {
    return this.#lib._encodeRequest(this.#live(), protocol, callId, name, expectsReply, body, cap);
  }

  /** `comline_connection_encode_reply`: `{ status, written, bytes }`. */
  encodeReply(protocol, requestId, envelope, errorId, body, cap) {
    return this.#lib._encodeReply(this.#live(), protocol, requestId, envelope, errorId, body, cap);
  }

  /** `comline_connection_abandon`: the status. */
  abandon(requestId) {
    return this.#lib._abandon(this.#live(), requestId);
  }

  /** `comline_connection_is_waiting`: `{ status, waiting }`. */
  isWaiting() {
    return this.#lib._isWaiting(this.#live());
  }

  /** `comline_connection_free`. The connection is unusable afterwards;
   * freeing twice is a no-op here, and so is freeing on a poisoned
   * instance. */
  free() {
    if (this.#handle !== 0) {
      this.#lib._free(this.#handle);
      this.#handle = 0;
    }
  }

  #live() {
    if (this.#handle === 0) throw new Error("comline: the connection was freed");
    return this.#handle;
  }
}

/** A `comline_event` at `ptr`. */
function readEvent(dv, ptr) {
  const span = (at) => ({
    offset: dv.getUint32(ptr + at, true),
    len: dv.getUint32(ptr + at + 4, true),
  });
  return {
    kind: dv.getUint8(ptr + EVENT.kind),
    flags: dv.getUint8(ptr + EVENT.flags),
    protocol: dv.getUint16(ptr + EVENT.protocol, true),
    callId: dv.getUint16(ptr + EVENT.callId, true),
    envelope: dv.getUint8(ptr + EVENT.envelope),
    errorId: dv.getUint16(ptr + EVENT.errorId, true),
    callName: span(EVENT.callName),
    body: span(EVENT.body),
    frame: span(EVENT.frame),
    capabilities: dv.getUint32(ptr + EVENT.capabilities, true),
    requestId: dv.getBigUint64(ptr + EVENT.requestId, true),
  };
}

/** A zeroed `comline_event`, as a poisoned `feed` gives. */
function zeroEvent() {
  return readEvent(new DataView(new ArrayBuffer(EVENT_SIZE)), 0);
}

const big = (_, v) => (typeof v === "bigint" ? v.toString() : v);
