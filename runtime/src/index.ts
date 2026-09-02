// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `@comline/runtime` — the TypeScript runtime that Comline-generated RPC
 * bindings link against. This first cut is the framing-agnostic contract plus
 * a JSON codec; `Framing`, `Transport`, `Client`, and `Server` follow.
 */

export {
  RuntimeError,
  type RuntimeErrorKind,
  type Kind,
  resolveKind,
  type Call,
  call,
  type Envelope,
  type Outcome,
  Reply,
  type CallError,
  type Codec,
  type Dispatch,
} from "./contract.js";

export {
  FRAMING_DATAGRAM,
  nameHash,
  Handshake,
  type HandshakeInit,
} from "./handshake.js";

export { JsonCodec } from "./codec.js";
