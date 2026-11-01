// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The conformance ops protocol over stdin and stdout, so
 * `comline conformance --impl "node dist/test/conformance-server.js"` can
 * drive this runtime the way it drives `comline-reference`. The ops are
 * `ops.ts`'s; the protocol is described in the runtime repository's
 * `runtime/reference/README.md`:
 *
 * - a line is a request `{id, op, input, bytes?}`, or a JSON array of them;
 * - each line gets one reply line of the same shape: `{id, bytes}` (encoded),
 *   `{id, accept, input?}` (decoded or refused), `{id, not_implemented}`,
 *   `{id, error}` or, for `version`, `{id, version}`;
 * - it runs until stdin ends.
 */

import { FORMAT_JSON, FORMAT_PACKED, FRAMING_DATAGRAM, FRAMING_DATAGRAM2, FRAMING_JSONRPC } from "../src/index.js";
import { NotImplemented, decode, encode, hex, unhex, type Case } from "./ops.js";
import type { Json } from "./values.js";

/** The protocol's version: ops and reply fields are only ever added under it. */
export const PROTOCOL = 1;

/** The corpus's ops, as requests name them. */
const CORPUS_OPS = [
  "name_hash",
  "handshake",
  "envelope",
  "request",
  "response",
  "encode",
  "decode",
  "stream_prefix",
  "stream_split",
] as const;

const ENCODE_ONLY = new Set(["name_hash", "encode"]);
const DECODE_ONLY = new Set(["decode"]);

export const FORMATS = [FORMAT_JSON, FORMAT_PACKED];
export const FRAMINGS = [FRAMING_DATAGRAM, FRAMING_DATAGRAM2, FRAMING_JSONRPC];

type Reply = { [key: string]: Json | undefined };

const isObject = (v: unknown): v is { [key: string]: Json } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Answers one request. */
export function handle(request: unknown): Reply {
  if (!isObject(request)) return { id: null, error: "a request is a JSON object" };
  const id = request.id ?? null;
  try {
    return { id, ...respond(request) };
  } catch (e) {
    return { id, error: e instanceof Error ? e.message : String(e) };
  }
}

function respond(request: { [key: string]: Json }): Reply {
  const op = request.op;
  if (op === undefined) throw new Error("no `op`");
  if (typeof op !== "string") throw new Error("`op` is a string");
  if (op === "version") {
    return {
      version: {
        protocol: PROTOCOL,
        ops: [...CORPUS_OPS, "version"],
        formats: FORMATS,
        framings: FRAMINGS,
      },
    };
  }
  if (!(CORPUS_OPS as readonly string[]).includes(op)) throw new Error(`unknown op \`${op}\``);

  const input = request.input ?? null;
  const given = request.bytes ?? null;
  if (given !== null && (typeof given !== "string" || !/^([0-9a-f]{2})*$/.test(given))) {
    throw new Error("`bytes` isn't lowercase hex");
  }
  if (given !== null && ENCODE_ONLY.has(op)) {
    throw new Error(`${op} is encode-only: send it without bytes`);
  }
  if (given === null && DECODE_ONLY.has(op)) {
    throw new Error(`${op} is decode-only: send its bytes`);
  }
  if (input !== null && !isObject(input)) throw new Error("`input` is a JSON object");

  // What the request line leaves out of a corpus case: JSON bytes compare
  // as JSON, and a request whose input names no format is a rejection's,
  // which only asks whether the frame is read.
  const c: Case = {
    id: "",
    op: op as Case["op"],
    input: input ?? {},
    bytes: given ?? "",
    ...(input?.format === FORMAT_JSON || input?.framing === FRAMING_JSONRPC
      ? { compare: "json" as const }
      : {}),
    ...(op === "request" && input?.format === undefined ? { expect: "reject" as const } : {}),
  };
  try {
    if (given === null) return { bytes: hex(encode(c)) };
    const got = decode(c, unhex(given));
    return got === undefined ? { accept: false } : { accept: true, input: got as Json };
  } catch (e) {
    if (e instanceof NotImplemented) return { not_implemented: e.message };
    throw e;
  }
}

/** Answers one line: a request object, or an array of them. */
export function handleLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return JSON.stringify({ id: null, error: `not JSON: ${e instanceof Error ? e.message : String(e)}` });
  }
  return JSON.stringify(Array.isArray(parsed) ? parsed.map(handle) : handle(parsed));
}

/** Serves lines from stdin until it ends: a reply line each, flushed per line. */
function serve(): void {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let pending = Buffer.alloc(0);
  const answer = (raw: Buffer): void => {
    let end = raw.length;
    if (raw[end - 1] === 0x0a) end--;
    if (raw[end - 1] === 0x0d) end--;
    let reply: string;
    try {
      reply = handleLine(utf8.decode(raw.subarray(0, end)));
    } catch (e) {
      reply = JSON.stringify({ id: null, error: `not UTF-8: ${e instanceof Error ? e.message : String(e)}` });
    }
    process.stdout.write(`${reply}\n`);
  };
  process.stdin.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (let nl = pending.indexOf(0x0a); nl >= 0; nl = pending.indexOf(0x0a)) {
      answer(pending.subarray(0, nl + 1));
      pending = pending.subarray(nl + 1);
    }
  });
  process.stdin.on("end", () => {
    if (pending.length > 0) answer(pending);
  });
}

// Only when run as the entry point, not when a test imports `handle`.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) serve();
