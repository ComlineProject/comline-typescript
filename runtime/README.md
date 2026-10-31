# @comline/runtime

The **TypeScript runtime** that Comline-generated RPC bindings link against —
the counterpart of the Rust `comline-runtime` crate.

## Status

The contract, three framings, an in-memory transport, a `Client` / `Server`,
and a `Connection` carrying calls in both directions.
Next: a generator that emits a `<Proto>Client` / dispatcher against this
package, and a stream transport.

| Piece | State |
|---|---|
| `RuntimeError`, `Kind` / `resolveKind`, `Call`, `Envelope`, `Outcome`, `Reply`, `CallError`, `Dispatch` | ✅ |
| `Codec` interface + `JsonCodec` (`name === "json@1"`) | ✅ |
| `PackedCodec` (`name === "packed@1"`), driven by a `Layout` per type, byte-compatible with `comline-runtime`'s `format::Packed` | ✅ |
| `Handshake` interface; `comline@1` (`ComlineHandshake`, the 31-byte `HandshakeFrame`, FNV-1a `nameHash`) byte-compatible with `comline-runtime`, and `none` (`NoHandshake`) | ✅ |
| `Framing` + `DatagramFraming` + `JsonRpcFraming` — wire-compatible with `comline-runtime` | ✅ |
| `Transport` interface + `duplex()` in-memory pair | ✅ |
| `Client` (`connect` / `unverified` / `call` / `notify`) and `Server` (`serve` / `serveUnverified`) | ✅ |
| `Connection` (`connect` / `accept` / `unverified`, `provide`, `call` / `notify`, `closed`): calls in both directions, several protocols, a `Peer` handle for handlers (`Dispatch.dispatchWith`), `Extensions`; `ConnectionFraming` + `Datagram2Framing` (`datagram@2`) and `JsonRpcConnectionFraming` (JSON-RPC, a one-way call as a notification), wire-compatible with `comline-runtime` | ✅ |
| A stream `Transport`; a MessagePack `Codec` | — |

## Wire conformance

The wire contract is checked against the byte-exact vectors that
`ComlineProject/runtime` keeps in `runtime/conformance/`, so a TypeScript
peer and a Rust peer generated from the same schema negotiate the same frame
and speak the same request and response bytes.

- [`conformance-support.json`](conformance-support.json) is what this runtime
  claims per wire feature: supported, partial (naming the cases that fail) or
  unsupported.
- `test/conformance.test.ts` proves each claim against the vectors, and writes
  [`conformance-report.json`](conformance-report.json) with the cases proving
  it. The docs' language reference is rendered from the report.
- The vectors are vendored in `test/conformance/` at the commit in
  `VECTORS_REV`. CI checks that the copy is unedited.

```sh
scripts/vendor-conformance.sh <rev>   # take a newer corpus
CONFORMANCE_BLESS=1 npm test          # rewrite conformance-report.json
```

## The core

`core/` holds the Comline core: the wasm32 build of
[`comline-runtime-ffi`](https://github.com/ComlineProject/runtime/tree/main/runtime/ffi)
and its JS glue (`comline.mjs`, `comline.d.mts`), vendored at the commit in
`core/CORE_REV` (built with that commit's own `Cargo.lock`), and `SHA256SUMS`.
`src/core/load.ts` loads it, once per realm, and `src/core/core.ts` binds it
(statuses to `RuntimeError`s; a poisoned instance is dropped, so the next
load makes a fresh one). `ComlineHandshake` runs the `comline@1` exchange on
it, or on the TypeScript where the core can't load. `nameHash` and
`HandshakeFrame` stay TypeScript: they're synchronous, and the core loads
asynchronously.

The build is reproducible (the runtime's pinned toolchain, `--locked`, paths
remapped, a fixed `SOURCE_DATE_EPOCH`), so CI rebuilds it from source and
fails unless every byte matches. `CORE_REV` and `VECTORS_REV` move together:
the script refuses to vendor a core at another commit than the vectors.

```sh
scripts/vendor-conformance.sh <rev>   # first, the vectors at the same commit
scripts/vendor-core.sh <rev>          # then the core
scripts/vendor-core.sh --check        # rebuild CORE_REV, compare the bytes
```

## Differential properties

Beyond the fixed vectors, `test/prop/` checks this runtime against the Rust
one on random inputs, through
[`comline-reference`](https://github.com/ComlineProject/runtime/tree/main/runtime/reference)
(the Rust runtime as a process). `test/reference.ts` runs it once per test
file and asks it batched questions; fast-check draws the inputs and shrinks
any failure.

- **Encode** (`encode.test.ts`): a random value of a random type, written by
  `PackedCodec` and `JsonCodec` with the layout generated code would declare,
  is what the reference writes. JSON compares as JSON.
- **Decode** (`decode.test.ts`): on a value's valid encoding, on it mutated
  (bytes flipped, cut, appended), on random bytes, and on it with one
  targeted fault (overlong varints, tags of 2, counts past the end, unknown
  variants, invalid UTF-8, out-of-range integers, missing fields...), both
  runtimes accept, as the same value, or both refuse.
- **Frames** (`frames.test.ts`): name hashes, handshakes, envelopes, and
  requests and responses in every framing encode alike, and decode their
  mutations alike. A JSON-RPC frame is also changed as JSON: a member made
  twice, an `id` or error `code` respelled (`1.0`, `1e0`, `-0`), the method
  name written with escapes (`\/`, `\uXXXX`, surrogate pairs), whitespace
  between tokens, members reordered. A response's result and error data
  compare as JSON: the reference returns the text it read, spaces and all.
- **Connection sequences** (`sequences.test.ts`): a random list of events
  (local calls, one-way ones too, frames from the peer, abandoned calls,
  replies to the peer's requests) runs through a `Connection` and through
  the reference's `session` op, which drives the Rust runtime's sans-IO
  `connection::State`, and every event's step is the same: the frame a call
  writes and its request id, what a received frame means (the peer's
  request, the reply to a waiting call, a stale reply, a malformed frame),
  and the frame a reply writes. Under `datagram@2` and `jsonrpc@1`, against
  the ordered (nested) and unordered State. The sequences nest calls, answer
  them in and out of order, answer abandoned and one-way calls and ids never
  handed out, and answer the peer's requests in any order.

The types and values follow the reference's own generator: no unions, no
array of data-less elements (core#141), finite floats, bounded depth and
size, names from small pools. Strings and scalar arrays are sometimes long,
so lengths cross varint boundaries.

### Running it

Build the reference at the commit the vectors are vendored from, and point
`COMLINE_REFERENCE` at it (or put `comline-reference` on `PATH`):

```sh
# in a checkout of ComlineProject/runtime, at test/conformance/VECTORS_REV
cargo build --release -p comline-reference

# here
COMLINE_REFERENCE=<runtime>/target/release/comline-reference npm test
FC_NUM_RUNS=20000 COMLINE_REFERENCE=... node --test dist/test/prop/*.test.js
```

- Each property makes 100 runs by default, so `npm test` stays fast;
  `FC_NUM_RUNS` raises that. A nightly workflow runs 20000 and opens an
  issue when it fails.
- A failure prints the seed and path: `FC_SEED` and `FC_PATH` replay it.
- Without the reference, the properties are skipped, saying why. In CI
  (`CI` set) that's a failure instead: the suite mustn't pass by running
  nothing.

### Known divergences

[`known-divergences.json`](known-divergences.json) lists the classes of
known disagreement with the reference, each tied to the issue that will fix
it (some are the reference's to fix). A divergence the properties find is
classified by a predicate in `test/prop/harness.ts`:

- **in a listed class:** reported in a summary after the suite, and not
  failed;
- **in a class not listed, or in none:** the property fails, with the shrunk
  counterexample.

A predicate looks at what makes the case diverge, not only at its format,
so it can't hide an unrelated bug: a JSON value this runtime accepts and the
reference refuses is #57 only when it holds an undeclared variant or an
out-of-range integer, and nothing else wrong. When an issue is fixed, delete
its entry; if the class comes back, it fails again. A listed class with no
predicate fails the suite.

Both runtimes take bytes after a `fault` envelope's tag and after the
handshake's 31 bytes (runtime#33). They agree, so it isn't a divergence.

TypeScript's `Connection` has no sans-IO state; it owns its read loop. The
sequences drive one over an in-memory transport and read its steps off what
it does (the header of `sequences.test.ts` says how), within what the State
decides:

- the connection ends on a malformed frame, as both Rust drivers do, so a
  sequence's malformed frame comes last;
- the peer's requests are served one at a time, in order, as the Rust
  drivers serve them, so a reply's frame is the one sent for that request,
  whenever it is;
- the peer's requests name a protocol and a call this side provides: a
  failed lookup is the driver's fault reply, which the State doesn't know;
- request ids don't wrap: a session starts at 0, as the State does, so
  `u64::MAX` is out of reach.

A sequence is compared up to its first divergence: after one, the two
sides' states differ.

## Layout

```
src/
  contract.ts        RuntimeError, Kind, Call, Envelope, Reply, CallError, Codec, Dispatch, Framing
  handshake.ts       Handshake, ComlineHandshake, NoHandshake, HandshakeFrame, nameHash, the names
  codec.ts           JsonCodec
  packed.ts          PackedCodec, Layout
  json.ts            exact JSON: digits kept, bigint written and read in full (Shape)
  envelope.ts        the datagram tag-byte Envelope form
  framing/
    datagram.ts      DatagramFraming
    jsonrpc.ts        JsonRpcFraming
  transport.ts       Transport, duplex()
  client.ts          Client
  server.ts          Server
  index.ts           public surface
test/                node:test; prop/ holds the differential properties (fast-check)
```

## Develop

```sh
npm ci
npm run typecheck
npm test          # tsc + node --test
```

## License

**Mozilla Public License 2.0** ([LICENSE](LICENSE)). Generated bindings link
this package, not the GPL toolchain — same split as the Rust `comline-runtime`.
See `ComlineProject/docs` → Design → *licensing*.
