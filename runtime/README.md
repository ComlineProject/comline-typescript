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
| `Codec` interface + `JsonCodec` (`name === "json"`) | ✅ |
| `Handshake` — 31-byte frame, FNV-1a `nameHash`, `check` — byte-compatible with `comline-runtime` | ✅ |
| `Framing` + `DatagramFraming` + `JsonRpcFraming` — wire-compatible with `comline-runtime` | ✅ |
| `Transport` interface + `duplex()` in-memory pair | ✅ |
| `Client` (`connect` / `call` / `notify`) and `Server` (`serve` / `serveHandshaked`) | ✅ |
| A stream `Transport`; a MessagePack `Codec` | — |

The `Handshake` and framing wire formats are cross-checked against
`comline-runtime`'s reference vectors, so a TypeScript peer and a Rust peer
generated from the same schema negotiate the same frame and speak the same
request / response bytes.

## Layout

```
src/
  contract.ts        RuntimeError, Kind, Call, Envelope, Reply, CallError, Codec, Dispatch, Framing
  handshake.ts       Handshake, nameHash, FRAMING_DATAGRAM
  codec.ts           JsonCodec
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
