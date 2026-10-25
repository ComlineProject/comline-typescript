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
  mutations alike.

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

TODO: connection sequences, once the reference has a `session` op
(runtime#39).

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
