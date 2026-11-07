// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Call, ConnectionFraming, Envelope, Frame } from "../contract.js";
import { FRAMING_DATAGRAM3 } from "../handshake.js";
import { Datagram2Framing } from "./datagram2.js";

const KIND_REQUEST = 0;
const MAX_NUMBER = 0xffff;

/**
 * The Comline datagram framing, version 3: `datagram@2` with a call addressed
 * by wire numbers. Matches `comline_runtime::contract::Datagram3Framing`:
 * request `[0][protocol varint][function varint][request_id:u64 LE][params]`,
 * reply `[1][protocol varint][request_id:u64 LE][envelope]`, byte for byte a
 * `datagram@2` reply.
 *
 * Both numbers are the wire numbers core gives each protocol and function,
 * which reordering or inserting functions doesn't move. A call's `id` is the
 * function's. Each is an unsigned LEB128 varint in its shortest form.
 */
export class Datagram3Framing implements ConnectionFraming {
  readonly name = FRAMING_DATAGRAM3;
  readonly #replies = new Datagram2Framing();

  encodeRequest(protocol: number, call: Call, requestId: bigint, params: Uint8Array): Uint8Array {
    const head = [KIND_REQUEST, ...varint(protocol), ...varint(call.id)];
    const out = new Uint8Array(head.length + 8 + params.length);
    out.set(head);
    new DataView(out.buffer).setBigUint64(head.length, requestId, true);
    out.set(params, head.length + 8);
    return out;
  }

  encodeReply(protocol: number, requestId: bigint, reply: Envelope): Uint8Array {
    return this.#replies.encodeReply(protocol, requestId, reply);
  }

  decode(frame: Uint8Array): Frame | undefined {
    if (frame[0] !== KIND_REQUEST) return this.#replies.decode(frame);
    const protocol = takeVarint(frame, 1);
    if (protocol === undefined) return undefined;
    const fn = takeVarint(frame, protocol[1]);
    if (fn === undefined) return undefined;
    const at = fn[1];
    if (frame.length < at + 8) return undefined;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    return {
      kind: "request",
      protocol: protocol[0],
      oneWay: false,
      request: {
        call: { id: fn[0] },
        requestId: view.getBigUint64(at, true),
        params: frame.subarray(at + 8),
      },
    };
  }
}

function varint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > MAX_NUMBER) {
    throw new RangeError(`wire number ${value} isn't a u16`);
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
      return value > MAX_NUMBER ? undefined : [value, at + i + 1];
    }
  }
  return undefined;
}
