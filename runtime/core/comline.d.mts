// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Types for `comline.mjs`, the JS glue over the wasm32 build of
// `comline-runtime-ffi` (`.d.mts`, the name TypeScript looks for beside a
// `.mjs`). Each method is one `comline.h` function; see there for what it
// does and when it fails.
//
// On wasm32 a trap (a panic in the module) poisons the whole instance, not
// just the handle: the call that trapped returns `Status.ERR_POISONED`, and
// so does every later call on the `Comline` and on every `Connection` from
// it, without entering the module. Drop them and instantiate again. A
// poisoned result has the fields its type always has zeroed; `supports` is
// false. See `comline.mjs`.

export declare const ABI_MAJOR: 0;
export declare const ABI_MINOR: 1;

/** `comline_status`. Below 16 is an outcome, 16 and up an error; a number
 * not listed is a code from a newer library. */
export declare const Status: Readonly<{
  OK: 0;
  NEED_MORE: 1;
  BUFFER_TOO_SMALL: 2;
  ERR_FRAMING: 16;
  ERR_HANDSHAKE: 17;
  ERR_FRAME_TOO_LARGE: 18;
  ERR_UNKNOWN_FRAMING: 19;
  ERR_INVALID_ARGUMENT: 20;
  ERR_STATE: 21;
  ERR_POISONED: 22;
  ERR_BUSY: 23;
}>;
export type Status = number;

export declare const Handshake: Readonly<{ COMLINE: 0; NONE: 1 }>;
export declare const EventKind: Readonly<{ HANDSHAKE_OK: 0; REQUEST: 1; REPLY: 2; STALE: 3 }>;
export declare const EventFlag: Readonly<{
  HAS_PROTOCOL: 1;
  ONE_WAY: 2;
  CALL_BY_NAME: 4;
  BODY_ABSENT: 8;
  NAME_ESCAPED: 16;
}>;
export declare const Envelope: Readonly<{ OK: 0; ERR: 1; FAULT: 2 }>;

export declare const DEFAULT_MAX_FRAME: number;
export declare const MAX_FRAME_CEILING: number;
export declare const PREFIX_LEN: 4;
export declare const HANDSHAKE_LEN: 31;

/** A name or a body: a string is encoded as UTF-8, bytes go as they are. */
export type Bytes = string | Uint8Array;

/** `comline_config`. A field left out is 0, as in a zeroed struct. */
export interface Config {
  irHash?: bigint | number;
  wireFormat?: Bytes;
  framing?: Bytes;
  maxFrame?: bigint | number;
  capabilities?: number;
  maxWaiting?: number;
  /** `Handshake.COMLINE` (0, the default) or `Handshake.NONE`. */
  handshake?: number;
  stream?: boolean;
  unordered?: boolean;
}

/** `comline_span`: a part of the input fed. */
export interface Span {
  offset: number;
  len: number;
}

/** `comline_event`. */
export interface Event {
  kind: number;
  flags: number;
  protocol: number;
  callId: number;
  envelope: number;
  errorId: number;
  callName: Span;
  body: Span;
  frame: Span;
  capabilities: number;
  requestId: bigint;
}

/** A decoded `comline@1` frame, names hashed. */
export interface Peer {
  irHash: bigint;
  wireFormat: bigint;
  framing: bigint;
  capabilities: number;
}

/** An `out` / `cap` / `*written` call. `written` is the size needed on
 * `BUFFER_TOO_SMALL`; `bytes`, a copy, is there on `OK`. */
export interface Written {
  status: Status;
  written: number;
  bytes?: Uint8Array;
}

export interface Fed {
  status: Status;
  consumed: number;
  event: Event;
}

/** Compile (unless given a module) and instantiate the wasm32 build, then
 * check its ABI version and the `comline_event` layout. */
export declare function instantiate(source: BufferSource | WebAssembly.Module): Promise<Comline>;

/** `instantiate`, synchronously, with the same checks. For Node and
 * workers: a browser's main thread refuses to compile a module this size
 * synchronously. */
export declare function instantiateSync(source: BufferSource | WebAssembly.Module): Comline;

/** Instantiate from a `fetch` response, compiling as it downloads, with the
 * same checks. Falls back to reading the whole body when the engine has no
 * `WebAssembly.instantiateStreaming` or the response's content type isn't
 * `application/wasm`; a response that isn't `ok` is refused. */
export declare function instantiateStreaming(
  source: Response | PromiseLike<Response>,
): Promise<Comline>;

/** What `encodeBound` sizes. Leaving out a field it can use gives a looser
 * bound, never a smaller one. */
export type EncodeBoundArgs = {
  framing: "datagram@2" | "jsonrpc@1";
  /** The connection's `stream`: a 4-byte prefix is counted. */
  stream?: boolean;
  /** The body's length, as given to the encode. */
  bodyLen: number;
  /** `datagram@2`: exact with it, the varint's most (3 bytes) without. */
  protocol?: number;
} & (
  | {
      kind: "request";
      /** `jsonrpc@1`: the method name, counted escaped exactly. */
      name?: Bytes;
      /** `jsonrpc@1`, without `name`: its UTF-8 length, counted at 6 bytes
       * a byte (`\u00XX`). */
      nameLen?: number;
      /** `jsonrpc@1`: a one-way call (`false`) has no `id`. Counted with
       * one when left out. */
      expectsReply?: boolean | number;
      /** `jsonrpc@1`: the id the request will be given, when known; 20
       * digits otherwise. */
      requestId?: bigint | number;
    }
  | {
      kind: "reply";
      envelope: number;
      /** `jsonrpc@1`: the request id answered; 20 digits without it. */
      requestId?: bigint | number;
      /** `jsonrpc@1`, `Envelope.ERR`: the error id; 5 digits without it. */
      errorId?: number;
    }
);

/** The most bytes an encode can write (`*written`, a stream's prefix
 * included), to size `cap` so it never retries: never smaller than what
 * the ABI writes, and exactly that when every field the frame holds is
 * given. Pure; needs no instance. */
export declare function encodeBound(args: EncodeBoundArgs): number;

export declare class Comline {
  private constructor();
  /** Whether a trap killed this instance. */
  readonly poisoned: boolean;
  abiVersion(): number;
  supports(name: Bytes): boolean;
  nameHash(name: Bytes): { status: Status; hash?: bigint };
  handshakeEncode(
    irHash: bigint | number,
    wireFormat: Bytes,
    framing: Bytes,
    capabilities: number,
    cap: number,
  ): Written;
  /** `peer` is null when the ABI didn't write it (the frame didn't parse). */
  handshakeCheck(ours: Uint8Array, peer: Uint8Array): { status: Status; peer: Peer | null };
  methodNameUnescape(spelled: Uint8Array, cap: number): Written;
  connectionNew(config: Config): { status: Status; connection: Connection | null };
}

/** A `comline_connection *`. Free it with `free()`; nothing frees it for
 * you. Once its instance is poisoned, every call returns `ERR_POISONED`
 * and `free()` does nothing. */
export declare class Connection {
  private constructor();
  start(cap: number): Written;
  feed(input: Uint8Array): Fed;
  encodeRequest(
    protocol: number,
    callId: number,
    name: Bytes,
    expectsReply: boolean | number,
    body: Bytes,
    cap: number,
  ): Written & { requestId?: bigint };
  /** `encodeRequest`, the frame copied into `dest` (which the caller owns;
   * `cap` is its length) rather than a new array; the frame is
   * `dest.subarray(0, written)` on `OK`. `BUFFER_TOO_SMALL` gives the size
   * needed and leaves `dest` as it was. A view of the instance's wasm memory
   * (or any `SharedArrayBuffer` when that memory is shared) is refused with
   * `ERR_INVALID_ARGUMENT`, without entering the module. The `out` region
   * grows to `dest.length`, so pass a subarray when `dest` is much bigger
   * than the frames. */
  encodeRequestInto(
    dest: Uint8Array,
    protocol: number,
    callId: number,
    name: Bytes,
    expectsReply: boolean | number,
    body: Bytes,
  ): { status: Status; written: number; requestId?: bigint };
  /** `encodeReply` into `dest`, as `encodeRequestInto`. */
  encodeReplyInto(
    dest: Uint8Array,
    protocol: number,
    requestId: bigint | number,
    envelope: number,
    errorId: number,
    body: Bytes,
  ): { status: Status; written: number };
  encodeReply(
    protocol: number,
    requestId: bigint | number,
    envelope: number,
    errorId: number,
    body: Bytes,
    cap: number,
  ): Written;
  abandon(requestId: bigint | number): Status;
  isWaiting(): { status: Status; waiting?: boolean };
  free(): void;
}
