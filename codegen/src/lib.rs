//! TypeScript code generator. `code` mode only: `export interface` per struct,
//! `export enum` (string values) per enum, `export interface` per protocol.
//! `lib` mode is not implemented. See `design/generation.md`.

mod generator;

pub use generator::generate_typescript;

/// Contribute the TypeScript generator to a CLI's [`Registry`](comline_codegen::Registry).
pub fn register(registry: &mut comline_codegen::Registry) {
    registry.register("typescript", "ts", "5.0", generate_typescript);
    registry.register("ts", "ts", "5.0", generate_typescript);
}
