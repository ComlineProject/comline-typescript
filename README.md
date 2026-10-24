# comline-typescript

The **TypeScript target** for [Comline](https://github.com/ComlineProject) — one
repo per language, holding that language's codegen, libgen, runtime and
std-extra together.

Today: `codegen/` (`comline-codegen-typescript` — `code` and `lib` modes,
extracted from `ComlineProject/generation`) and `runtime/` (`@comline/runtime`
— contract, framing, transport, `Client` / `Server`). std-extra follows; the
runtime is not published to npm yet.

## `codegen/`

`comline-codegen-typescript` — frozen IR → `.ts` source: `export interface` per
struct / `error` (plus a `<Name>Error` throwable), a `const` object of string
values and a same-named union type per enum, and per `protocol` the full RPC shape against `@comline/runtime` — an
`IR_HASH`, params interfaces, a provider interface, a `<Proto>Dispatcher`, a
`<Proto>Client`, and a `serve<Proto>` helper (framing from `@framing` / the
package default). It depends on `comline-codegen` (the language-neutral contract
+ `Registry`) and `comline-core` (the IR), both by git rev.

`code` mode writes bare `<namespace>.ts`; `lib` mode wraps them in an npm
package — `package.json` (declaring `@comline/runtime`, and `typescript` as an
optional peer dependency at the declared version and up), `tsconfig.json`, and
a `src/index.ts` barrel.

The output targets ES2020 (it uses `bigint`) and ESM, and is erasable syntax
only: no `enum`, no constructor parameter properties, so it runs under
`erasableSyntaxOnly` and Node's type stripping. CI type-checks it under the
strictest flags (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`), on the TypeScript in the lockfiles and on 5.0. Every
file's header names the range: "For TypeScript 5.0 or later; verified up to
5.9."

`register(&mut Registry)` contributes the generator under `typescript` / `ts`
from version `5.0` (its floor) on; the Comline CLI composes it into its
`Registry` at startup.

```sh
cargo test
```

## `runtime/`

`@comline/runtime` — the package generated bindings link against. So far the
framing-agnostic contract (`RuntimeError`, `Kind`, `Envelope`, `Reply`,
`CallError`, `Dispatch`), a `Handshake` byte-compatible with the Rust
`comline-runtime`, a `JsonCodec` and a `PackedCodec` (`packed@1`). Node,
zero runtime dependencies.

```sh
cd runtime && npm ci && npm test
```

## Features

What this generator implements, feature by feature. Each claim is checked by
the conformance suite in [`ComlineProject/generation`](https://github.com/ComlineProject/generation):
a supported feature has a fixture that generates and matches its golden output,
an ignored one generates exactly what it would without the feature, and an
unsupported one is refused with an error naming every use. The full matrix,
with the fixtures that prove each claim, is in
[`FEATURES.md`](https://github.com/ComlineProject/generation/blob/master/FEATURES.md).

<!-- features:start -->
<!-- Generated from `SUPPORT` in `codegen/src/lib.rs` - don't edit by hand. -->

| Feature | typescript ≥ 5.0 |
|---|---|
| structs <br><sub>`structs`</sub> | ✅ supported |
| enums <br><sub>`enums`</sub> | ✅ supported |
| optional fields <br><sub>`optional-fields`</sub> | ✅ supported |
| arrays <br><sub>`arrays`</sub> | ✅ supported |
| fixed-length arrays <br><sub>`fixed-arrays`</sub> | 🟡 partial: rendered as `T[]`: the length isn't part of the type |
| fixed arrays over 32 elements, nested <br><sub>`large-fixed-arrays-nested`</sub> | 🟡 partial: rendered as `T[]`: the length isn't part of the type |
| unions <br><sub>`unions`</sub> | ✅ supported |
| type aliases <br><sub>`type-aliases`</sub> | ✅ supported |
| constants <br><sub>`constants`</sub> | ✅ supported |
| protocols <br><sub>`protocols`</sub> | ✅ supported |
| errors <br><sub>`errors`</sub> | ✅ supported |
| functions that throw <br><sub>`throws`</sub> | ✅ supported |
| validators <br><sub>`validators`</sub> | ⚪ ignored: the types are generated; the checks aren't run yet (core#96) |
| imports between schemas <br><sub>`imports`</sub> | ✅ supported |
| nested namespaces <br><sub>`nested-namespaces`</sub> | ✅ supported |
| `lib` mode <br><sub>`lib-mode`</sub> | ✅ supported |
| `external_std` <br><sub>`external-std`</sub> | ✅ supported |
| `validate_on_decode` <br><sub>`validate-on-decode`</sub> | ⚪ ignored: no checks are generated to run on decode yet (core#96) |
| JSON-RPC framing <br><sub>`framing-jsonrpc`</sub> | ✅ supported |
| no handshake <br><sub>`handshake-none`</sub> | ✅ supported |
| connections <br><sub>`connections`</sub> | ✅ supported |
| `async` <br><sub>`async`</sub> | ⚪ ignored: handlers and senders always return Promises: the output is async either way |
| the `packed@1` format <br><sub>`format-packed`</sub> | ✅ supported |
| the `json@1` format <br><sub>`format-json`</sub> | ✅ supported |
| the `msgpack@1` format <br><sub>`format-msgpack`</sub> | ❌ unsupported: `@comline/runtime` has no MessagePack codec yet |

<!-- features:end -->

## Design

See `ComlineProject/docs` → Design:

- *Runtime & generation repository structure* — why one repo per language
- *Generation* — what codegen / libgen / runtime each mean
- *The `core` ↔ target contract* — the boundary this repo builds against


## License

**GNU General Public License v3.0 only** ([LICENSE](LICENSE) or
<https://www.gnu.org/licenses/gpl-3.0.html>). This generator links
`comline-core` and is part of Comline's GPL toolchain. Copyleft covers the
generator, **not** the code it emits — generated bindings are yours and link
only `comline-runtime` (MPL-2.0). Contributions are GPL-3.0-only. Rationale +
per-repo split: [`design/licensing.md`](https://github.com/ComlineProject/docs).
