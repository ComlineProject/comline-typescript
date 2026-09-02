//! TypeScript code generator. Per schema: `export interface` per struct /
//! `error` (+ a `<Name>Error` throwable), `export enum` (string values) per
//! enum, and per `protocol` the full RPC shape against `@comline/runtime` — an
//! `IR_HASH`, params interfaces, a provider interface, a `<Proto>Dispatcher`, a
//! `<Proto>Client`, and a `serve<Proto>` helper.
//!
//! `code` mode emits bare `<namespace>.ts` files; `lib` mode wraps them in an
//! npm package (`package.json` + `tsconfig.json` + `src/index.ts` barrel).
//! See `design/generation.md`.

mod generator;

pub use generator::generate_typescript;

/// Contribute the TypeScript generator to a CLI's [`Registry`](comline_codegen::Registry).
pub fn register(registry: &mut comline_codegen::Registry) {
    registry.register("typescript", "ts", "5.0", generate_typescript);
    registry.register("ts", "ts", "5.0", generate_typescript);
}
