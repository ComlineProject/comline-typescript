// What the generated code puts on the wire - the schema digests, the package's
// connection digest, this end's `comline@2` Hello, the protocols' wire numbers
// and the calls' numbers and names - recorded in `wire-invariance.json` from
// the generator's output, and compared against the blessed fixtures in
// `generated/`. Changing how generated code is *laid out* (where a constant is
// defined, what is marked `@internal`, which comments it carries) must not
// move any of it: a changed value means a changed wire.
//
// Read from the fixtures' source text rather than by importing them, which a
// fixture naming a third-party package (`acme-encodings`) can't be.
//
// A change that moves the wire on purpose re-records it:
// `WIRE_INVARIANCE_BLESS=1 npm test`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { buildHello } from "../src/index.js";

const RUNTIME = new URL("../../", import.meta.url);
const GENERATED = new URL("test/generated/", RUNTIME);
const RECORD = new URL("test/wire-invariance.json", RUNTIME);

/** What one generated file says about the wire; absent where it says nothing. */
interface FileFacts {
  /** `IR_HASH`: the digest of the schema the file was generated from. */
  irHash?: string;
  /** Each `PROTOCOL = N` in the file, in order: a protocol's number on a connection. */
  protocolNumbers?: number[];
  /** Each `<PROTO>_CALLS` table: the names a call is matched by. */
  callTables?: Record<string, string[]>;
  /** Each `{ id: N, name: "x" }` a sender writes. */
  callsWritten?: string[];
  /** Each `case N:` a dispatcher takes. */
  callsTaken?: number[];
}

/** What a fixture - a directory, or a file at the top - says about the wire as a whole. */
interface ShapeFacts {
  files: Record<string, FileFacts>;
  /** Every distinct `CONNECTION_IR_HASH` the shape defines: one, the package's. */
  connectionIrHash: string[];
  /** Every distinct Hello of the package's whole connection, as hex: its header with every protocol's entry. */
  hello: string[];
  /** Every distinct codec `Format` is built from. */
  format: string[];
}

function sources(dir: URL, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = new URL(entry, dir);
    if (statSync(path).isDirectory()) {
      out.push(...sources(new URL(`${entry}/`, dir), `${prefix}${entry}/`));
    } else if (entry.endsWith(".ts")) {
      out.push(`${prefix}${entry}`);
    }
  }
  return out;
}

const distinct = (values: string[]): string[] => [...new Set(values)].sort();
const all = (text: string, pattern: RegExp): RegExpMatchArray[] => [...text.matchAll(pattern)];

function factsOf(text: string): { file: FileFacts; connectionIrHash: string[]; hello: string[]; format: string[] } {
  const file: FileFacts = {};
  const ir = all(text, /^export const IR_HASH = (0x[0-9a-f]+)n;$/gm);
  if (ir[0]) file.irHash = ir[0][1];
  const numbers = all(text, /static readonly PROTOCOL = (\d+);/g).map((m) => Number(m[1]));
  if (numbers.length) file.protocolNumbers = numbers;
  const tables = all(text, /^export const ([A-Z0-9_]+_CALLS) = \[(.*)\] as const;$/gm);
  if (tables.length) {
    file.callTables = Object.fromEntries(
      tables.map((m) => [m[1]!, [...m[2]!.matchAll(/"([^"]*)"/g)].map((n) => n[1]!)]),
    );
  }
  const written = all(text, /\{ id: (\d+), name: "([^"]*)" \}/g).map((m) => `${m[1]} ${m[2]}`);
  if (written.length) file.callsWritten = written;
  const taken = all(text, /^\s+case (\d+): \{$/gm).map((m) => Number(m[1]));
  if (taken.length) file.callsTaken = taken;

  // The Hello is emitted as parts, a header and an entry per protocol, which an
  // end puts together from what it provides and calls; with every protocol it
  // is the whole connection's Hello, the one the package used to embed.
  const bytesOf = (list: string): Uint8Array =>
    Uint8Array.from([...list.matchAll(/0x([0-9a-f]{2})/g)].map((b) => parseInt(b[1]!, 16)));
  const headers = all(text, /export const HELLO_HEADER = new Uint8Array\(\[([^\]]*)\]\);/g).map((m) => bytesOf(m[1]!));
  const entries = all(text, /number: (\d+),\s+bytes: new Uint8Array\(\[([^\]]*)\]\),/g).map((m) => ({
    number: Number(m[1]),
    bytes: bytesOf(m[2]!),
  }));
  const hello = headers.map((header) =>
    [...buildHello(header, entries, [])].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
  return {
    file,
    connectionIrHash: all(text, /^export const CONNECTION_IR_HASH = (0x[0-9a-f]+)n;$/gm).map((m) => m[1]!),
    hello,
    format: all(text, /^export const Format: Codec = new (\w+)\(\);$/gm).map((m) => m[1]!),
  };
}

function record(): Record<string, ShapeFacts> {
  const paths = sources(GENERATED);
  // A package is the directory its `connection.ts` is in; without one, a
  // fixture is the top-level directory, or the file at the top.
  const packages = paths.filter((p) => p.endsWith("/connection.ts")).map((p) => p.slice(0, -"connection.ts".length));
  const shapes = new Map<string, string[]>();
  for (const path of paths) {
    const root = packages.filter((dir) => path.startsWith(dir)).sort((a, b) => b.length - a.length)[0];
    const slash = path.indexOf("/");
    const shape = root ?? (slash < 0 ? path : path.slice(0, slash));
    shapes.set(shape, [...(shapes.get(shape) ?? []), path]);
  }
  const out: Record<string, ShapeFacts> = {};
  for (const [shape, paths] of shapes) {
    const facts: ShapeFacts = { files: {}, connectionIrHash: [], hello: [], format: [] };
    const hashes: string[] = [];
    const hellos: string[] = [];
    const formats: string[] = [];
    for (const path of paths) {
      const found = factsOf(readFileSync(new URL(path, GENERATED), "utf8"));
      if (Object.keys(found.file).length) facts.files[path] = found.file;
      hashes.push(...found.connectionIrHash);
      hellos.push(...found.hello);
      formats.push(...found.format);
    }
    facts.connectionIrHash = distinct(hashes);
    facts.hello = distinct(hellos);
    facts.format = distinct(formats);
    out[shape] = facts;
  }
  return out;
}

test("the generated fixtures' wire constants are the recorded ones", () => {
  const current = record();
  if (process.env.WIRE_INVARIANCE_BLESS) {
    writeFileSync(RECORD, `${JSON.stringify(current, null, 2)}\n`);
    return;
  }
  const recorded = JSON.parse(readFileSync(RECORD, "utf8")) as Record<string, ShapeFacts>;
  assert.deepEqual(Object.keys(current), Object.keys(recorded), "a fixture was added or removed: re-record");
  for (const shape of Object.keys(recorded)) {
    assert.deepEqual(current[shape], recorded[shape], `${shape}: the wire facts moved`);
  }
});

test("each fixture has one connection digest, one Hello and one format", () => {
  for (const [shape, facts] of Object.entries(record())) {
    assert.ok(facts.connectionIrHash.length <= 1, `${shape}: ${facts.connectionIrHash.join(", ")}`);
    assert.ok(facts.hello.length <= 1, `${shape}: more than one HELLO`);
    assert.ok(facts.format.length <= 1, `${shape}: ${facts.format.join(", ")}`);
  }
});
