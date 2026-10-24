// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Call, ConnectionFraming, Envelope, Frame } from "../contract.js";
import { FRAMING_DATAGRAM2 } from "../handshake.js";
import {
  decodeEnvelope,
  encodeEnvelopeErr,
  encodeEnvelopeFault,
  encodeEnvelopeOk,
} from "../envelope.js";

const KIND_REQUEST = 0;
const KIND_REPLY = 1;
const MAX_PROTOCOL = 0xffff;

/**
 * The Comline datagram framing, version 2: `datagram@1` plus a kind byte and
 * the protocol number, so both ends can start calls and several protocols
 * share a connection. Matches `comline_runtime::contract::Datagram2Framing`:
 * request `[0][protocol varint][call_id:u16 LE][request_id:u64 LE][params]`,
 * reply `[1][protocol varint][request_id:u64 LE][envelope]`.
 *
 * The protocol number is an unsigned LEB128 varint, one byte below 128, and
 * only its shortest form is accepted.
 */
export class Datagram2Framing implements ConnectionFraming {
  readonly name = FRAMING_DATAGRAM2;

  encodeRequest(protocol: number, call: Call, requestId: bigint, params: Uint8Array): Uint8Array {
    const head = [KIND_REQUEST, ...varint(protocol)];
    const out = new Uint8Array(head.length + 10 + params.length);
    out.set(head);
    const view = new DataView(out.buffer);
    view.setUint16(head.length, call.id, true);
    view.setBigUint64(head.length + 2, requestId, true);
    out.set(params, head.length + 10);
    return out;
  }

  encodeReply(protocol: number, requestId: bigint, reply: Envelope): Uint8Array {
    const envelope =
      "ok" in reply
        ? encodeEnvelopeOk(reply.ok)
        : "err" in reply
          ? encodeEnvelopeErr(reply.err.id, reply.err.body)
          : encodeEnvelopeFault();
    const head = [KIND_REPLY, ...varint(protocol)];
    const out = new Uint8Array(head.length + 8 + envelope.length);
    out.set(head);
    new DataView(out.buffer).setBigUint64(head.length, requestId, true);
    out.set(envelope, head.length + 8);
    return out;
  }

  decode(frame: Uint8Array): Frame | undefined {
    const kind = frame[0];
    const taken = takeVarint(frame, 1);
    if (taken === undefined) return undefined;
    const [protocol, at] = taken;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    if (kind === KIND_REQUEST) {
      if (frame.length < at + 10) return undefined;
      return {
        kind: "request",
        protocol,
        oneWay: false,
        request: {
          call: { id: view.getUint16(at, true) },
          requestId: view.getBigUint64(at + 2, true),
          params: frame.subarray(at + 10),
        },
      };
    }
    if (kind === KIND_REPLY) {
      if (frame.length < at + 8) return undefined;
      const envelope = decodeEnvelope(frame.subarray(at + 8));
      if (!envelope) return undefined;
      return { kind: "reply", protocol, requestId: view.getBigUint64(at, true), envelope };
    }
    return undefined;
  }
}

function varint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > MAX_PROTOCOL) {
    throw new RangeError(`protocol number ${value} isn't a u16`);
  }
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value);
  return out;
}

/** The varint at `at` in its shortest form, and the offset after it. */
function takeVarint(bytes: Uint8Array, at: number): [number, number] | undefined {
  let value = 0;
  for (let i = 0; i < 3 && at + i < bytes.length; i++) {
    const byte = bytes[at + i]!;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      if (i > 0 && byte === 0) return undefined; // overlong
      return value > MAX_PROTOCOL ? undefined : [value, at + i + 1];
    }
  }
  return undefined;
}
