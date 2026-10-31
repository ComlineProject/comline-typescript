// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The binding layer: the runtime's view of the Comline core. `Core` wraps the
// glue's `Comline` (one per realm, from `loadCore()`), turns every status into
// a result or a `RuntimeError`, and discards a poisoned instance so the next
// load makes a fresh one. Internal: nothing here is exported from the
// package.

import { Status, type Comline } from "#core/comline.mjs";

import { RuntimeError, type RuntimeErrorKind } from "../contract.js";
import { discardCore, loadCore } from "./load.js";

/** The `comline@1` frame's length (`HANDSHAKE_LEN`). */
const HANDSHAKE_LEN = 31;

/**
 * The `RuntimeError` for a status that isn't `OK`. An error status maps to
 * its own kind; anything else (an outcome the call doesn't expect, a misused
 * argument or state, a code this binding doesn't know) is an error of the
 * operation's `kind`, never success.
 */
export function statusError(status: number, kind: RuntimeErrorKind): RuntimeError {
  switch (status) {
    case Status.ERR_FRAMING:
    case Status.ERR_UNKNOWN_FRAMING:
      return RuntimeError.framing();
    case Status.ERR_HANDSHAKE:
      return RuntimeError.handshake();
    case Status.ERR_FRAME_TOO_LARGE:
      return RuntimeError.frameTooLarge();
    case Status.ERR_BUSY:
      return RuntimeError.busy();
    case Status.ERR_POISONED:
      return RuntimeError.poisoned();
    default:
      return new RuntimeError(kind);
  }
}

export class Core {
  readonly #lib: Comline;

  /** Wraps `lib`; {@link loadedCore} / {@link currentCore} are the usual way in. */
  constructor(lib: Comline) {
    this.#lib = lib;
  }

  /** Throws unless `status` is `OK`; a poisoned instance is discarded first. */
  #ok(status: number, kind: RuntimeErrorKind): void {
    if (status === Status.OK) return;
    if (status === Status.ERR_POISONED || this.#lib.poisoned) {
      discardCore(this.#lib);
      if (current?.lib === this.#lib) current = undefined;
    }
    throw statusError(status, kind);
  }

  /** `comline_name_hash`: 64-bit FNV-1a over the name's UTF-8. */
  nameHash(name: string): bigint {
    const { status, hash } = this.#lib.nameHash(name);
    this.#ok(status, "handshake");
    return hash as bigint;
  }

  /** `comline_handshake_encode`: our 31-byte `comline@1` frame. */
  handshakeEncode(
    irHash: bigint,
    wireFormat: string,
    framing: string,
    capabilities: number | undefined,
  ): Uint8Array {
    const { status, bytes } = this.#lib.handshakeEncode(
      irHash,
      wireFormat,
      framing,
      (capabilities ?? 0) >>> 0,
      HANDSHAKE_LEN,
    );
    this.#ok(status, "handshake");
    return bytes as Uint8Array;
  }

  /**
   * `comline_handshake_check`: throws `RuntimeError("handshake")` unless
   * `peer` is a `comline@1` frame naming the same schema, format and framing
   * as `ours` (capability bits may differ).
   */
  handshakeCheck(ours: Uint8Array, peer: Uint8Array): void {
    this.#ok(this.#lib.handshakeCheck(ours, peer).status, "handshake");
  }
}

let current: { lib: Comline; core: Core } | undefined;

/** The realm's `Core`, loading the core on the first call. */
export async function loadedCore(): Promise<Core> {
  const lib = await loadCore();
  if (current?.lib !== lib) current = { lib, core: new Core(lib) };
  return current.core;
}

/** The realm's `Core` if it's already loaded (and not poisoned), without
 * waiting. */
export function currentCore(): Core | undefined {
  return current?.core;
}
