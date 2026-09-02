# @comline/runtime

The **TypeScript runtime** that Comline-generated RPC bindings link against —
the counterpart of the Rust `comline-runtime` crate.

## Status

First cut: the framing-agnostic **contract** plus a JSON codec. No `Framing`,
`Transport`, `Client`, or `Server` yet — those, and a generator that emits a
`<Proto>Client` / dispatcher against this package, follow.

| Piece | State |
|---|---|
| `RuntimeError`, `Kind` / `resolveKind`, `Call`, `Envelope`, `Outcome`, `Reply`, `CallError` | ✅ |
| `Codec` interface + `JsonCodec` (`name === "json"`) | ✅ |
| `Handshake` — 31-byte frame, FNV-1a `nameHash`, `check` — byte-compatible with `comline-runtime` | ✅ |
| `Dispatch` interface | ✅ (shape only) |
| `Framing` (datagram + JSON-RPC), `Transport`, `Client`, `Server` | — |

The `Handshake` wire format and `nameHash` are cross-checked against
`comline-runtime`'s reference vectors, so a TypeScript peer and a Rust peer
generated from the same schema negotiate the same frame.

## Layout

```
src/
  contract.ts    RuntimeError, Kind, Call, Envelope, Outcome, Reply, CallError, Codec, Dispatch
  handshake.ts   Handshake, nameHash, FRAMING_DATAGRAM
  codec.ts       JsonCodec
  index.ts       public surface
test/            node:test, zero runtime deps
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
