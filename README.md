# comline-typescript

The **TypeScript target** for [Comline](https://github.com/ComlineProject) — one
repo per language, holding that language's codegen, libgen, runtime and
std-extra together.

Today: just `codegen/` (`comline-codegen-typescript`), the `code`-mode generator,
extracted from `ComlineProject/generation`. `lib` mode, a runtime, and
std-extra follow.

## `codegen/`

`comline-codegen-typescript` — frozen IR → `.ts` source: `export interface` per
struct, `export enum` (string values) per enum, `export interface` per protocol.
It depends on `comline-codegen` (the language-neutral contract + `Registry`) and
`comline-core` (the IR), both by git rev.

`register(&mut Registry)` contributes the generator under `typescript` / `ts` at
version `5.0`; the Comline CLI composes it into its `Registry` at startup.

```sh
cargo test
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
