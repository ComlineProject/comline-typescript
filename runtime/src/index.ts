// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `@comline/runtime` — the TypeScript runtime that Comline-generated RPC
 * bindings link against. The framing-agnostic contract, three framings, an
 * in-memory transport, a `Client` / `Server`, and a `Connection` carrying
 * calls in both directions. The generator emitting a
 * `<Proto>Client` / dispatcher against this package, and a stream transport,
 * follow.
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
  type RequestCall,
  type DecodedRequest,
  type DecodedResponse,
  type Framing,
  type Frame,
  type ConnectionFraming,
  type ConnectionId,
  type Peer,
  type CallOptions,
  Extensions,
} from "./contract.js";

export {
  FRAMING_DATAGRAM,
  FRAMING_DATAGRAM2,
  FRAMING_JSONRPC,
  FORMAT_JSON,
  FORMAT_PACKED,
  HANDSHAKE_COMLINE,
  HANDSHAKE_NONE,
  nameHash,
  HandshakeFrame,
  type Facts,
  type Handshake,
  ComlineHandshake,
  NoHandshake,
} from "./handshake.js";

export { JsonCodec } from "./codec.js";
export { type Shape } from "./json.js";
export { PackedCodec, type Layout, jsonShape } from "./packed.js";

export {
  encodeEnvelopeOk,
  encodeEnvelopeErr,
  encodeEnvelopeFault,
  decodeEnvelope,
} from "./envelope.js";

export { DatagramFraming } from "./framing/datagram.js";
export { Datagram2Framing } from "./framing/datagram2.js";
export { JsonRpcConnectionFraming, JsonRpcFraming } from "./framing/jsonrpc.js";

export { type Transport, type InMemoryTransport, duplex } from "./transport.js";

export { Client } from "./client.js";
export { Server } from "./server.js";
export { Connection } from "./connection.js";
