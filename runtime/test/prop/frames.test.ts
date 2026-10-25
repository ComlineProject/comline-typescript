// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Frames: name hashes, the `comline@1` handshake, envelopes, and requests
 * and responses in every framing, on random inputs. This runtime encodes
 * each input to what `comline-reference` encodes it to, and on the valid
 * frame mutated (or on random bytes) both decode to the same input, or both
 * refuse. This runtime runs each op through `test/ops.ts`, as the vectors
 * do, and answers in the corpus's form.
 *
 * Both runtimes take bytes after a `fault` envelope's tag, and after the
 * handshake's 31 bytes, as part of a valid frame; they agree there, so it
 * isn't a divergence.
 */

import { test } from "node:test";

import fc from "fast-check";

import { jsonEqual, parseJson } from "../../src/json.js";
import { canon, decode, encode, encodeValue, hex, unhex, type Case } from "../ops.js";
import { stringify, type Request } from "../reference.js";
import type { Json, Type } from "../values.js";
import { jsonMutationArb, mutate, mutateJson, mutationArb, stringArb, typedArb } from "./gen.js";
import { known, params, withReference, type Divergence } from "./harness.js";

type Input = { [key: string]: Json };

const u16 = fc.integer({ min: 0, max: 0xffff });
const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map(String);
const hexOf = (a: fc.Arbitrary<Uint8Array | number[]>) => a.map((b) => hex(Uint8Array.from(b)));
const bytesArb = hexOf(fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 24 }));
const utf8 = new TextEncoder();
/** JSON text, for what a JSON-RPC frame carries as a result or error data. */
const jsonText = fc.json({ maxDepth: 2 }).map((t) => hex(utf8.encode(t)));
const name = fc.oneof(
  fc.constantFrom("json@1", "packed@1", "msgpack@1", "datagram@1", "datagram@2", "jsonrpc@1", "", "greet"),
  stringArb,
);
const FRAMINGS = ["datagram@1", "datagram@2", "jsonrpc@1"] as const;

const hasF32 = (t: Type): boolean =>
  t === "f32" ||
  (typeof t === "object" &&
    ("option" in t
      ? hasF32(t.option)
      : "array" in t
        ? hasF32(t.array)
        : "fixed" in t
          ? hasF32(t.fixed.of)
          : "struct" in t && t.struct.fields.some(([, f]) => hasF32(f))));

/**
 * Request params. No `f32`: JSON writes one with a double's digits (the
 * encode property's `json-encode-f32-digits`), and the frames would differ
 * for that alone.
 */
const paramsArb = typedArb.filter(({ type }) => !hasF32(type)).map(({ value }) => value);

const reply = (payload: fc.Arbitrary<string>): fc.Arbitrary<Input> =>
  fc.oneof(
    payload.map((p): Input => ({ kind: "ok", payload: p })),
    fc.record({ id: u16, body: payload }).map((e): Input => ({ kind: "err", ...e })),
    fc.constant<Input>({ kind: "fault" }),
  );

const handshakeArb = fc.record({
  ir_hash: u64,
  wire_format: name,
  framing: name,
  capabilities: fc.integer({ min: 0, max: 0xffff_ffff }),
});

const requestArb = fc.constantFrom(...FRAMINGS).chain((framing) =>
  fc
    .record({
      call_id: u16,
      method: fc.oneof(fc.constantFrom("greet", "chat.ChatClient/pushed"), stringArb),
      request_id: u64,
      params: paramsArb,
      protocol: u16,
      one_way: fc.boolean(),
    })
    .map(({ protocol, one_way, ...r }): Input => ({
      framing,
      format: "json@1",
      ...r,
      ...(framing === "datagram@2" ? { protocol } : {}),
      // A one-way call is a connection's JSON-RPC notification, with no id.
      ...(framing === "jsonrpc@1" && one_way ? { one_way: true, request_id: "0" } : {}),
    })),
);

const responseArb = fc.constantFrom(...FRAMINGS).chain((framing) =>
  fc
    .record({
      request_id: u64,
      protocol: u16,
      reply: reply(framing === "jsonrpc@1" ? jsonText : fc.oneof(jsonText, bytesArb)),
    })
    .map(({ request_id, protocol, reply }): Input => ({
      framing,
      request_id,
      ...(framing === "datagram@2" ? { protocol } : {}),
      ...reply,
    })),
);

/**
 * Valid bytes changed, or random bytes. A JSON-RPC frame is also changed as
 * JSON (a member twice, a number respelled, a method name escaped,
 * whitespace, members reordered); any other frame, or one the change doesn't
 * apply to, is changed as bytes.
 */
const damage = fc.oneof(
  { arbitrary: mutationArb.map((m) => (valid: Uint8Array) => mutate(valid, m)), weight: 3 },
  {
    arbitrary: fc
      .tuple(fc.array(jsonMutationArb, { minLength: 1, maxLength: 2 }), mutationArb)
      .map(([j, m]) => (valid: Uint8Array) => mutateJson(valid, j) ?? mutate(valid, m)),
    weight: 4,
  },
  {
    arbitrary: fc
      .array(fc.integer({ min: 0, max: 255 }), { maxLength: 48 })
      .map((r) => (_: Uint8Array) => Uint8Array.from(r)),
    weight: 1,
  },
);

const strict = new TextDecoder("utf-8", { fatal: true });

function sameJson(a: Uint8Array, b: Uint8Array): boolean {
  try {
    return jsonEqual(parseJson(strict.decode(a)), parseJson(strict.decode(b)));
  } catch {
    return false;
  }
}

/**
 * Whether two frames are the same: byte for byte, except that JSON compares
 * as JSON, the whole frame in JSON-RPC and the params in a datagram request
 * (`0` and `0.0` are one number).
 */
function sameFrame(c: Case, ours: Uint8Array, theirs: Uint8Array): boolean {
  if (hex(ours) === hex(theirs)) return true;
  if (c.compare === "json") return sameJson(ours, theirs);
  const i = c.input ?? {};
  if (c.op !== "request" || i.format !== "json@1") return false;
  const params = encodeValue("json@1", i.params as Json);
  const head = ours.subarray(0, ours.length - params.length);
  return (
    hex(theirs.subarray(0, head.length)) === hex(head) && sameJson(theirs.subarray(head.length), params)
  );
}

/**
 * A JSON-RPC response with its result or error data (`payload`, `body`)
 * stripped of the whitespace between tokens. The reference hands those back
 * as the text it read, spaces and all, and this runtime as compact JSON: the
 * same JSON, so not a divergence.
 */
function withoutSpace(decoded: unknown): unknown {
  if (typeof decoded !== "object" || decoded === null) return decoded;
  const out: { [key: string]: unknown } = { ...(decoded as object) };
  for (const key of ["payload", "body"]) {
    const value = out[key];
    if (typeof value !== "string") continue;
    try {
      out[key] = hex(utf8.encode(compact(strict.decode(unhex(value)))));
    } catch {
      // not UTF-8: left as it is
    }
  }
  return out;
}

/** `source` without the whitespace between its tokens. */
function compact(source: string): string {
  return source.replace(/"(?:[^"\\]|\\.)*"|[ \t\n\r]+/gs, (m) => (m.startsWith('"') ? m : ""));
}

/**
 * A decoded request with its params as the stated value when they are it as
 * JSON. Each side states them only when they're its own exact encoding, and
 * the two write `0.0` differently.
 */
function normalized(c: Case, decoded: unknown): unknown {
  if (c.op === "response" && c.input?.framing === "jsonrpc@1") return withoutSpace(decoded);
  const params = (decoded as { params?: { undecoded?: unknown } } | undefined)?.params;
  const stated = c.input?.params;
  if (c.op !== "request" || typeof params?.undecoded !== "string" || stated === undefined) return decoded;
  return sameJson(unhex(params.undecoded), encodeValue("json@1", stated))
    ? { ...(decoded as object), params: stated }
    : decoded;
}

/** What this runtime decodes `bytes` to, in the case's form, or `undefined`. */
function tsDecode(c: Case, bytes: Uint8Array): unknown {
  try {
    return decode(c, bytes);
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}

withReference("frames: TypeScript frames what the reference frames", (reference) => {
  /**
   * `input` encodes to the reference's bytes, and both sides decode the
   * valid frame, and `damaged` frame, alike.
   */
  async function agree(
    op: Case["op"],
    input: Input,
    damaged: ((valid: Uint8Array) => Uint8Array) | undefined,
  ): Promise<void> {
    const c: Case = {
      id: `prop/${op}`,
      op,
      input,
      bytes: "",
      ...(input.framing === "jsonrpc@1" ? { compare: "json" as const } : {}),
    };
    const ours = encode(c);
    const frames = damaged ? [ours, damaged(ours)] : [];
    const requests: Request[] = [
      { op, input },
      ...frames.map((b): Request => ({ op, input, bytes: hex(b) })),
    ];
    const [encoded, ...decoded] = await reference().ask(requests);
    const failures: string[] = [];
    const diverged = (d: Omit<Divergence, "property" | "input"> & { what: string }) => {
      const { what, ...rest } = d;
      const verdict = known({
        property: `${op} ${what}`,
        input,
        ...(typeof input.framing === "string" ? { framing: input.framing } : {}),
        ...rest,
      });
      if (verdict !== true) failures.push(verdict);
    };

    if (encoded?.kind !== "bytes") throw new Error(`no bytes from the reference: ${stringify(encoded as never)}`);
    if (!sameFrame(c, ours, unhex(encoded.bytes))) {
      diverged({
        what: "encode",
        ts: `wrote ${hex(ours)}`,
        reference: `wrote ${encoded.bytes}`,
        tsBytes: ours,
        referenceBytes: unhex(encoded.bytes),
      });
    }

    frames.forEach((bytes, i) => {
      const answer = decoded[i]!;
      const got = tsDecode(c, bytes);
      if (answer.kind === "reject" && got === undefined) return;
      if (answer.kind === "accept" && got !== undefined && canon(normalized(c, got)) === canon(normalized(c, answer.input))) {
        return;
      }
      diverged({
        what: "decode",
        ts: got === undefined ? "refused" : `accepted, as ${canon(got)}`,
        reference: answer.kind === "accept" ? `accepted, as ${canon(answer.input)}` : "refused",
        bytes,
        tsAccepted: got !== undefined,
        referenceAccepted: answer.kind === "accept",
      });
    });
    if (failures.length > 0) throw new Error(failures.join("\n"));
  }

  test("name hashes equal the reference's", async () => {
    await fc.assert(
      fc.asyncProperty(name, (n) => agree("name_hash", { name: n }, undefined)),
      params(),
    );
  });

  test("handshake frames agree with the reference", async () => {
    await fc.assert(fc.asyncProperty(handshakeArb, damage, (i, d) => agree("handshake", i, d)), params());
  });

  test("envelopes agree with the reference", async () => {
    await fc.assert(fc.asyncProperty(reply(bytesArb), damage, (i, d) => agree("envelope", i, d)), params());
  });

  test("request frames agree with the reference, in every framing", async () => {
    await fc.assert(fc.asyncProperty(requestArb, damage, (i, d) => agree("request", i, d)), params());
  });

  test("response frames agree with the reference, in every framing", async () => {
    await fc.assert(fc.asyncProperty(responseArb, damage, (i, d) => agree("response", i, d)), params());
  });
});
