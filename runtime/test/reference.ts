// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `comline-reference`, the Rust runtime as a process (ComlineProject/runtime,
 * `runtime/reference/`): asked what an input encodes to, or whether bytes
 * decode and to what, it answers as `comline-runtime` does. The protocol is
 * newline-delimited JSON, one request or a batch of them per line, one reply
 * line per line; its README describes it.
 *
 * The binary is `COMLINE_REFERENCE` (a path), or else `comline-reference` on
 * `PATH`. Build it at the commit in `test/conformance/VECTORS_REV`, so it
 * answers the way the vendored vectors do.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

import type { Json } from "./values.js";

export type Op =
  | "name_hash"
  | "handshake"
  | "handshake_check"
  | "envelope"
  | "request"
  | "response"
  | "encode"
  | "decode"
  | "stream_prefix"
  | "stream_split"
  | "check"
  | "version"
  | "session";

/** One question: with no `bytes`, an encode; with `bytes` (hex), a decode. */
export interface Request {
  op: Op;
  input?: { [key: string]: Json };
  bytes?: string;
}

/** The reference's answer to one {@link Request}. */
export type Answer =
  | { kind: "bytes"; bytes: string }
  | { kind: "accept"; input: { [key: string]: Json } }
  | { kind: "reject" }
  | { kind: "check"; ok: boolean; why?: string }
  | { kind: "version"; version: { [key: string]: Json } }
  | { kind: "steps"; steps: Json[] };

/**
 * The reference answered with `error` (the question was malformed) or
 * `not_implemented`. Either is a bug in the harness, not a divergence.
 */
export class ReferenceError extends Error {}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where the reference binary is, or `undefined` if it isn't anywhere. */
export function locate(): string | undefined {
  const env = process.env.COMLINE_REFERENCE;
  if (env) return env;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "comline-reference");
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Why the property tests can't run here, or `undefined` when they can. In
 * CI a missing reference is a failure, not a skip: the suite must not pass
 * by running nothing.
 */
export function unavailable(): string | undefined {
  const path = locate();
  if (path && executable(path)) return undefined;
  const why = path
    ? `COMLINE_REFERENCE is ${path}, which isn't an executable`
    : "comline-reference isn't on PATH and COMLINE_REFERENCE isn't set";
  return (
    `${why}. Build it from ComlineProject/runtime at test/conformance/VECTORS_REV ` +
    "(cargo build --release -p comline-reference) and set COMLINE_REFERENCE to the binary"
  );
}

type Raw = { [key: string]: Json };

/**
 * `value` as JSON text, as `JSON.stringify` writes it except that `-0`
 * keeps its sign: a float's sign is part of its value.
 */
export function stringify(value: Json | undefined): string {
  if (typeof value === "number") return Object.is(value, -0) ? "-0.0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${members.map(([k, v]) => `${JSON.stringify(k)}:${stringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function answerOf(raw: Raw, request: Request): Answer {
  if (typeof raw.error === "string") {
    throw new ReferenceError(`the reference refused ${JSON.stringify(request)}: ${raw.error}`);
  }
  if (typeof raw.not_implemented === "string") {
    throw new ReferenceError(
      `the reference doesn't implement ${raw.not_implemented}, asked ${JSON.stringify(request)}`,
    );
  }
  if (typeof raw.bytes === "string") return { kind: "bytes", bytes: raw.bytes };
  if (raw.accept === true) return { kind: "accept", input: raw.input as Raw };
  if (raw.accept === false) return { kind: "reject" };
  if (typeof raw.ok === "boolean") {
    return { kind: "check", ok: raw.ok, ...(typeof raw.why === "string" ? { why: raw.why } : {}) };
  }
  if (raw.version) return { kind: "version", version: raw.version as Raw };
  if (Array.isArray(raw.steps)) return { kind: "steps", steps: raw.steps };
  throw new ReferenceError(`unexpected reply ${JSON.stringify(raw)}`);
}

/**
 * One running reference process. Each {@link ask} sends its requests as one
 * batch line and resolves with the answers in the same order. Lines are
 * answered in order, so a FIFO of pending batches pairs them up.
 */
export class Reference {
  private readonly pending: {
    requests: Request[];
    resolve: (answers: Answer[]) => void;
    reject: (e: Error) => void;
  }[] = [];
  private failed: Error | undefined;
  private readonly exited: Promise<void>;
  private next = 0;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.reply(line));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdin.on("error", (e) => this.fail(e));
    this.exited = new Promise((resolve) => {
      child.on("error", (e) => {
        this.fail(e);
        resolve();
      });
      child.on("exit", (code, signal) => {
        this.fail(
          new Error(
            `comline-reference exited (${signal ?? `code ${code}`})` +
              (stderr ? `; stderr: ${stderr.trim()}` : ""),
          ),
        );
        resolve();
      });
    });
  }

  /** Starts the reference, and checks it speaks protocol 1. */
  static async start(path = locate()): Promise<Reference> {
    if (!path) throw new Error(unavailable());
    const reference = new Reference(spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] }));
    const [version] = await reference.ask([{ op: "version" }]);
    if (version?.kind !== "version" || version.version.protocol !== 1) {
      await reference.close();
      throw new Error(`comline-reference speaks an unknown protocol: ${JSON.stringify(version)}`);
    }
    return reference;
  }

  /** The answers to `requests`, in order, from one batch line. */
  ask(requests: Request[]): Promise<Answer[]> {
    if (this.failed) return Promise.reject(this.failed);
    if (requests.length === 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this.pending.push({ requests, resolve, reject });
      const batch = requests.map((r) => ({ id: this.next++, ...r }));
      this.child.stdin.write(`${stringify(batch as unknown as Json)}\n`);
    });
  }

  /** The answer to one request. */
  async one(request: Request): Promise<Answer> {
    const [answer] = await this.ask([request]);
    return answer!;
  }

  private reply(line: string): void {
    const waiting = this.pending.shift();
    if (!waiting) {
      this.fail(new Error(`comline-reference sent a line nobody asked for: ${line}`));
      return;
    }
    try {
      const raws = JSON.parse(line) as Raw[] | Raw;
      if (!Array.isArray(raws) || raws.length !== waiting.requests.length) {
        throw new ReferenceError(`expected a batch of ${waiting.requests.length} replies, got ${line}`);
      }
      waiting.resolve(raws.map((raw, i) => answerOf(raw, waiting.requests[i]!)));
    } catch (e) {
      waiting.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private fail(e: Error): void {
    this.failed ??= e;
    for (const waiting of this.pending.splice(0)) waiting.reject(this.failed);
  }

  /** Ends stdin and waits for the process to exit, killing it if it hangs. */
  async close(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end();
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 5000);
      await this.exited;
      clearTimeout(timer);
    }
  }
}
