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
struct / `error` (plus a `<Name>Error` throwable), `export enum` (string values)
per enum, and per `protocol` the full RPC shape against `@comline/runtime` — an
`IR_HASH`, params interfaces, a provider interface, a `<Proto>Dispatcher`, a
`<Proto>Client`, and a `serve<Proto>` helper (framing from `@framing` / the
package default). It depends on `comline-codegen` (the language-neutral contract
+ `Registry`) and `comline-core` (the IR), both by git rev.

`code` mode writes bare `<namespace>.ts`; `lib` mode wraps them in an npm
package — `package.json` (declaring `@comline/runtime`), `tsconfig.json`, and a
`src/index.ts` barrel.

`register(&mut Registry)` contributes the generator under `typescript` / `ts` at
version `5.0`; the Comline CLI composes it into its `Registry` at startup.

```sh
cargo test
```

## `runtime/`

`@comline/runtime` — the package generated bindings link against. So far the
framing-agnostic contract (`RuntimeError`, `Kind`, `Envelope`, `Reply`,
`CallError`, `Dispatch`), a `Handshake` byte-compatible with the Rust
`comline-runtime`, and a `JsonCodec`. Node, zero runtime dependencies.

```sh
cd runtime && npm ci && npm test
```

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
