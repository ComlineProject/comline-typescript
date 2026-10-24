//! TypeScript code generator. Per schema: `export interface` per struct /
//! `error` (+ a `<Name>Error` throwable, and a same-named `Shape` const when
//! it holds a 64- or 128-bit integer, a `bigint`), a `const` object and union
//! type (string values) per enum, and per `protocol` the full RPC shape against `@comline/runtime` — an
//! `IR_HASH`, params interfaces, a provider interface, a `<Proto>Dispatcher`, a
//! `<Proto>Client`, and a `serve<Proto>` helper.
//!
//! `code` mode emits bare `<namespace>.ts` files; `lib` mode wraps them in an
//! npm package (`package.json` + `tsconfig.json` + `src/index.ts` barrel).
//! See `design/generation.md`.

mod generator;

use comline_codegen::features::{Feature, Support, SupportTable};
use comline_codegen::versions::Versions;
use comline_codegen::Generator;

pub use generator::generate_typescript;

/// The oldest TypeScript this generator generates for, its floor - what a
/// congregation names as `typescript#5.0`. Any later version reaches it too.
pub const LANG_VERSION: &str = "5.0";

/// Which TypeScript versions this generator handles. No output changes above
/// the floor yet. The runtime's tests type-check generated code with
/// TypeScript 5.9; TypeScript doesn't promise later releases accept it.
pub const VERSIONS: Versions = Versions {
    floor: LANG_VERSION,
    changes: &[],
    verified_up_to: "5.9",
    forward_compatible: false,
};

/// What this generator implements, feature by feature. Each claim is proven
/// by `comline-conformance`, not taken on trust: see `comline_codegen::features`.
pub const SUPPORT: SupportTable = &[
    (Feature::Structs, Support::supported()),
    (Feature::Enums, Support::supported()),
    (Feature::OptionalFields, Support::supported()),
    (Feature::Arrays, Support::supported()),
    (Feature::FixedArrays, Support::partial("rendered as `T[]`: the length isn't part of the type")),
    (Feature::LargeFixedArraysNested, Support::partial("rendered as `T[]`: the length isn't part of the type")),
    (Feature::Unions, Support::supported()),
    (Feature::TypeAliases, Support::supported()),
    (Feature::Constants, Support::supported()),
    (Feature::Protocols, Support::supported()),
    (Feature::Errors, Support::supported()),
    (Feature::Throws, Support::supported()),
    (
        Feature::Validators,
        Support::ignored("the types are generated; the checks aren't run yet").tracked("core#96"),
    ),
    (
        Feature::ValidateOnDecode,
        Support::ignored("no checks are generated to run on decode yet").tracked("core#96"),
    ),
    (Feature::Imports, Support::supported()),
    (Feature::NestedNamespaces, Support::supported()),
    (Feature::LibMode, Support::supported()),
    (Feature::ExternalStd, Support::supported()),
    (Feature::FramingJsonRpc, Support::supported()),
    (Feature::HandshakeNone, Support::supported()),
    (
        Feature::Connections,
        Support::partial("over `datagram@2`; JSON-RPC on a connection isn't supported yet")
            .tracked("runtime#19"),
    ),
    // Handlers and senders return Promises whether or not `async` is asked
    // for, so the output is the same either way.
    (Feature::Async, Support::supported()),
];

/// Contribute the TypeScript generator to a CLI's [`Registry`](comline_codegen::Registry),
/// as `typescript` and `ts`.
pub fn register(registry: &mut comline_codegen::Registry) {
    for language in ["typescript", "ts"] {
        registry.register(Generator {
            language,
            ext: "ts",
            generate: generate_typescript,
            support: SUPPORT,
            versions: VERSIONS,
        });
    }
}
