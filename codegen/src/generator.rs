//! TypeScript generation: frozen IR -> `.ts` source.
//!
//! Per schema file:
//! - `struct`   -> `export interface`, and beside it, when the struct holds a
//!   64- or 128-bit integer (a `bigint`), an `export const` of the same name:
//!   its `Shape`, which tells `@comline/runtime`'s decoder where the
//!   `bigint`s are
//! - `error`    -> `export interface` (the wire payload) + `export class
//!   <Name>Error` (the throwable, carrying `.data` and a static `.ordinal`)
//! - `enum`     -> an `export const` object of string values (JSON interop)
//!   and a same-named union type of them: `Color.Red` reads as it would on an
//!   `enum`, and the output stays erasable syntax (see below)
//! - `protocol` -> the full RPC shape against `@comline/runtime`: an `IR_HASH`
//!   const, a `<Proto><Fn>Params` interface per function, a `<Proto>` provider
//!   interface of `Promise`-returning methods, a `<PROTO>_CALLS` table, a
//!   `<Proto>Dispatcher` (`implements Dispatch`), a `<Proto>Client`, and a
//!   `serve<Proto>` helper. Framing follows `@framing` / the package default.
//!
//! A type another schema declares is imported from that schema by relative
//! specifier (`import type { Greeting } from "./types.js"`), so the output
//! compiles in both modes.
//!
//! The output is erasable syntax only, with no `enum` and no constructor
//! parameter properties, so it runs under TypeScript 5.8's
//! `erasableSyntaxOnly` and Node's type stripping; it targets ES2020 (for
//! `bigint`) and type-checks under the strictest flags. One output then fits
//! every consumer's `tsconfig`, from the floor ([`crate::LANG_VERSION`]) up. Which name comes from where is
//! [`comline_codegen::symbols`]'s answer, not this crate's. With `external_std`,
//! `std`'s own schemas are not emitted at all and their types come from
//! [`STD_PACKAGE`] instead.
//!
//! `code` mode emits bare `<namespace>.ts`; `lib` mode adds a `package.json`
//! (declaring `@comline/runtime` and `@comline/std` as needed), a
//! `tsconfig.json`, and an `index.ts` barrel per namespace level
//! ([`NamespaceTree`], laid out by [`TsLayout`]). See design/generation.md.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use comline_core::schema::ir::frozen::types::{Literal, PrimitiveType, TypeRef};
use comline_core::schema::ir::frozen::schema_ir_hash;
use comline_core::schema::idl::annotations::{MethodNames, FRAMING_JSONRPC, HANDSHAKE_NONE};
use comline_core::schema::ir::frozen::unit::FrozenUnit;
use comline_core::schema::ir::unverified;

use eyre::Result;

use comline_codegen::connections;
use comline_codegen::collisions::{self, Derived};
use comline_codegen::modules::{NamespaceTree, TreeLayout};
use comline_codegen::naming::{camel, pascal, screaming_snake};
use comline_codegen::stdlib::{self, is_std_namespace};
use comline_codegen::symbols::{error_names, SymbolTable, UseTracker};
use comline_codegen::{GenRequest, GeneratedFile, Mode, PackageMeta};

/// The npm package generated RPC code imports from. Not published yet — a
/// generated `lib` package declares this range and expects it resolvable
/// (`npm link`, a local registry, or a future publish). See
/// `ComlineProject/comline-typescript/runtime`.
const RUNTIME_PACKAGE: &str = "@comline/runtime";
const RUNTIME_VERSION: &str = "^0.1.0";

/// `std`'s own pre-generated bindings, referenced instead of inlined when
/// `external_std` is on — the npm counterpart of `comline_std`.
///
/// A semver range rather than the git pin `comline_std` uses: npm can't
/// install from a repository subdirectory, and `@comline/std` lives in
/// `comline-typescript/std-extra/`. So, like [`RUNTIME_PACKAGE`], this
/// resolves once published and through `npm link` until then.
const STD_PACKAGE: &str = "@comline/std";
const STD_VERSION: &str = "^0.1.0";

pub fn generate_typescript(req: &GenRequest) -> Result<Vec<GeneratedFile>> {
    // What this generator can't render at all is refused up front, every use
    // named, before a single file is produced.
    comline_codegen::features::refuse_unsupported("typescript", req, crate::SUPPORT)?;

    // The package's codec. MessagePack has none yet, which the support table
    // has already refused, so only a name nobody knows gets here.
    let codec = codec_class(&req.wire_format).ok_or_else(|| {
        eyre::eyre!(
            "unknown wire format `{}` - expected `packed@1`, `json@1` or `msgpack@1`",
            req.wire_format
        )
    })?;
    // JSON-RPC protocols sharing a connection whose bare method names one
    // side couldn't tell apart.
    connections::check(req.schemas)?;
    let external_std = req.external_std;

    // With `external_std`, std's schemas aren't this package's to emit - it
    // references `@comline/std` for them instead.
    //
    // Only *emission* is narrowed; `req.schemas` stays the list every
    // reference is resolved against. `stdlib::split` carries that
    // distinction, and the "declare the dependency only if std was actually
    // there" subtlety with it.
    let std = stdlib::split(req.schemas, external_std);
    let emitted = std.emitted.as_ref();

    // Every schema file names the range its output is for: the declared
    // version up, as far as it has been verified.
    let header = format!(
        "// Generated by Comline\n// For TypeScript {} or later; verified up to {}.\n",
        req.lang_version,
        crate::VERSIONS.verified_up_to
    );

    // Before emitting anything: a name this generator is about to invent may
    // already mean something in the schema. The `{name}Error` suffix is the
    // easy one to hit - `error Foo` becomes `class FooError`, which collides
    // with a declared `struct FooError`. Checked for every schema first, so a
    // collision in the last one does not arrive after the earlier files are
    // already written.
    for (namespace, units) in emitted {
        collisions::check(namespace, units, derived_names(units, req.schemas))?;
    }
    // Loose files or a `src/` tree, the package module has a file of its own,
    // which a schema of that name would be.
    let package = package_module(&header, req, emitted, codec);
    if package.is_some() && emitted.iter().any(|(namespace, _)| namespace == PACKAGE_MODULE) {
        return Err(eyre::eyre!(
            "a schema named `{PACKAGE_MODULE}` would be overwritten by the package's \
             `{PACKAGE_MODULE}.ts` (its `Services` and `serve`) - rename the schema"
        ));
    }

    match req.mode {
        Mode::Code => Ok(emitted
            .iter()
            .map(|(namespace, units)| {
                let source = schema_source(&header, namespace, units, req.schemas, codec, external_std);
                // `code` mode has no manifest to add the dependency to, so
                // the file says what it needs - the same courtesy the Rust
                // generator extends for `Cargo.toml`.
                let contents = if source.contains(&format!("\"{STD_PACKAGE}/")) {
                    format!(
                        "// This file imports `{STD_PACKAGE}` - add it to your package.json:\n\
                         //   npm install {STD_PACKAGE}@{STD_VERSION}\n{source}"
                    )
                } else {
                    source
                };
                GeneratedFile {
                    path: PathBuf::from(format!("{namespace}.ts")),
                    contents,
                }
            })
            .chain(package.map(|contents| GeneratedFile {
                path: PathBuf::from(format!("{PACKAGE_MODULE}.ts")),
                contents,
            }))
            .collect()),

        Mode::Lib => {
            let tree = NamespaceTree::build(emitted, &TsLayout)?;

            // The render closure takes every schema in the request, not just
            // the ones in this tree: a reference resolves against all of
            // them, including an external `std` this package emits no file
            // for.
            let mut sources = tree.emit("src", &TsLayout, &|namespace, units| {
                schema_source(&header, namespace, units, req.schemas, codec, external_std)
            });
            // The package module beside the schemas, its names at the root.
            if let Some(contents) = package {
                let root = sources
                    .iter_mut()
                    .find(|f| f.path == std::path::Path::new("src/index.ts"))
                    .ok_or_else(|| eyre::eyre!("no root barrel to export the package's `serve` from"))?;
                root.contents.push_str(&format!("export * from \"./{PACKAGE_MODULE}.js\";\n"));
                sources.push(GeneratedFile { path: PathBuf::from(format!("src/{PACKAGE_MODULE}.ts")), contents });
            }
            // A protocol needs the runtime. A type's `Layout` only names it
            // in an erased `import type`, so types alone make it an optional
            // peer: whoever encodes them has the runtime already.
            let layouts_only = format!("import type {{ Layout }} from \"{RUNTIME_PACKAGE}\";");
            let imports_runtime = |f: &GeneratedFile| {
                f.contents
                    .replace(&layouts_only, "")
                    .contains(&format!("from \"{RUNTIME_PACKAGE}\""))
            };
            let runtime = if sources.iter().any(imports_runtime) {
                RuntimeDep::Required
            } else if sources.iter().any(|f| f.contents.contains(&layouts_only)) {
                RuntimeDep::Peer
            } else {
                RuntimeDep::None
            };

            let mut files = vec![
                GeneratedFile {
                    path: PathBuf::from("package.json"),
                    contents: package_json(&req.package, &req.lang_version, runtime, std.needs_std_dependency),
                },
                GeneratedFile {
                    path: PathBuf::from("tsconfig.json"),
                    contents: TSCONFIG.to_string(),
                },
            ];
            files.extend(sources);
            Ok(files)
        }
    }
}

/// What TypeScript decides differently about the `src/` tree
/// ([`comline_codegen::modules`] holds the rest).
///
/// Four things, and no more: the extension, a barrel *inside* each directory
/// rather than a file beside it (`src/std/index.ts`, not `src/std.ts`), the
/// `export * as` line, and the specifier that line needs — which is the one
/// place the child's own kind shows through, since a leaf is `./x.js` and a
/// grouping is `./x/index.js`.
///
/// Mirroring namespaces rather than flattening every name into the package
/// root is what makes a collision between, say, your own `Request` and
/// `std/http`'s impossible: TypeScript refuses ambiguous `export *`
/// re-exports (TS2308), and `std` is implicit in every package. Nothing is
/// reserved at the root — TypeScript has no equivalent of Rust's crate root.
struct TsLayout;

impl TreeLayout for TsLayout {
    fn ext(&self) -> &str {
        "ts"
    }

    /// Inside the directory, at every level: `src/index.ts`,
    /// `src/std/index.ts`. The root is not a special case.
    fn group_file(&self, prefix: &str, _is_root: bool) -> String {
        format!("{prefix}/index.ts")
    }

    fn declare_child(&self, segment: &str, child_is_leaf: bool) -> String {
        let module = if child_is_leaf {
            format!("./{segment}.js")
        } else {
            format!("./{segment}/index.js")
        };
        format!("export * as {segment} from \"{module}\";\n")
    }

    /// A node that is both a schema and a grouping would give
    /// `export * as <name>` two candidate modules and no way to choose.
    fn ambiguity_reason(&self, path: &str) -> String {
        format!(
            "the barrel's `export * as {}` has no single module to name",
            path.rsplit('/').next().unwrap_or(path)
        )
    }
}

const TSCONFIG: &str = "{\n\
    \x20 \"compilerOptions\": {\n\
    \x20   \"target\": \"ES2020\",\n\
    \x20   \"module\": \"NodeNext\",\n\
    \x20   \"moduleResolution\": \"NodeNext\",\n\
    \x20   \"outDir\": \"dist\",\n\
    \x20   \"rootDir\": \"src\",\n\
    \x20   \"declaration\": true,\n\
    \x20   \"strict\": true,\n\
    \x20   \"exactOptionalPropertyTypes\": true,\n\
    \x20   \"noUncheckedIndexedAccess\": true,\n\
    \x20   \"verbatimModuleSyntax\": true,\n\
    \x20   \"skipLibCheck\": true\n\
    \x20 },\n\
    \x20 \"include\": [\"src/**/*.ts\"]\n\
    }\n";

/// How a package depends on `@comline/runtime`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RuntimeDep {
    /// Nothing names it.
    None,
    /// Only erased type imports name it: an optional peer dependency.
    Peer,
    /// Code imports it: a dependency.
    Required,
}

/// The package's manifest. `typescript` is an optional peer dependency at the
/// declared version and up: npm then warns a consumer whose compiler is older,
/// and never refuses a newer one, which a ceiling would.
fn package_json(pkg: &PackageMeta, lang_version: &str, runtime: RuntimeDep, needs_std_dep: bool) -> String {
    let name = pkg.name.to_lowercase();
    let mut entries: Vec<String> = Vec::new();
    if runtime == RuntimeDep::Required {
        entries.push(format!("    \"{RUNTIME_PACKAGE}\": \"{RUNTIME_VERSION}\""));
    }
    if needs_std_dep {
        entries.push(format!("    \"{STD_PACKAGE}\": \"{STD_VERSION}\""));
    }
    let dep = if entries.is_empty() {
        String::new()
    } else {
        format!("\n  \"dependencies\": {{\n{}\n  }},", entries.join(",\n"))
    };
    let (runtime_peer, runtime_peer_meta) = if runtime == RuntimeDep::Peer {
        (
            format!("    \"{RUNTIME_PACKAGE}\": \"{RUNTIME_VERSION}\",\n"),
            format!("    \"{RUNTIME_PACKAGE}\": {{ \"optional\": true }},\n"),
        )
    } else {
        (String::new(), String::new())
    };
    format!(
        "{{\n\
        \x20 \"name\": \"{name}\",\n\
        \x20 \"version\": \"{}\",\n\
        \x20 \"type\": \"module\",\n\
        \x20 \"exports\": {{\n\
        \x20   \".\": {{\n\
        \x20     \"types\": \"./dist/index.d.ts\",\n\
        \x20     \"import\": \"./dist/index.js\"\n\
        \x20   }},\n\
        \x20   \"./*\": {{\n\
        \x20     \"types\": \"./dist/*.d.ts\",\n\
        \x20     \"import\": \"./dist/*.js\"\n\
        \x20   }}\n\
        \x20 }},\n\
        \x20 \"files\": [\"dist\", \"src\"],\n\
        \x20 \"scripts\": {{\n\
        \x20   \"build\": \"tsc\"\n\
        \x20 }},{dep}\n\
        \x20 \"peerDependencies\": {{\n{runtime_peer}\
        \x20   \"typescript\": \">={lang_version}\"\n\
        \x20 }},\n\
        \x20 \"peerDependenciesMeta\": {{\n{runtime_peer_meta}\
        \x20   \"typescript\": {{ \"optional\": true }}\n\
        \x20 }},\n\
        \x20 \"devDependencies\": {{\n\
        \x20   \"typescript\": \"^5.6.0\"\n\
        \x20 }}\n\
        }}\n",
        pkg.version
    )
}

/// One schema's `.ts` file: the cross-schema import header, then everything
/// the schema itself declares.
///
/// `namespace` is this schema's own (`"std/http"`), needed to place the
/// relative specifiers in the header; `schemas` is every schema in the
/// request, which is what a reference resolves against.
/// Every name this generator will invent for `units`, each described the way a
/// person reading a build failure needs it.
///
/// This is the half of collision checking that cannot live in
/// `comline-codegen`: what gets derived is a fact about *TypeScript* output.
/// The shapes differ from Rust's - there is no per-function error type and no
/// protocol-wide union here, but every `error` grows an `Error` suffix, which
/// Rust has no equivalent of. Keep it in step with the emitters below.
fn derived_names(units: &[FrozenUnit], schemas: &[(String, Vec<FrozenUnit>)]) -> Vec<Derived> {
    let mut derived = Vec::new();
    let mut any_protocol = false;
    let mut any_connection = false;
    let mut any_formatted = false;

    for unit in units {
        match unit {
            // `error Rude` -> `export class RudeError extends Error`, which a
            // declared `RudeError` of any kind would collide with.
            FrozenUnit::Error { name, .. } => {
                derived.push(Derived::new(format!("{name}Error"), format!("the thrown class for error `{name}`")));
                derived.push(Derived::new(format!("{name}Layout"), format!("error `{name}`'s layout")));
            }
            FrozenUnit::Struct { name, .. } | FrozenUnit::Enum { name, .. } | FrozenUnit::TypeAlias { name, .. } => {
                derived.push(Derived::new(format!("{name}Layout"), format!("`{name}`'s layout")));
            }
            FrozenUnit::Protocol {
                name: proto,
                functions,
                parameters,
                ..
            } => {
                any_protocol = true;
                any_formatted |= connections::framing(parameters).name != FRAMING_JSONRPC;
                derived.push(Derived::new(
                    format!("{proto}Dispatcher"),
                    format!("protocol `{proto}`'s dispatcher"),
                ));
                if connections::on_connection(schemas, parameters) {
                    any_connection = true;
                    derived.push(Derived::new(
                        format!("{proto}Sender"),
                        format!("protocol `{proto}`'s sender"),
                    ));
                } else {
                    derived.push(Derived::new(
                        format!("{proto}Client"),
                        format!("protocol `{proto}`'s client"),
                    ));
                    derived.push(Derived::new(
                        format!("serve{proto}"),
                        format!("protocol `{proto}`'s serve helper"),
                    ));
                }
                derived.push(Derived::new(
                    format!("{}_CALLS", screaming_snake(proto)),
                    format!("protocol `{proto}`'s call table"),
                ));
                for function in functions {
                    let FrozenUnit::Function {
                        name, arguments, ..
                    } = function
                    else {
                        continue;
                    };
                    if !arguments.is_empty() {
                        derived.push(Derived::new(
                            format!("{proto}{}Params", pascal(name)),
                            format!("protocol `{proto}`, function `{name}`'s params type"),
                        ));
                        derived.push(Derived::new(
                            format!("{proto}{}ParamsLayout", pascal(name)),
                            format!("protocol `{proto}`, function `{name}`'s params layout"),
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    if any_protocol {
        derived.push(Derived::new("IR_HASH", "the schema's IR hash constant"));
    }
    if any_connection {
        derived.push(Derived::new("CONNECTION_IR_HASH", "the package's connection hash constant"));
    }
    if any_formatted {
        derived.push(Derived::new("Format", "the package's codec"));
    }
    derived
}

fn schema_source(
    header: &str,
    namespace: &str,
    units: &[FrozenUnit],
    schemas: &[(String, Vec<FrozenUnit>)],
    codec: &str,
    external_std: bool,
) -> String {
    let types = TypeMapper::new(units, schemas, external_std);
    let errors = error_names(units);

    // The declarations, built before the headers: rendering them is what
    // tells `types` which imported names this file actually refers to, and
    // whether it declares a `Layout`.
    let mut decls = String::new();
    for unit in units {
        match unit {
            FrozenUnit::Struct { name, fields, .. } => {
                decls.push_str(&interface(name, fields, &types));
                decls.push_str(&fields_layout(name, fields, &types));
            }
            FrozenUnit::Error {
                name,
                fields,
                ordinal,
                ..
            } => {
                decls.push_str(&interface(name, fields, &types));
                decls.push_str(&fields_layout(name, fields, &types));
                decls.push_str(&error_class(name, *ordinal));
            }
            FrozenUnit::Enum { name, variants, .. } => {
                decls.push_str(&string_enum(name, variants));
                let names: Vec<String> = variants
                    .iter()
                    .filter_map(|v| match v {
                        FrozenUnit::EnumVariant(v, _) => Some(format!("\"{v}\"")),
                        _ => None,
                    })
                    .collect();
                decls.push_str(&types.layout_decl(name, &format!("{{ enum: [{}] }}", names.join(", "))));
            }
            FrozenUnit::TypeAlias { name, target, .. } => {
                decls.push_str(&type_alias(name, target, &types));
                decls.push_str(&types.layout_decl(name, &types.layout(target, true)));
            }
            FrozenUnit::Constant {
                docstring,
                name,
                ty,
                value,
                ..
            } => {
                decls.push_str(&constant(docstring.as_deref(), name, ty, value.as_ref()));
            }
            FrozenUnit::Protocol {
                name,
                functions,
                parameters,
                ..
            } => {
                let number = connections::on_connection(schemas, parameters)
                    .then(|| connections::protocol_number(schemas, namespace, name))
                    .flatten();
                // JSON-RPC names a call by its method: bare, or qualified by
                // protocol.
                let framing = connections::framing(parameters);
                let method_names = match framing.name {
                    FRAMING_JSONRPC => framing.method_names,
                    _ => Default::default(),
                };
                decls.push_str(&protocol(
                    name,
                    namespace,
                    functions,
                    parameters,
                    &framing_choice(parameters),
                    method_names,
                    number,
                    &errors,
                    &types,
                ));
            }
            _ => {}
        }
    }

    let has_protocol = units
        .iter()
        .any(|u| matches!(u, FrozenUnit::Protocol { .. }));

    // Which framings the protocols in this file reach for: the lockstep ones
    // only, since a protocol on a connection names none of its own.
    let on_connection = |parameters: &[FrozenUnit]| connections::on_connection(schemas, parameters);
    let picks: Vec<FramingChoice> = units
        .iter()
        .filter_map(|u| match u {
            FrozenUnit::Protocol { parameters, .. } if !on_connection(parameters) => {
                Some(framing_choice(parameters))
            }
            _ => None,
        })
        .collect();
    let has_lockstep = !picks.is_empty();
    let has_connection = units.iter().any(
        |u| matches!(u, FrozenUnit::Protocol { parameters, .. } if on_connection(parameters)),
    );
    // Whether a protocol here encodes with the package's codec: JSON-RPC
    // carries JSON whatever it says.
    let formatted = units.iter().any(|u| {
        matches!(u, FrozenUnit::Protocol { parameters, .. } if connections::framing(parameters).name != FRAMING_JSONRPC)
    });

    // The runtime import and the `IR_HASH` const, which only depend on the
    // schema's own shape.
    let mut runtime_import = String::new();
    let mut ir_hash = String::new();
    if has_protocol {
        let mut values = Vec::new();
        if has_lockstep {
            values.extend(["Client", "Server"]);
        }
        values.extend(["RuntimeError", "resolveKind"]);
        if picks.iter().any(|p| !p.jsonrpc) {
            values.push("DatagramFraming");
        }
        if picks.iter().any(|p| p.jsonrpc) {
            values.push("JsonRpcFraming");
        }
        // The package's codec, and JSON for a lockstep JSON-RPC protocol.
        if formatted {
            values.push(codec);
        }
        if codec != "JsonCodec" && picks.iter().any(|p| p.jsonrpc) {
            values.push("JsonCodec");
        }
        let any_none = units.iter().any(|u| {
            matches!(u, FrozenUnit::Protocol { parameters, .. } if no_handshake(parameters) && !on_connection(parameters))
        });
        if any_none {
            values.push("NoHandshake");
        }
        runtime_import.push_str("import {\n");
        for v in values {
            runtime_import.push_str(&format!("    {v},\n"));
        }
        let mut type_names = vec!["Codec"];
        if has_connection {
            type_names.push("Connection");
        }
        type_names.push("Dispatch");
        if has_lockstep {
            type_names.push("Framing");
        }
        type_names.push("Kind");
        if types.declares_layouts() {
            type_names.push("Layout");
        }
        if has_connection {
            type_names.push("Peer");
        }
        type_names.push("Reply");
        if has_lockstep {
            type_names.push("Transport");
        }
        for t in type_names {
            runtime_import.push_str(&format!("    type {t},\n"));
        }
        runtime_import.push_str("} from \"@comline/runtime\";\n\n");

        ir_hash.push_str(&format!(
            "/** Canonical digest of the frozen IR this file was generated from — the\n\
             *  two ends of a connection must agree on it. */\n\
             export const IR_HASH = {:#018x}n;\n\n",
            schema_ir_hash(units)
        ));
        if has_connection {
            ir_hash.push_str(&format!(
                "/** Digest of every schema in the package — what a connection's handshake\n\
                 *  checks, so both ends agree on each protocol's number. */\n\
                 export const CONNECTION_IR_HASH = {:#018x}n;\n\n",
                connections::connection_ir_hash(schemas)
            ));
        }
        if formatted {
            ir_hash.push_str(&format!(
                "/** The package's wire format (`wire.format`): what this file's helpers\n\
                 *  encode with, and what the peer has to speak too. */\n\
                 export const Format: Codec = new {codec}();\n\n"
            ));
        }
    } else if types.declares_layouts() {
        runtime_import.push_str(&format!("import type {{ Layout }} from \"{RUNTIME_PACKAGE}\";\n\n"));
    }

    // External package first, then relative imports, then the file's own
    // content - the order a hand-written module would use.
    let mut output = format!("{header}\n");
    output.push_str(&runtime_import);
    output.push_str(&types.import_header(namespace));
    output.push_str(&ir_hash);
    output.push_str(&decls);
    output
}

// ── data types ─────────────────────────────────────────────────────────────

/// `export type NAME = TARGET;` - transparent like Rust's own `type` (not a
/// newtype): `ts_type` already maps any type to a real TS type
/// expression, named or primitive, so this is the same mapping every field
/// already goes through, just at the top level of the file instead of
/// inside an interface.
fn type_alias(name: &str, target: &TypeRef, types: &TypeMapper) -> String {
    format!("export type {name} = {};\n\n", types.ts_type(target))
}

/// `const MAX_RETRIES: u8 = 5` -> `export const MAX_RETRIES = 5;`.
///
/// Declarations used to vanish here: a schema of nothing but constants
/// generated an empty file. The IR carries the declared type next to the
/// literal, so a `u8` constant and a `u64` one stay distinguishable.
///
/// **No type annotation, deliberately.** TypeScript has no `u8`, so
/// annotating would mean writing `number` and throwing away what the
/// inferred literal type (`5`) already says more precisely. The exception is
/// a 64- or 128-bit integer, which [`primitive_ts_type`] maps to `bigint` and
/// which therefore needs the `n` suffix on the literal to *be* one.
fn constant(
    docstring: Option<&str>,
    name: &str,
    ty: &TypeRef,
    value: Option<&Literal>,
) -> String {
    // Validation refuses a constant that isn't a primitive with a literal
    // value, so neither early return is reachable from a real build.
    let Some(primitive) = ty.as_primitive() else {
        return String::new();
    };
    let value = match (primitive, value) {
        (_, Some(Literal::String(text))) => format!("{text:?}"),
        // `bigint` is a distinct type from `number`, and `7` is not one.
        (p, Some(Literal::Integer(i))) if is_wide(p) => format!("{i}n"),
        (_, Some(literal @ (Literal::Integer(_) | Literal::Bool(_)))) => literal.to_string(),
        _ => return String::new(),
    };

    let mut s = String::new();
    // A docstring is carried as JSDoc so editors show it. Note that structs,
    // enums and protocols still drop theirs - a separate gap, not one this
    // should quietly match.
    if let Some(doc) = docstring.filter(|d| !d.trim().is_empty()) {
        s.push_str("/**\n");
        for line in doc.lines() {
            s.push_str(&format!(" * {line}\n"));
        }
        s.push_str(" */\n");
    }
    s.push_str(&format!("export const {name} = {value};\n\n"));
    s
}

fn interface(name: &str, fields: &[FrozenUnit], types: &TypeMapper) -> String {
    let mut s = format!("export interface {name} {{\n");
    for field in fields {
        if let FrozenUnit::Field {
            name,
            ty,
            optional,
            ..
        } = field
        {
            let opt = if *optional { "?" } else { "" };
            s.push_str(&format!("    {name}{opt}: {};\n", types.ts_type(ty)));
        }
    }
    s.push_str("}\n\n");
    s
}

/// The `Layout` of a struct, an `error` or a params interface: its fields,
/// in declaration order, an optional one wrapped.
fn fields_layout(name: &str, fields: &[FrozenUnit], types: &TypeMapper) -> String {
    let members: Vec<(&str, &TypeRef, bool)> = fields
        .iter()
        .filter_map(|f| match f {
            FrozenUnit::Field { name, ty, optional, .. } => Some((name.as_str(), ty, *optional)),
            _ => None,
        })
        .collect();
    args_layout(name, &members, types)
}

fn args_layout(name: &str, fields: &[(&str, &TypeRef, bool)], types: &TypeMapper) -> String {
    let members: Vec<String> = fields
        .iter()
        .map(|(field, ty, optional)| {
            let layout = types.layout(ty, true);
            let layout = if *optional { format!("{{ option: {layout} }}") } else { layout };
            format!("[\"{field}\", {layout}]")
        })
        .collect();
    types.layout_decl(name, &format!("{{ struct: [{}] }}", members.join(", ")))
}

/// The throwable for an `error`: a provider `throw`s `new <Name>Error(data)`;
/// the dispatcher catches it and the client re-raises it, both keyed by
/// `<Name>Error.ordinal`.
fn error_class(name: &str, ordinal: u16) -> String {
    format!(
        "export class {name}Error extends Error {{\n\
        \x20   static readonly ordinal = {ordinal};\n\
        \x20   readonly data: {name};\n\
        \x20   constructor(data: {name}) {{\n\
        \x20       super(\"{name}\");\n\
        \x20       this.data = data;\n\
        \x20       this.name = \"{name}Error\";\n\
        \x20   }}\n\
        }}\n\n"
    )
}

/// An `enum` as a `const` object of its variants' wire names, and the union
/// of those names as a type of the same name.
fn string_enum(name: &str, variants: &[FrozenUnit]) -> String {
    let mut s = format!("export const {name} = {{\n");
    for variant in variants {
        if let FrozenUnit::EnumVariant(v, _) = variant {
            s.push_str(&format!("    {v}: \"{v}\",\n"));
        }
    }
    s.push_str(&format!("}} as const;\nexport type {name} = (typeof {name})[keyof typeof {name}];\n\n"));
    s
}

// ── framing selection ──────────────────────────────────────────────────────

struct FramingChoice {
    /// The runtime class name — `DatagramFraming` or `JsonRpcFraming`.
    ctor: &'static str,
    jsonrpc: bool,
}

/// The accepted spellings and their aliases come from core, not from a
/// copy kept here - this generator, the Rust one and the playground each
/// used to maintain their own, and they had drifted.
fn framing_for(name: &str) -> Option<FramingChoice> {
    match comline_core::schema::idl::annotations::canonical_value("framing", name)? {
        "jsonrpc" => Some(FramingChoice {
            ctor: "JsonRpcFraming",
            jsonrpc: true,
        }),
        "datagram" => Some(FramingChoice {
            ctor: "DatagramFraming",
            jsonrpc: false,
        }),
        // A protocol on it runs on a `Connection`, which names its framing
        // itself; this only says the name is known.
        comline_core::schema::idl::annotations::FRAMING_DATAGRAM2 => Some(FramingChoice {
            ctor: "Datagram2Framing",
            jsonrpc: false,
        }),
        _ => None,
    }
}

/// A protocol's framing: its `@framing`, which core has filled in from the
/// package's `wire.framing`, else `datagram@2`.
fn framing_choice(parameters: &[FrozenUnit]) -> FramingChoice {
    framing_for(connections::framing(parameters).name).expect("core only lets known framings through")
}

/// The runtime's codec class for a wire format name. `None` for one it has
/// no codec for.
fn codec_class(name: &str) -> Option<&'static str> {
    use comline_core::schema::idl::annotations::{FORMAT_JSON, FORMAT_PACKED};
    match name {
        FORMAT_PACKED => Some("PackedCodec"),
        FORMAT_JSON => Some("JsonCodec"),
        _ => None,
    }
}

/// The text of a scalar `@key = value` annotation (a
/// `FrozenUnit::Property`).
///
/// The frozen value is typed now, so this renders it back to text for the
/// callers that only interpolate it. A caller that cares *which kind* of
/// value it got should match `ConfigValue` instead.
fn annotation<'a>(parameters: &'a [FrozenUnit], key: &str) -> Option<Cow<'a, str>> {
    parameters.iter().find_map(|p| match p {
        FrozenUnit::Property { name, value } if name == key => value.as_text(),
        _ => None,
    })
}

/// What a lockstep protocol's helpers encode with when not told: JSON for a
/// JSON-RPC protocol, the package's `Format` otherwise.
fn default_codec(parameters: &[FrozenUnit]) -> &'static str {
    if connections::framing(parameters).name == FRAMING_JSONRPC {
        "new JsonCodec()"
    } else {
        "Format"
    }
}

// ── the package's connection ───────────────────────────────────────────────

/// The package module's file, beside the schemas: `connection.ts`.
const PACKAGE_MODULE: &str = "connection";

/// The package's one connection, set up in one call: `Services` (what the
/// accepting side provides), `ClientServices` (what the dialling side does),
/// and `accept` / `serve` / `connect`. `None` when no protocol this package
/// emits is on a connection, or when its protocols don't share one
/// (`comline generate` says why).
fn package_module(header: &str, req: &GenRequest, emitted: &[(String, Vec<FrozenUnit>)], codec: &str) -> Option<String> {
    let package = connections::package_connection(req.schemas).ok()??;
    // Only what this package emits: an external `std` provides nothing here.
    let emitted_only = |side: &[connections::Provided]| -> Vec<connections::Provided> {
        side.iter().filter(|p| emitted.iter().any(|(ns, _)| *ns == p.namespace)).cloned().collect()
    };
    let (server, client) = (emitted_only(&package.server), emitted_only(&package.client));
    if server.is_empty() && client.is_empty() {
        return None;
    }
    let jsonrpc = package.framing == FRAMING_JSONRPC;
    let unverified = package.handshake == HANDSHAKE_NONE;
    // Each schema the module reaches, under a name of its own.
    let module = |namespace: &str| format!("ns_{}", namespace.replace(['/', ':', '-', '.'], "_"));

    let mut values = vec!["Connection"];
    // JSON-RPC carries JSON whatever the package's format is.
    let connection_codec = if jsonrpc { "new JsonCodec()" } else { "Format" };
    if jsonrpc {
        values.push("JsonCodec");
        values.push("JsonRpcConnectionFraming");
    }
    if !values.contains(&codec) {
        values.push(codec);
    }
    if unverified {
        values.push("NoHandshake");
    }
    let mut s = format!("{header}\nimport {{\n");
    for v in &values {
        s.push_str(&format!("    {v},\n"));
    }
    s.push_str("    type Codec,\n    type Transport,\n} from \"@comline/runtime\";\n");
    let namespaces: BTreeSet<&str> = server.iter().chain(&client).map(|p| p.namespace.as_str()).collect();
    for namespace in &namespaces {
        s.push_str(&format!(
            "import * as {} from \"{}\";\n",
            module(namespace),
            relative_specifier(PACKAGE_MODULE, namespace)
        ));
    }
    s.push_str(&format!(
        "\n/** The package's wire format (`wire.format`). */\n\
         export const Format: Codec = new {codec}();\n\n\
         /** Digest of every schema in the package — what a connection's handshake\n\
         *  checks, so both ends agree on each protocol's number. */\n\
         export const CONNECTION_IR_HASH = {:#018x}n;\n\n",
        connections::connection_ir_hash(req.schemas)
    ));

    let mut side = |ty: &str, provide: &str, provided: &[connections::Provided], who: &str| {
        if provided.is_empty() {
            return false;
        }
        s.push_str(&format!(
            "/** What {who} provides: one field per protocol, so leaving one out doesn't type-check. */\n\
             export interface {ty} {{\n"
        ));
        for p in provided {
            s.push_str(&format!("    {}: {}.{};\n", camel(&p.field), module(&p.namespace), p.name));
        }
        s.push_str("}\n\n");
        s.push_str(&format!(
            "/** Provide every protocol in `services` on `conn`: the peer's calls to them come here. */\n\
             export function {provide}(conn: Connection, services: {ty}): void {{\n"
        ));
        for p in provided {
            s.push_str(&format!(
                "    new {}.{}Dispatcher(services.{}).provideOn(conn);\n",
                module(&p.namespace),
                p.name,
                camel(&p.field)
            ));
        }
        s.push_str("}\n\n");
        true
    };
    let has_server = side("Services", "provideServices", &server, "the accepting side");
    let has_client = side("ClientServices", "provideClientServices", &client, "the dialling side");

    let framing_arg = if jsonrpc { ", new JsonRpcConnectionFraming()" } else if unverified { ", undefined" } else { "" };
    let handshake_arg = if unverified { ", new NoHandshake()" } else { "" };
    let open = |side: &str| {
        format!("await Connection.{side}(transport, {connection_codec}, CONNECTION_IR_HASH{framing_arg}{handshake_arg})")
    };
    let (server_params, server_provide) = if has_server {
        ("transport: Transport, services: Services", "    provideServices(conn, services);\n")
    } else {
        ("transport: Transport", "")
    };
    let (client_params, client_provide) = if has_client {
        ("transport: Transport, services: ClientServices", "    provideClientServices(conn, services);\n")
    } else {
        ("transport: Transport", "")
    };
    let pass = if has_server { "transport, services" } else { "transport" };
    s.push_str(&format!(
        "/**\n\
         * Accept a connection over `transport`: run the handshake, then provide\n\
         * every protocol in `services` on it. The connection comes back serving,\n\
         * so the server can call the client through it.\n\
         */\n\
         export async function accept({server_params}): Promise<Connection> {{\n\
         \x20   const conn = {};\n\
         {server_provide}\
         \x20   return conn;\n\
         }}\n\n\
         /** {{@link accept}}, then serve every call until the peer leaves. */\n\
         export async function serve({server_params}): Promise<void> {{\n\
         \x20   await (await accept({pass})).closed;\n\
         }}\n\n\
         /**\n\
         * Dial over `transport`: run the handshake, then provide every protocol in\n\
         * `services`, which the server calls. Call the server's protocols through\n\
         * their senders.\n\
         */\n\
         export async function connect({client_params}): Promise<Connection> {{\n\
         \x20   const conn = {};\n\
         {client_provide}\
         \x20   return conn;\n\
         }}\n",
        open("accept"),
        open("connect"),
    ));
    Some(s)
}

// ── protocol ───────────────────────────────────────────────────────────────

struct FnInfo {
    name: String,
    /// What a call names it on the wire, and the call table holds: `name`,
    /// or under JSON-RPC's qualified method names `ns.Proto/name`.
    method: String,
    params_ty: Option<String>,
    args: Vec<(String, String)>,
    /// The params interface's `Layout` declaration, beside the interface.
    params_layout: Option<String>,
    /// The declared return type; `void` for a one-way call or a `()` return.
    ret: String,
    /// The return value's `Layout`, as a call passes it.
    ret_layout: String,
    one_way: bool,
    /// `(ordinal, error interface name)` for each `!`. Empty for a one-way
    /// call.
    throws: Vec<(u16, String)>,
}

/// `@handshake = "none"` (or the package default, which core has already
/// written into the protocol): connect and serve pass the runtime's
/// `NoHandshake`.
fn no_handshake(parameters: &[FrozenUnit]) -> bool {
    annotation(parameters, "handshake").as_deref() == Some(HANDSHAKE_NONE)
}

/// A doc comment naming what an `@unverified` protocol gives up, and why,
/// for its dispatcher and client. Empty for one that gives nothing up.
fn unverified_doc(parameters: &[FrozenUnit]) -> String {
    let set = unverified::frozen_set(parameters);
    if set.is_empty() {
        return String::new();
    }
    let mut doc = format!(
        "/**\n * **Unverified:** gives up {} ({}).\n",
        unverified::describe(set),
        unverified::cause(parameters)
    );
    if let Some(reason) = unverified::reason(parameters) {
        doc.push_str(&format!(" * Reason given: {reason}\n"));
    }
    doc.push_str(" */\n");
    doc
}

/// `number` is the protocol's number on a connection, for a protocol that
/// runs on one: its handlers take the peer, its dispatcher is provided on a
/// `Connection`, and a `<Proto>Sender` calls it through any `Peer`.
#[allow(clippy::too_many_arguments)]
fn protocol(
    proto: &str,
    namespace: &str,
    functions: &[FrozenUnit],
    parameters: &[FrozenUnit],
    framing: &FramingChoice,
    method_names: MethodNames,
    number: Option<u16>,
    errors: &HashMap<u16, String>,
    types: &TypeMapper,
) -> String {
    let fns: Vec<FnInfo> = functions
        .iter()
        .filter_map(|f| match f {
            FrozenUnit::Function {
                name,
                arguments,
                _return,
                throws,
                ..
            } => {
                let one_way = _return.is_none();
                let args: Vec<(String, String)> = arguments
                    .iter()
                    .map(|a| (a.name.clone(), types.ts_type(&a.ty)))
                    .collect();
                let params_ty =
                    (!args.is_empty()).then(|| format!("{proto}{}Params", pascal(name)));
                let params_layout = params_ty.as_ref().map(|ty| {
                    let fields: Vec<(&str, &TypeRef, bool)> =
                        arguments.iter().map(|a| (a.name.as_str(), &a.ty, false)).collect();
                    args_layout(ty, &fields, types)
                });
                let (ret, ret_layout) = match _return {
                    None | Some(TypeRef::Unit) => ("void".to_string(), "\"unit\"".to_string()),
                    Some(ty) => (types.ts_type(ty), types.layout(ty, false)),
                };
                let throws: Vec<(u16, String)> = if one_way {
                    Vec::new()
                } else {
                    throws
                        .iter()
                        .map(|o| {
                            let name = errors
                                .get(o)
                                .cloned()
                                .unwrap_or_else(|| format!("UnknownError{o}"));
                            (*o, name)
                        })
                        .collect()
                };
                Some(FnInfo {
                    name: name.clone(),
                    method: connections::method_name(namespace, proto, name, method_names),
                    params_ty,
                    args,
                    params_layout,
                    ret,
                    ret_layout,
                    one_way,
                    throws,
                })
            }
            _ => None,
        })
        .collect();

    let mut s = String::new();

    // 1. a params interface per function that takes arguments
    for f in &fns {
        if let Some(ty) = &f.params_ty {
            s.push_str(&format!("export interface {ty} {{\n"));
            for (name, tsty) in &f.args {
                s.push_str(&format!("    {name}: {tsty};\n"));
            }
            s.push_str("}\n\n");
            if let Some(layout) = &f.params_layout {
                s.push_str(layout);
            }
        }
    }

    if fns.is_empty() {
        s.push_str(&format!("export interface {proto} {{}}\n\n"));
        return s;
    }

    // 2. the provider interface — every call is async
    s.push_str(&format!("export interface {proto} {{\n"));
    for f in &fns {
        if !f.throws.is_empty() {
            let names = f
                .throws
                .iter()
                .map(|(_, n)| format!("{n}Error"))
                .collect::<Vec<_>>()
                .join(" | ");
            s.push_str(&format!("    /** @throws {{{names}}} */\n"));
        }
        let mut params: Vec<String> = Vec::new();
        if number.is_some() {
            params.push("peer: Peer".to_string());
        }
        params.extend(f.params_ty.as_ref().map(|t| format!("params: {t}")));
        s.push_str(&format!("    {}({}): Promise<{}>;\n", f.name, params.join(", "), f.ret));
    }
    s.push_str("}\n\n");

    // 3. the call table
    let calls_const = format!("{}_CALLS", screaming_snake(proto));
    let call_names = fns
        .iter()
        .map(|f| format!("\"{}\"", f.method))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!(
        "export const {calls_const} = [{call_names}] as const;\n\n"
    ));

    let doc = unverified_doc(parameters);
    let (handshake_arg, handshake_note) = if no_handshake(parameters) {
        (", new NoHandshake()", "        // No handshake: `@handshake = \"none\"`.\n")
    } else {
        ("", "")
    };

    // 4. the dispatcher
    s.push_str(&doc);
    s.push_str(&format!(
        "export class {proto}Dispatcher implements Dispatch {{\n"
    ));
    if let Some(number) = number {
        s.push_str(&format!(
            "    /** This protocol's number on a connection. */\n\
            \x20   static readonly PROTOCOL = {number};\n\n"
        ));
    }
    s.push_str(&format!(
        "    private readonly impl: {proto};\n\n\
        \x20   constructor(impl: {proto}) {{\n\
        \x20       this.impl = impl;\n\
        \x20   }}\n\n\
        \x20   calls(): readonly string[] {{\n\
        \x20       return {calls_const};\n\
        \x20   }}\n\n"
    ));
    if number.is_some() {
        // Its handlers take the peer, which only a connection has.
        s.push_str(
            "    /** Only served on a connection, whose handlers are given the peer: anywhere else the caller hears a fault. */\n\
            \x20   async dispatch(_call: Kind, _params: Uint8Array, _codec: Codec, reply: Reply): Promise<void> {\n\
            \x20       reply.fault();\n\
            \x20   }\n\n\
            \x20   async dispatchWith(call: Kind, params: Uint8Array, reply: Reply, peer: Peer): Promise<void> {\n\
            \x20       const codec = peer.codec;\n",
        );
    } else {
        s.push_str(
            "    async dispatch(call: Kind, params: Uint8Array, codec: Codec, reply: Reply): Promise<void> {\n",
        );
    }
    s.push_str(&format!("        switch (resolveKind(call, {calls_const})) {{\n"));
    let peer_arg = if number.is_some() { Some("peer") } else { None };
    for (i, f) in fns.iter().enumerate() {
        s.push_str(&format!("            case {i}: {{\n"));
        // Emitted *inside* the `try` below, so params that will not decode are
        // handled with the same arity awareness as a handler that throws.
        let decode_line = match &f.params_ty {
            Some(ty) => format!("                    const p = codec.decode<{ty}>(params, {ty}Layout);\n"),
            None => String::new(),
        };
        let call_arg = peer_arg
            .into_iter()
            .chain(f.params_ty.is_some().then_some("p"))
            .collect::<Vec<_>>()
            .join(", ");
        if f.one_way {
            // No response frame, so nothing a failure could be reported in.
            s.push_str("                try {\n");
            s.push_str(&decode_line);
            s.push_str(&format!(
                "                    await this.impl.{}({call_arg});\n",
                f.name
            ));
            s.push_str("                } catch {\n");
            s.push_str("                    /* one-way: nowhere to report this */\n");
            s.push_str("                }\n");
            s.push_str("                return;\n");
        } else {
            // Every request/response call answers, whatever the handler threw:
            // a declared error at its ordinal, anything else as a fault. The
            // arity is why this belongs here rather than in `Server` - the
            // server cannot see it, and a stray frame sent after a one-way
            // call would desynchronise the stream.
            s.push_str("                try {\n");
            s.push_str(&decode_line);
            // A `void` result can't be tested for nullishness before
            // TypeScript 5.5 (TS1345), so a `()` return answers `null` after
            // the call rather than `?? null` on it.
            if f.ret == "void" {
                s.push_str(&format!(
                    "                    await this.impl.{}({call_arg});\n\
                    \x20                   reply.ok(codec.encode(null, \"unit\"));\n",
                    f.name
                ));
            } else {
                s.push_str(&format!(
                    "                    reply.ok(codec.encode((await this.impl.{}({call_arg})) ?? null, {}));\n",
                    f.name, f.ret_layout
                ));
            }
            // Only bind the exception when there is a declared error to test
            // it against; an unused binding is a lint failure in the output.
            if f.throws.is_empty() {
                s.push_str("                } catch {\n");
            } else {
                s.push_str("                } catch (e) {\n");
            }
            for (_, err) in &f.throws {
                s.push_str(&format!(
                    "                    if (e instanceof {err}Error) {{ reply.err({err}Error.ordinal, codec.encode(e.data, {err}Layout)); return; }}\n"
                ));
            }
            s.push_str("                    reply.fault();\n");
            s.push_str("                }\n");
            s.push_str("                return;\n");
        }
        s.push_str("            }\n");
    }
    s.push_str(
        "            default:\n\
        \x20               throw RuntimeError.unknownCall();\n\
        \x20       }\n\
        \x20   }\n",
    );
    if number.is_some() {
        let open = match (framing.jsonrpc, no_handshake(parameters)) {
            (false, true) => "`Connection.accept(transport, Format, CONNECTION_IR_HASH, framing, new NoHandshake())`",
            (false, false) => "`Connection.accept(transport, Format, CONNECTION_IR_HASH)`",
            (true, true) => {
                "`Connection.accept(transport, new JsonCodec(), CONNECTION_IR_HASH, new JsonRpcConnectionFraming(), new NoHandshake())`"
            }
            (true, false) => "`Connection.accept(transport, new JsonCodec(), CONNECTION_IR_HASH, new JsonRpcConnectionFraming())`",
        };
        // The side that provides it opens: a client-provided protocol dials.
        let open = if connections::Provider::of(parameters) == connections::Provider::Client {
            open.replace("Connection.accept", "Connection.connect")
        } else {
            open.to_string()
        };
        s.push_str(&format!(
            "\n    /** Provide this protocol on `conn`: the peer's calls to it come here. Open `conn` with {open}, or let the package's `serve` / `connect` do it. */\n\
            \x20   provideOn(conn: Connection): void {{\n\
            \x20       conn.provide({proto}Dispatcher.PROTOCOL, this);\n\
            \x20   }}\n"
        ));
    }
    s.push_str("}\n\n");

    // 5. the client, or on a connection, the sender
    s.push_str(&doc);
    let (field, call_prefix) = match number {
        Some(number) => {
            s.push_str(&format!(
                "/** Calls protocol `{proto}` on the other end of a connection: the peer a `Connection` reaches, or the one a handler was given. */\n\
                export class {proto}Sender {{\n\
                \x20   /** This protocol's number on a connection. */\n\
                \x20   static readonly PROTOCOL = {number};\n\n\
                \x20   private readonly peer: Peer;\n\n\
                \x20   constructor(peer: Peer) {{\n\
                \x20       this.peer = peer;\n\
                \x20   }}\n"
            ));
            ("peer", format!("{proto}Sender.PROTOCOL, "))
        }
        None => {
            let codec = default_codec(parameters);
            s.push_str(&format!(
                "export class {proto}Client {{\n\
                \x20   private readonly client: Client;\n\n\
                \x20   constructor(client: Client) {{\n\
                \x20       this.client = client;\n\
                \x20   }}\n\n\
                \x20   static async connect(transport: Transport, codec: Codec = {codec}, framing: Framing = new {ctor}()): Promise<{proto}Client> {{\n\
                {handshake_note}\
                \x20       return new {proto}Client(await Client.connect(transport, codec, IR_HASH, framing{handshake_arg}));\n\
                \x20   }}\n",
                ctor = framing.ctor
            ));
            ("client", String::new())
        }
    };
    for (i, f) in fns.iter().enumerate() {
        let sig_params = f
            .params_ty
            .as_ref()
            .map_or(String::new(), |t| format!("params: {t}"));
        let arg = if f.params_ty.is_some() {
            "params"
        } else {
            "null"
        };
        let layout = f.params_ty.as_ref().map_or("\"unit\"".to_string(), |ty| format!("{ty}Layout"));
        s.push('\n');
        if f.one_way {
            s.push_str(&format!(
                "    async {}({sig_params}): Promise<void> {{\n\
                 \x20       await this.{field}.notify({call_prefix}{{ id: {i}, name: \"{}\" }}, {arg}, {{ layout: {layout} }});\n\
                 \x20   }}\n",
                f.name, f.method
            ));
            continue;
        }
        s.push_str(&format!(
            "    async {}({sig_params}): Promise<{}> {{\n\
             \x20       const env = await this.{field}.call({call_prefix}{{ id: {i}, name: \"{}\" }}, {arg}, {{ layout: {layout} }});\n",
            f.name, f.ret, f.method
        ));
        if f.ret == "void" {
            s.push_str("        if (\"ok\" in env) return;\n");
        } else {
            s.push_str(&format!(
                "        if (\"ok\" in env) return this.{field}.codec.decode<{}>(env.ok, {});\n",
                f.ret, f.ret_layout
            ));
        }
        // A fault is not an `err`, so it has to be taken off the union before
        // anything reads `env.err` - and a peer can send one for any call,
        // including one that declares no `!`.
        s.push_str("        if (\"fault\" in env) throw RuntimeError.provider();\n");
        if f.throws.is_empty() {
            s.push_str("        throw RuntimeError.remote(env.err.id);\n");
        } else {
            s.push_str("        switch (env.err.id) {\n");
            for (_, err) in &f.throws {
                s.push_str(&format!(
                    "            case {err}Error.ordinal:\n\
                     \x20               throw new {err}Error(this.{field}.codec.decode<{err}>(env.err.body, {err}Layout));\n"
                ));
            }
            s.push_str("            default:\n");
            s.push_str("                throw RuntimeError.remote(env.err.id);\n");
            s.push_str("        }\n");
        }
        s.push_str("    }\n");
    }
    s.push_str("}\n\n");

    // 6. the serve helper, for the lockstep `Server`
    if number.is_none() {
        s.push_str(&format!(
            "export function serve{proto}(impl: {proto}, transport: Transport, codec: Codec = {codec}, framing: Framing = new {ctor}()): Promise<void> {{\n\
            {handshake_note}\
            \x20   return new Server(new {proto}Dispatcher(impl), codec, framing).serve(transport, IR_HASH{handshake_arg});\n\
            }}\n\n",
            ctor = framing.ctor,
            codec = default_codec(parameters),
        ));
    }

    s
}

// ── type mapping ───────────────────────────────────────────────────────────

/// Maps a type to a TypeScript type expression, and remembers which
/// of this schema's imported names the mapping actually reached for — the
/// import header is built from that, so an unused `use` produces no import.
///
/// Interior mutability rather than `&mut` threading: every caller
/// (`interface`, `type_alias`, `protocol`) only ever reads, and the
/// alternative is a `&mut` parameter on each of them for no gain.
struct TypeMapper {
    uses: UseTracker,
    /// Whether a std namespace resolves to `@comline/std` instead of a file
    /// in this package.
    external_std: bool,
    /// Imported names whose `<Name>Layout` value this file uses, so it's
    /// imported beside the type.
    layouts: RefCell<BTreeSet<String>>,
    /// Whether this file declares a `Layout`, and so imports the type.
    declares_layouts: Cell<bool>,
}

impl TypeMapper {
    fn new(
        units: &[FrozenUnit],
        schemas: &[(String, Vec<FrozenUnit>)],
        external_std: bool,
    ) -> Self {
        // With `external_std`, std is nameable even though no file is
        // emitted for it - the one case where a namespace resolves without
        // being in the output.
        let table = SymbolTable::with_external(units, schemas, |namespace| {
            external_std && is_std_namespace(namespace)
        });
        Self {
            uses: UseTracker::new(table),
            external_std,
            layouts: RefCell::new(BTreeSet::new()),
            declares_layouts: Cell::new(false),
        }
    }

    /// The `Layout` of a value of `ty`: everything about it the bytes of a
    /// positional format leave out, which `@comline/runtime`'s codecs read
    /// (the JSON codec only for where a `bigint` goes).
    ///
    /// `lazy` refers to a named type through a function, `() => MessageLayout`,
    /// so the reference resolves when encoding rather than when the module
    /// loads: declarations can name each other in any order, across files,
    /// and recursively. At a call every module has loaded, so it's direct.
    fn layout(&self, ty: &TypeRef, lazy: bool) -> String {
        match ty {
            TypeRef::Primitive(p) => format!("\"{}\"", primitive_layout(*p)),
            TypeRef::Named(name) => {
                self.uses.resolve(name);
                self.layouts.borrow_mut().insert(name.clone());
                if lazy {
                    format!("() => {name}Layout")
                } else {
                    format!("{name}Layout")
                }
            }
            TypeRef::Array { element, length: None } => format!("{{ array: {} }}", self.layout(element, lazy)),
            TypeRef::Array { element, length: Some(n) } => {
                format!("{{ fixed: {}, length: {n} }}", self.layout(element, lazy))
            }
            TypeRef::Union(members) => format!(
                "{{ union: [{}] }}",
                members.iter().map(|m| self.layout(m, lazy)).collect::<Vec<_>>().join(", ")
            ),
            TypeRef::Unit => "\"unit\"".to_string(),
        }
    }

    /// `export const NAMELayout: Layout = LAYOUT;`, beside the type `name`
    /// declares.
    fn layout_decl(&self, name: &str, layout: &str) -> String {
        self.declares_layouts.set(true);
        format!("export const {name}Layout: Layout = {layout};\n\n")
    }

    fn declares_layouts(&self) -> bool {
        self.declares_layouts.get()
    }

    /// `import type` lines for every imported name the rendering reached for,
    /// one per source module, relative to `namespace`.
    fn import_header(&self, namespace: &str) -> String {
        // (declared, bound) pairs per source namespace; sorted, so output is
        // stable. `reached` has already dropped anything resolving back to
        // this schema, which would otherwise be a circular self-import.
        let mut by_module: BTreeMap<String, BTreeSet<(String, String)>> = BTreeMap::new();
        for (bound, origin) in self.uses.reached(namespace) {
            by_module
                .entry(origin.namespace)
                .or_default()
                .insert((origin.declared, bound));
        }

        let layouts = self.layouts.borrow();
        let mut s = String::new();
        for (module, names) in by_module {
            let specifier = self.specifier_for(namespace, &module);
            let named = |(declared, bound): &(String, String), suffix: &str| {
                if declared == bound {
                    format!("{declared}{suffix}")
                } else {
                    format!("{declared}{suffix} as {bound}{suffix}")
                }
            };
            // A name whose `Layout` is used imports that as a value; every
            // name is imported as a type.
            let values: Vec<String> =
                names.iter().filter(|(_, bound)| layouts.contains(bound)).map(|n| named(n, "Layout")).collect();
            let types: Vec<String> = names.iter().map(|n| named(n, "")).collect();
            if !values.is_empty() {
                s.push_str(&format!("import {{ {} }} from \"{specifier}\";\n", values.join(", ")));
            }
            s.push_str(&format!("import type {{ {} }} from \"{specifier}\";\n", types.join(", ")));
        }
        if !s.is_empty() {
            s.push('\n');
        }
        s
    }

    /// Where `to` is imported from: `@comline/std/<rest>` when it is std and
    /// std is external, otherwise a path relative to `from`.
    fn specifier_for(&self, from: &str, to: &str) -> String {
        if self.external_std && is_std_namespace(to) {
            // `@comline/std` is its own package root, not a `std` directory
            // inside one, so the leading segment goes - exactly as
            // `comline_std::http::Request` drops it on the Rust side.
            let rest = to.strip_prefix("std/").unwrap_or("");
            return if rest.is_empty() {
                STD_PACKAGE.to_string()
            } else {
                format!("{STD_PACKAGE}/{rest}")
            };
        }
        relative_specifier(from, to)
    }

    fn ts_type(&self, ty: &TypeRef) -> String {
        match ty {
            TypeRef::Primitive(p) => primitive_ts_type(*p).to_string(),
            // Resolving is what records the name for the header; the emitted
            // name is the same either way (the binding, aliased or not),
            // because an alias is this schema's own name for it.
            TypeRef::Named(name) => {
                self.uses.resolve(name);
                name.clone()
            }
            // TypeScript has no fixed-length array short of a tuple, so `T[N]`
            // is `T[]` too. A union element needs its parentheses.
            TypeRef::Array { element, .. } => match **element {
                TypeRef::Union(_) => format!("({})[]", self.ts_type(element)),
                _ => format!("{}[]", self.ts_type(element)),
            },
            TypeRef::Union(members) => {
                members.iter().map(|m| self.ts_type(m)).collect::<Vec<_>>().join(" | ")
            }
            TypeRef::Unit => "void".to_string(),
        }
    }
}

/// The namespace an `import type` specifier should point at, relative to the
/// importing schema, as a module specifier NodeNext accepts (`.js`, and
/// explicitly relative).
///
/// Both namespaces are rooted at the same directory — `src/` in `lib` mode,
/// and in `code` mode whatever the consumer's `layout` renders, where
/// `{{namespace}}` is the only component that varies between two schemas of
/// one target. So the offset between them is the namespaces' own, and a
/// specifier computed here survives any layout that keeps a namespace in the
/// file-name position (every layout the CLI ships).
fn relative_specifier(from: &str, to: &str) -> String {
    let from_segments: Vec<&str> = from.split('/').collect();
    // The importing *file*'s directory, not the file itself.
    let from_dir = &from_segments[..from_segments.len() - 1];
    let to_segments: Vec<&str> = to.split('/').collect();

    let shared = from_dir
        .iter()
        .zip(to_segments.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let mut s = String::new();
    for _ in shared..from_dir.len() {
        s.push_str("../");
    }
    if s.is_empty() {
        s.push_str("./");
    }
    s.push_str(&to_segments[shared..].join("/"));
    s.push_str(".js");
    s
}

/// A primitive's `Layout` name: the IDL's own (`s32`, not `i32`).
fn primitive_layout(p: PrimitiveType) -> &'static str {
    match p {
        PrimitiveType::S8 => "s8",
        PrimitiveType::S16 => "s16",
        PrimitiveType::S32 => "s32",
        PrimitiveType::S64 => "s64",
        PrimitiveType::S128 => "s128",
        PrimitiveType::U8 => "u8",
        PrimitiveType::U16 => "u16",
        PrimitiveType::U32 => "u32",
        PrimitiveType::U64 => "u64",
        PrimitiveType::U128 => "u128",
        PrimitiveType::F32 => "f32",
        PrimitiveType::F64 => "f64",
        PrimitiveType::Bool => "bool",
        PrimitiveType::String => "string",
    }
}

/// The TypeScript type for an IDL primitive.
fn primitive_ts_type(p: PrimitiveType) -> &'static str {
    match p {
        PrimitiveType::String => "string",
        PrimitiveType::Bool => "boolean",
        // 64- and 128-bit integers overflow `number`'s 2^53 exact range.
        p if is_wide(p) => "bigint",
        // TypeScript has one plain numeric type; every other width maps to it.
        _ => "number",
    }
}

/// Whether `p` is a `bigint` in TypeScript: an integer `number` can't hold
/// exactly.
fn is_wide(p: PrimitiveType) -> bool {
    matches!(
        p,
        PrimitiveType::U64 | PrimitiveType::S64 | PrimitiveType::U128 | PrimitiveType::S128
    )
}
