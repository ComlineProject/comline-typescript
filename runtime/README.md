# @comline/runtime

The **TypeScript runtime** that Comline-generated RPC bindings link against —
the counterpart of the Rust `comline-runtime` crate.

## Status

The contract, two framings, an in-memory transport, and a `Client` / `Server`.
Next: a generator that emits a `<Proto>Client` / dispatcher against this
package, and a stream transport.

| Piece | State |
|---|---|
| `RuntimeError`, `Kind` / `resolveKind`, `Call`, `Envelope`, `Outcome`, `Reply`, `CallError`, `Dispatch` | ✅ |
| `Codec` interface + `JsonCodec` (`name === "json@1"`) | ✅ |
| `Handshake` interface; `comline@1` (`ComlineHandshake`, the 31-byte `HandshakeFrame`, FNV-1a `nameHash`) byte-compatible with `comline-runtime`, and `none` (`NoHandshake`) | ✅ |
| `Framing` + `DatagramFraming` + `JsonRpcFraming` — wire-compatible with `comline-runtime` | ✅ |
| `Transport` interface + `duplex()` in-memory pair | ✅ |
| `Client` (`connect` / `unverified` / `call` / `notify`) and `Server` (`serve` / `serveUnverified`) | ✅ |
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

## Layout

```
src/
  contract.ts        RuntimeError, Kind, Call, Envelope, Reply, CallError, Codec, Dispatch, Framing
  handshake.ts       Handshake, ComlineHandshake, NoHandshake, HandshakeFrame, nameHash, the names
  codec.ts           JsonCodec
  json.ts            exact JSON: digits kept, bigint written and read in full (Shape)
  envelope.ts        the datagram tag-byte Envelope form
  framing/
    datagram.ts      DatagramFraming
    jsonrpc.ts        JsonRpcFraming
  transport.ts       Transport, duplex()
  client.ts          Client
  server.ts          Server
  index.ts           public surface
test/                node:test, zero runtime deps
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
