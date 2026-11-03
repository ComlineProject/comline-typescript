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
use comline_core::schema::idl::annotations::{MethodNames, DEFAULT_HANDSHAKE, FORMAT_JSON, FRAMING_JSONRPC, HANDSHAKE_NONE};
use comline_core::schema::ir::frozen::unit::FrozenUnit;
use comline_core::schema::ir::unverified;

use eyre::Result;

use comline_codegen::connections;
use comline_codegen::collisions::{self, Derived};
use comline_codegen::modules::{NamespaceTree, TreeLayout};
use comline_codegen::naming::{camel, pascal, screaming_snake};
use comline_codegen::stdlib::{self, is_std_namespace};
use comline_codegen::symbols::{error_names, SymbolTable, UseTracker};
use comline_codegen::encodings::type_of;
use comline_codegen::validation::{Validation, Value};

use crate::ident::{ident, is_reserved, method_ident};
use comline_codegen::protocol::EncodingMapping;
use comline_codegen::{GenerateRequest, GeneratedFile, Mode, PackageMeta};

/// The request's encodings: the class each encoding maps to in
/// TypeScript, by canonical name.
type Encodings = BTreeMap<String, EncodingMapping>;

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

pub fn generate_typescript(req: &GenerateRequest) -> Result<Vec<GeneratedFile>> {
    // What this generator can't render at all is refused up front, every use
    // named, before a single file is produced.
    comline_codegen::features::refuse_unsupported("typescript", req, crate::SUPPORT)?;

    // Every encoding the package uses (its format, each protocol's framing
    // and handshake) has to be mapped to a class: an unmapped one is refused
    // here, before a file is produced, never rendered as something else.
    // MessagePack has no TypeScript mapping, but the support table has
    // already refused it.
    comline_codegen::encodings::check(req)?;
    let codec = type_of(&req.encodings, &req.wire_format);
    // JSON-RPC protocols sharing a connection whose bare method names one
    // side couldn't tell apart.
    connections::check(&req.schemas)?;
    let external_std = req.external_std;

    // With `external_std`, std's schemas aren't this package's to emit - it
    // references `@comline/std` for them instead.
    //
    // Only *emission* is narrowed; `&req.schemas` stays the list every
    // reference is resolved against. `stdlib::split` carries that
    // distinction, and the "declare the dependency only if std was actually
    // there" subtlety with it.
    let std = stdlib::split(&req.schemas, external_std);
    let emitted = std.emitted.as_ref();

    // Every schema file names the range its output is for: the declared
    // version up, as far as it has been verified.
    let header = format!(
        "// Generated by Comline\n// For TypeScript {} or later; verified up to {}.\n",
        req.target.version,
        crate::VERSIONS.verified_up_to
    );

    // Before emitting anything: a name this generator is about to invent may
    // already mean something in the schema. The `{name}Error` suffix is the
    // easy one to hit - `error Foo` becomes `class FooError`, which collides
    // with a declared `struct FooError`. Checked for every schema first, so a
    // collision in the last one does not arrive after the earlier files are
    // already written.
    for (namespace, units) in emitted {
        collisions::check(namespace, units, derived_names(units, &req.schemas))?;
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
                let source = schema_source(&header, namespace, units, req, external_std);
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
                schema_source(&header, namespace, units, req, external_std)
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
            let layouts_only = [
                format!("import type {{ Layout }} from \"{RUNTIME_PACKAGE}\";"),
                format!("import type {{ Layout as $Layout }} from \"{RUNTIME_PACKAGE}\";"),
            ];
            let imports_runtime = |f: &GeneratedFile| {
                layouts_only
                    .iter()
                    .fold(f.contents.clone(), |contents, line| contents.replace(line, ""))
                    .contains(&format!("from \"{RUNTIME_PACKAGE}\""))
            };
            let runtime = if sources.iter().any(imports_runtime) {
                RuntimeDep::Required
            } else if sources.iter().any(|f| layouts_only.iter().any(|line| f.contents.contains(line))) {
                RuntimeDep::Peer
            } else {
                RuntimeDep::None
            };

            // Each mapped encoding's package a file imports a class from,
            // beside the runtime and std, which are dependencies already.
            let mut mapped: Vec<(&str, Option<&str>)> = Vec::new();
            for mapping in req.encodings.values() {
                let Some(package) = mapping.package.as_deref() else { continue };
                let imported = sources.iter().any(|f| f.contents.contains(&format!("from \"{package}\"")));
                if imported && package != RUNTIME_PACKAGE && package != STD_PACKAGE && !mapped.iter().any(|(p, _)| *p == package) {
                    mapped.push((package, mapping.version.as_deref()));
                }
            }

            let mut files = vec![
                GeneratedFile {
                    path: PathBuf::from("package.json"),
                    contents: package_json(&req.package, &req.target.version, runtime, std.needs_std_dependency, &mapped),
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
fn package_json(
    pkg: &PackageMeta,
    lang_version: &str,
    runtime: RuntimeDep,
    needs_std_dep: bool,
    mapped: &[(&str, Option<&str>)],
) -> String {
    let name = pkg.name.to_lowercase();
    let mut entries: Vec<String> = Vec::new();
    if runtime == RuntimeDep::Required {
        entries.push(format!("    \"{RUNTIME_PACKAGE}\": \"{RUNTIME_VERSION}\""));
    }
    if needs_std_dep {
        entries.push(format!("    \"{STD_PACKAGE}\": \"{STD_VERSION}\""));
    }
    // An encoding's implementation: the package a mapping names, at the
    // version it asks for (any, if it asks for none).
    for (package, version) in mapped {
        entries.push(format!("    \"{package}\": \"{}\"", version.unwrap_or("*")));
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
        // `struct class` is `class_` in TypeScript, which a declared `class_`
        // would collide with.
        let name = match unit {
            FrozenUnit::Struct { name, .. }
            | FrozenUnit::Enum { name, .. }
            | FrozenUnit::TypeAlias { name, .. }
            | FrozenUnit::Error { name, imported_from: None, .. }
            | FrozenUnit::Constant { name, .. }
            | FrozenUnit::Protocol { name, .. } => Some(name),
            _ => None,
        };
        if let Some(name) = name.filter(|name| is_reserved(name)) {
            derived.push(Derived::new(ident(name), format!("`{name}`, a word TypeScript reserves")));
        }
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
    req: &GenerateRequest,
    external_std: bool,
) -> String {
    let schemas = &req.schemas;
    let encodings = &req.encodings;
    let types = TypeMapper::new(units, schemas, external_std);
    let errors = error_names(units);

    // The declarations, built before the headers: rendering them is what
    // tells `types` which imported names this file actually refers to, and
    // whether it declares a `Layout`.
    let mut decls = String::new();
    for unit in units {
        match unit {
            FrozenUnit::Struct { name, fields, parameters, .. } => {
                decls.push_str(&interface(name, fields, &types));
                decls.push_str(&struct_layout(name, fields, max_depth(parameters), &types));
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
                decls.push_str(&branded_factory(name, target, &types));
            }
            FrozenUnit::Constant {
                docstring,
                name,
                ty,
                value,
                ..
            } => {
                decls.push_str(&constant(docstring.as_deref(), name, ty, value.as_ref(), namespace, schemas));
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
                    &framing_choice(parameters, encodings, &types),
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
                Some(framing_choice(parameters, encodings, &types))
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
    let mut external: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut ir_hash = String::new();
    if has_protocol {
        let mut values = Vec::new();
        if has_lockstep {
            values.extend(["Client", "Server"]);
        }
        values.extend(["RuntimeError", "resolveKind"]);
        values.extend(types.checks());
        // Each lockstep framing's class, then the package's codec, and JSON
        // for a lockstep JSON-RPC protocol: the runtime's from the runtime
        // import, any other package's from an import of its own.
        for pick in picks.iter().filter(|p| !p.jsonrpc).chain(picks.iter().filter(|p| p.jsonrpc)) {
            import_class(encodings, &pick.name, &mut values, &mut external);
        }
        if formatted {
            import_class(encodings, &req.wire_format, &mut values, &mut external);
        }
        if picks.iter().any(|p| p.jsonrpc) {
            import_class(encodings, FORMAT_JSON, &mut values, &mut external);
        }
        // A lockstep protocol's own handshake, which its helpers construct.
        for (name, _) in picks.iter().filter_map(|p| p.handshake.as_ref()) {
            import_class(encodings, name, &mut values, &mut external);
        }
        let any_none = units.iter().any(|u| {
            matches!(u, FrozenUnit::Protocol { parameters, .. } if no_handshake(parameters) && !on_connection(parameters))
        });
        if any_none {
            values.push("NoHandshake");
        }
        runtime_import.push_str("import {\n");
        for v in values {
            runtime_import.push_str(&format!("    {},\n", types.binding(v)));
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
            runtime_import.push_str(&format!("    type {},\n", types.binding(t)));
        }
        runtime_import.push_str("} from \"@comline/runtime\";\n\n");
        runtime_import.push_str(&external_imports(&external, |name| types.binding(name)));

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
                 export const Format: {codec_t} = new {codec}();\n\n",
                codec_t = types.rt("Codec"),
                codec = class_ref(encodings, &req.wire_format, &types),
            ));
        }
    } else {
        // A branded alias's factory calls a runtime check, a value import;
        // a `Layout` is only a type.
        let checks = types.checks();
        if !checks.is_empty() {
            let mut names: Vec<String> = checks.iter().map(|c| types.binding(c)).collect();
            if types.declares_layouts() {
                names.push(format!("type {}", types.binding("Layout")));
            }
            runtime_import.push_str(&format!("import {{ {} }} from \"{RUNTIME_PACKAGE}\";\n\n", names.join(", ")));
        } else if types.declares_layouts() {
            runtime_import.push_str(&format!("import type {{ {} }} from \"{RUNTIME_PACKAGE}\";\n\n", types.binding("Layout")));
        }
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
    if let Some(bound) = string_bound(target) {
        // A bounded string, named: a branded `string` (char-strings.md,
        // level 2), so a value of the type comes only from its checked
        // factory or from a decoder, which checks it too.
        let name = ident(name);
        return format!(
            "/** A string of {}: make one with `{name}.from`. */\n\
             export type {name} = string & {{ readonly __brand: \"{name}\" }};\n\n",
            bound.describe()
        );
    }
    format!("export type {} = {};\n\n", ident(name), types.ts_type(target))
}

/// What a bounded string (`char[max N]`, `char[N]`) allows.
#[derive(Clone, Copy)]
enum StringBound {
    Max(u64),
    Exactly(u64),
}

impl StringBound {
    fn describe(self) -> String {
        match self {
            StringBound::Max(n) => format!("at most {n} {}", if n == 1 { "character" } else { "characters" }),
            StringBound::Exactly(n) => format!("exactly {n} {}", if n == 1 { "character" } else { "characters" }),
        }
    }
}

/// The bound of `ty` if it's a bounded string: an array of `char` with a
/// maximum or a length.
fn string_bound(ty: &TypeRef) -> Option<StringBound> {
    match ty {
        TypeRef::Array { element, length, max } if **element == TypeRef::Primitive(PrimitiveType::Char) => {
            match (length, max) {
                (Some(n), _) => Some(StringBound::Exactly(*n)),
                (None, Some(n)) => Some(StringBound::Max(*n)),
                (None, None) => None,
            }
        }
        _ => None,
    }
}

/// The checked factory beside a branded alias: `Name.from(s)` gives `s` as a
/// `Name`, or throws the runtime's `boundExceeded` (or `serialization`, for
/// too few characters in a `char[N]`) when it isn't one.
fn branded_factory(name: &str, target: &TypeRef, types: &TypeMapper) -> String {
    let Some(bound) = string_bound(target) else {
        return String::new();
    };
    let name = ident(name);
    let check = match bound {
        StringBound::Max(n) => format!("{}(value, {n})", types.check("checkChars")),
        StringBound::Exactly(n) => format!("{}(value, {n})", types.check("checkCharsExact")),
    };
    format!(
        "export const {name} = {{\n\
        \x20   /** `value` as a `{name}`; throws a `RuntimeError` unless it holds {}. */\n\
        \x20   from(value: string): {name} {{\n\
        \x20       {check};\n\
        \x20       return value as {name};\n\
        \x20   }},\n\
        }};\n\n",
        bound.describe()
    )
}

/// A struct's `@max_depth`, if it has one: how deep a type that contains
/// itself may nest.
fn max_depth(parameters: &[FrozenUnit]) -> Option<i64> {
    parameters.iter().find_map(|p| match p {
        FrozenUnit::Property { name, value: comline_core::schema::ir::frozen::unit::ConfigValue::Integer(d) }
            if name == "max_depth" =>
        {
            Some(*d)
        }
        _ => None,
    })
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
    namespace: &str,
    schemas: &[(String, Vec<FrozenUnit>)],
) -> String {
    // Validation refuses a constant that isn't a primitive with a value of
    // its type, so neither early return is reachable from a real build.
    let Some(primitive) = ty.as_primitive() else {
        return String::new();
    };
    // A constant can name another, or an integer type's bound (core#168):
    // it's emitted with the value that comes to, as a literal is.
    let Some(Ok(value)) = value.map(|literal| Validation::new(schemas).value(namespace, literal)) else {
        return String::new();
    };
    let value = match (primitive, value) {
        (PrimitiveType::String, Value::String(text)) => format!("{text:?}"),
        // `bigint` is a distinct type from `number`, and `7` is not one.
        (p, Value::Integer(i)) if is_wide(p) => format!("{i}n"),
        (p, Value::Integer(i)) if p.is_integer() || p.is_float() => i.to_string(),
        (PrimitiveType::Bool, Value::Bool(b)) => b.to_string(),
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
    s.push_str(&format!("export const {} = {value};\n\n", ident(name)));
    s
}

fn interface(name: &str, fields: &[FrozenUnit], types: &TypeMapper) -> String {
    let mut s = format!("export interface {} {{\n", ident(name));
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

/// A struct's `Layout`: its fields', under its depth limit if it has one.
fn struct_layout(name: &str, fields: &[FrozenUnit], depth: Option<i64>, types: &TypeMapper) -> String {
    let Some(depth) = depth else {
        return fields_layout(name, fields, types);
    };
    types.layout_decl(name, &format!("{{ depth: {depth}, of: {} }}", fields_struct(fields, types)))
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

fn fields_struct(fields: &[FrozenUnit], types: &TypeMapper) -> String {
    let members: Vec<(&str, &TypeRef, bool)> = fields
        .iter()
        .filter_map(|f| match f {
            FrozenUnit::Field { name, ty, optional, .. } => Some((name.as_str(), ty, *optional)),
            _ => None,
        })
        .collect();
    args_struct(&members, types)
}

fn args_layout(name: &str, fields: &[(&str, &TypeRef, bool)], types: &TypeMapper) -> String {
    types.layout_decl(name, &args_struct(fields, types))
}

fn args_struct(fields: &[(&str, &TypeRef, bool)], types: &TypeMapper) -> String {
    let members: Vec<String> = fields
        .iter()
        .map(|(field, ty, optional)| {
            let layout = types.layout(ty, true);
            let layout = if *optional { format!("{{ option: {layout} }}") } else { layout };
            format!("[\"{field}\", {layout}]")
        })
        .collect();
    format!("{{ struct: [{}] }}", members.join(", "))
}

/// The throwable for an `error`: a provider `throw`s `new <Name>Error(data)`;
/// the dispatcher catches it and the client re-raises it, both keyed by
/// `<Name>Error.ordinal`.
fn error_class(name: &str, ordinal: u16) -> String {
    let ty = ident(name);
    format!(
        "export class {name}Error extends Error {{\n\
        \x20   static readonly ordinal = {ordinal};\n\
        \x20   readonly data: {ty};\n\
        \x20   constructor(data: {ty}) {{\n\
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
    let name = ident(name);
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
    /// The encoding's canonical name: `datagram`, `jsonrpc`, or a
    /// namespaced one.
    name: String,
    /// The class it maps to: `DatagramFraming`, `JsonRpcFraming`.
    ctor: String,
    jsonrpc: bool,
    /// What its helpers encode with when not told: JSON's codec for a
    /// JSON-RPC protocol, which carries JSON whatever the package's format
    /// is, the package's `Format` otherwise.
    codec: String,
    /// The protocol's handshake when it's neither `comline@1` nor `none`:
    /// its canonical name and the class it maps to. Those two keep their own
    /// paths (the runtime's default, and `NoHandshake`), so what's generated
    /// for them doesn't change.
    handshake: Option<(String, String)>,
}

/// A protocol's framing: its `@framing`, which core has filled in from the
/// package's `wire.framing`, else `datagram@2`, mapped to the class the
/// request's encodings name (`encodings::check` has vouched for it).
fn framing_choice(parameters: &[FrozenUnit], encodings: &Encodings, types: &TypeMapper) -> FramingChoice {
    let name = connections::framing_name(parameters);
    let jsonrpc = name == FRAMING_JSONRPC;
    FramingChoice {
        ctor: class_ref(encodings, &name, types),
        codec: if jsonrpc { format!("new {}()", class_ref(encodings, FORMAT_JSON, types)) } else { "Format".to_string() },
        jsonrpc,
        handshake: custom_handshake(parameters, encodings)
            .map(|(handshake, _)| { let class = class_ref(encodings, &handshake, types); (handshake, class) }),
        name,
    }
}

/// The class encoding `name` maps to, as this file refers to it: under the
/// alias it's imported as when a schema name here takes its name.
fn class_ref(encodings: &Encodings, name: &str, types: &TypeMapper) -> String {
    let class = type_of(encodings, name);
    match encodings.get(name).and_then(|mapping| mapping.package.as_ref()) {
        Some(_) => types.rt(class),
        None => class.to_string(),
    }
}

/// A protocol's handshake, canonical, and the class it maps to, when it's
/// neither `comline@1` nor `none`.
fn custom_handshake(parameters: &[FrozenUnit], encodings: &Encodings) -> Option<(String, String)> {
    let name = connections::handshake_name(parameters);
    (name != DEFAULT_HANDSHAKE && name != HANDSHAKE_NONE).then(|| {
        let class = type_of(encodings, &name).to_string();
        (name, class)
    })
}

/// Import the class encoding `name` maps to: into `runtime` (the runtime
/// import's names) when the runtime provides it, under its package in
/// `external` when another package does. A mapping naming no package
/// imports nothing: the class is in scope already. Each class once.
fn import_class<'a>(
    encodings: &'a Encodings,
    name: &str,
    runtime: &mut Vec<&'a str>,
    external: &mut BTreeMap<&'a str, Vec<&'a str>>,
) {
    let Some(mapping) = encodings.get(name) else { return };
    let class = mapping.type_path.as_str();
    let into = match mapping.package.as_deref() {
        Some(RUNTIME_PACKAGE) => runtime,
        Some(package) => external.entry(package).or_default(),
        None => return,
    };
    if !into.contains(&class) {
        into.push(class);
    }
}

/// One import per package other than the runtime that a mapped encoding's
/// class comes from, in package order. Empty when there's none, as there is
/// for the official encodings.
fn external_imports(external: &BTreeMap<&str, Vec<&str>>, binding: impl Fn(&str) -> String) -> String {
    let mut s = String::new();
    for (package, classes) in external {
        let classes: Vec<String> = classes.iter().map(|class| binding(class)).collect();
        s.push_str(&format!("import {{ {} }} from \"{package}\";\n", classes.join(", ")));
    }
    if !s.is_empty() {
        s.push('\n');
    }
    s
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

// ── the package's connection ───────────────────────────────────────────────

/// The package module's file, beside the schemas: `connection.ts`.
const PACKAGE_MODULE: &str = "connection";

/// The package's one connection, set up in one call: `Services` (what the
/// accepting side provides), `ClientServices` (what the dialling side does),
/// and `accept` / `serve` / `connect`. `None` when no protocol this package
/// emits is on a connection, or when its protocols don't share one
/// (`comline generate` says why).
fn package_module(header: &str, req: &GenerateRequest, emitted: &[(String, Vec<FrozenUnit>)], codec: &str) -> Option<String> {
    let package = connections::package_connection(&req.schemas).ok()??;
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

    let encodings = &req.encodings;
    let mut values = vec!["Connection"];
    let mut external: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    // JSON-RPC carries JSON whatever the package's format is.
    let connection_codec =
        if jsonrpc { format!("new {}()", type_of(encodings, FORMAT_JSON)) } else { "Format".to_string() };
    if jsonrpc {
        import_class(encodings, FORMAT_JSON, &mut values, &mut external);
        values.push("JsonRpcConnectionFraming");
    }
    import_class(encodings, &req.wire_format, &mut values, &mut external);
    if unverified {
        values.push("NoHandshake");
    }
    // A handshake that's neither `comline@1` nor `none` is passed in; those
    // two keep the arguments they always had.
    let custom = (package.handshake != DEFAULT_HANDSHAKE && !unverified).then(|| type_of(encodings, &package.handshake));
    if custom.is_some() {
        import_class(encodings, &package.handshake, &mut values, &mut external);
    }
    let mut s = format!("{header}\nimport {{\n");
    for v in &values {
        s.push_str(&format!("    {v},\n"));
    }
    s.push_str("    type Codec,\n    type Transport,\n} from \"@comline/runtime\";\n");
    s.push_str(external_imports(&external, str::to_string).trim_end_matches('\n'));
    if !external.is_empty() {
        s.push('\n');
    }
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
        connections::connection_ir_hash(&req.schemas)
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
            s.push_str(&format!("    {}: {}.{};\n", camel(&p.field), module(&p.namespace), ident(&p.name)));
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

    let framing_arg =
        if jsonrpc { ", new JsonRpcConnectionFraming()" } else if unverified || custom.is_some() { ", undefined" } else { "" };
    let handshake_arg = match custom {
        Some(class) => format!(", new {class}()"),
        None if unverified => ", new NoHandshake()".to_string(),
        None => String::new(),
    };
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
    /// The method's identifier ([`method_ident`]).
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
        // The request carries no encoding declarations, so this sees the
        // official ones only: the handshake's cause, as the IR records it.
        unverified::cause(parameters, &unverified::Encodings::default())
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
    // The provider interface's identifier; the classes and helpers named
    // after the protocol (`<Proto>Client`) never need escaping.
    let proto_ty = ident(proto);
    // The runtime's names and the globals this code uses, as this file
    // refers to them: aliased where a schema name takes one.
    let [kind_t, codec_t, reply_t, peer_t, dispatch_t, connection_t, transport_t, framing_t, client_t, server_t] =
        ["Kind", "Codec", "Reply", "Peer", "Dispatch", "Connection", "Transport", "Framing", "Client", "Server"]
            .map(|name| types.rt(name));
    let [runtime_error, resolve_kind, no_handshake_t] =
        ["RuntimeError", "resolveKind", "NoHandshake"].map(|name| types.rt(name));
    let [promise, bytes] = ["Promise", "Uint8Array"].map(|name| types.global(name));
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
                    name: method_ident(name),
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
        s.push_str(&format!("export interface {} {{}}\n\n", ident(proto)));
        return s;
    }

    // 2. the provider interface — every call is async
    s.push_str(&format!("export interface {} {{\n", ident(proto)));
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
            params.push(format!("peer: {peer_t}"));
        }
        params.extend(f.params_ty.as_ref().map(|t| format!("params: {t}")));
        s.push_str(&format!("    {}({}): {promise}<{}>;\n", f.name, params.join(", "), f.ret));
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
        (format!(", new {no_handshake_t}()"), "        // No handshake: `@handshake = \"none\"`.\n")
    } else if let Some((_, class)) = &framing.handshake {
        (format!(", new {class}()"), "")
    } else {
        (String::new(), "")
    };

    // 4. the dispatcher
    s.push_str(&doc);
    s.push_str(&format!(
        "export class {proto}Dispatcher implements {dispatch_t} {{\n"
    ));
    if let Some(number) = number {
        s.push_str(&format!(
            "    /** This protocol's number on a connection. */\n\
            \x20   static readonly PROTOCOL = {number};\n\n"
        ));
    }
    s.push_str(&format!(
        "    private readonly impl: {proto_ty};\n\n\
        \x20   constructor(impl: {proto_ty}) {{\n\
        \x20       this.impl = impl;\n\
        \x20   }}\n\n\
        \x20   calls(): readonly string[] {{\n\
        \x20       return {calls_const};\n\
        \x20   }}\n\n"
    ));
    if number.is_some() {
        // Its handlers take the peer, which only a connection has.
        s.push_str(&format!(
            "    /** Only served on a connection, whose handlers are given the peer: anywhere else the caller hears a fault. */\n\
            \x20   async dispatch(_call: {kind_t}, _params: {bytes}, _codec: {codec_t}, reply: {reply_t}): {promise}<void> {{\n\
            \x20       reply.fault();\n\
            \x20   }}\n\n\
            \x20   async dispatchWith(call: {kind_t}, params: {bytes}, reply: {reply_t}, peer: {peer_t}): {promise}<void> {{\n\
            \x20       const codec = peer.codec;\n",
        ));
    } else {
        s.push_str(&format!(
            "    async dispatch(call: {kind_t}, params: {bytes}, codec: {codec_t}, reply: {reply_t}): {promise}<void> {{\n",
        ));
    }
    s.push_str(&format!("        switch ({resolve_kind}(call, {calls_const})) {{\n"));
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
    s.push_str(&format!(
        "            default:\n\
        \x20               throw {runtime_error}.unknownCall();\n\
        \x20       }}\n\
        \x20   }}\n",
    ));
    if number.is_some() {
        let open = match (framing.jsonrpc, no_handshake(parameters), &framing.handshake) {
            (false, false, Some((_, class))) => {
                format!("`Connection.accept(transport, Format, CONNECTION_IR_HASH, undefined, new {class}())`")
            }
            (true, false, Some((_, class))) => format!(
                "`Connection.accept(transport, new JsonCodec(), CONNECTION_IR_HASH, new JsonRpcConnectionFraming(), new {class}())`"
            ),
            (false, true, _) => {
                "`Connection.accept(transport, Format, CONNECTION_IR_HASH, framing, new NoHandshake())`".to_string()
            }
            (false, false, None) => "`Connection.accept(transport, Format, CONNECTION_IR_HASH)`".to_string(),
            (true, true, _) => {
                "`Connection.accept(transport, new JsonCodec(), CONNECTION_IR_HASH, new JsonRpcConnectionFraming(), new NoHandshake())`".to_string()
            }
            (true, false, None) => {
                "`Connection.accept(transport, new JsonCodec(), CONNECTION_IR_HASH, new JsonRpcConnectionFraming())`".to_string()
            }
        };
        // The side that provides it opens: a client-provided protocol dials.
        let open = if connections::Provider::of(parameters) == connections::Provider::Client {
            open.replace("Connection.accept", "Connection.connect")
        } else {
            open
        };
        s.push_str(&format!(
            "\n    /** Provide this protocol on `conn`: the peer's calls to it come here. Open `conn` with {open}, or let the package's `serve` / `connect` do it. */\n\
            \x20   provideOn(conn: {connection_t}): void {{\n\
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
                \x20   private readonly peer: {peer_t};\n\n\
                \x20   constructor(peer: {peer_t}) {{\n\
                \x20       this.peer = peer;\n\
                \x20   }}\n"
            ));
            ("peer", format!("{proto}Sender.PROTOCOL, "))
        }
        None => {
            let codec = &framing.codec;
            s.push_str(&format!(
                "export class {proto}Client {{\n\
                \x20   private readonly client: {client_t};\n\n\
                \x20   constructor(client: {client_t}) {{\n\
                \x20       this.client = client;\n\
                \x20   }}\n\n\
                \x20   static async connect(transport: {transport_t}, codec: {codec_t} = {codec}, framing: {framing_t} = new {ctor}()): {promise}<{proto}Client> {{\n\
                {handshake_note}\
                \x20       return new {proto}Client(await {client_t}.connect(transport, codec, IR_HASH, framing{handshake_arg}));\n\
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
                "    async {}({sig_params}): {promise}<void> {{\n\
                 \x20       await this.{field}.notify({call_prefix}{{ id: {i}, name: \"{}\" }}, {arg}, {{ layout: {layout} }});\n\
                 \x20   }}\n",
                f.name, f.method
            ));
            continue;
        }
        s.push_str(&format!(
            "    async {}({sig_params}): {promise}<{}> {{\n\
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
        s.push_str(&format!("        if (\"fault\" in env) throw {runtime_error}.provider();\n"));
        if f.throws.is_empty() {
            s.push_str(&format!("        throw {runtime_error}.remote(env.err.id);\n"));
        } else {
            s.push_str("        switch (env.err.id) {\n");
            for (_, err) in &f.throws {
                let err_ty = ident(err);
                s.push_str(&format!(
                    "            case {err}Error.ordinal:\n\
                     \x20               throw new {err}Error(this.{field}.codec.decode<{err_ty}>(env.err.body, {err}Layout));\n"
                ));
            }
            s.push_str("            default:\n");
            s.push_str(&format!("                throw {runtime_error}.remote(env.err.id);\n"));
            s.push_str("        }\n");
        }
        s.push_str("    }\n");
    }
    s.push_str("}\n\n");

    // 6. the serve helper, for the lockstep `Server`
    if number.is_none() {
        s.push_str(&format!(
            "export function serve{proto}(impl: {proto_ty}, transport: {transport_t}, codec: {codec_t} = {codec}, framing: {framing_t} = new {ctor}()): {promise}<void> {{\n\
            {handshake_note}\
            \x20   return new {server_t}(new {proto}Dispatcher(impl), codec, framing).serve(transport, IR_HASH{handshake_arg});\n\
            }}\n\n",
            ctor = framing.ctor,
            codec = framing.codec,
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
    /// The runtime's bound checks a branded alias's factory calls
    /// (`checkChars`, `checkCharsExact`), imported as values.
    checks: RefCell<BTreeSet<&'static str>>,
    /// The identifiers this file's schema declares or imports from another
    /// schema. A name the runtime exports, or a global the generated code
    /// uses, is referred to another way where one of these takes it
    /// (comline-typescript#116).
    taken: BTreeSet<String>,
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
        let taken = units
            .iter()
            .filter_map(|unit| match unit {
                FrozenUnit::Struct { name, .. }
                | FrozenUnit::Enum { name, .. }
                | FrozenUnit::TypeAlias { name, .. }
                | FrozenUnit::Error { name, imported_from: None, .. }
                | FrozenUnit::Constant { name, .. }
                | FrozenUnit::Protocol { name, .. } => Some(name.as_str()),
                FrozenUnit::Import(path, alias, _) => {
                    Some(alias.as_deref().unwrap_or_else(|| path.rsplit("::").next().unwrap_or(path)))
                }
                _ => None,
            })
            .map(ident)
            .collect();
        Self {
            uses: UseTracker::new(table),
            external_std,
            layouts: RefCell::new(BTreeSet::new()),
            declares_layouts: Cell::new(false),
            checks: RefCell::new(BTreeSet::new()),
            taken,
        }
    }

    /// A name this file imports from a package (`Layout`, `Connection`,
    /// `DatagramFraming`), as the file refers to it: `$Layout` where a schema
    /// name takes `Layout`, which no schema name can be (an IDL name has no
    /// `$`), otherwise itself.
    fn rt(&self, name: &str) -> String {
        if self.taken.contains(name) {
            format!("${name}")
        } else {
            name.to_string()
        }
    }

    /// How `name` is bound in an import from a package: `Layout as $Layout`
    /// where [`rt`](Self::rt) aliases it.
    fn binding(&self, name: &str) -> String {
        match self.rt(name) {
            alias if alias != name => format!("{name} as {alias}"),
            _ => name.to_string(),
        }
    }

    /// A global the generated code uses (`Promise`, `Uint8Array`), through
    /// `globalThis` where a schema name takes it.
    fn global(&self, name: &str) -> String {
        if self.taken.contains(name) {
            format!("globalThis.{name}")
        } else {
            name.to_string()
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
            // An array of `char` is a string, sent as text: bounded, or of
            // an exact length.
            TypeRef::Array { element, length, max } if **element == TypeRef::Primitive(PrimitiveType::Char) => {
                match (length, max) {
                    (Some(n), _) => format!("{{ chars: {{ length: {n} }} }}"),
                    (None, Some(n)) => format!("{{ chars: {{ max: {n} }} }}"),
                    (None, None) => "\"string\"".to_string(),
                }
            }
            TypeRef::Array { element, length: None, max: Some(n) } => {
                format!("{{ array: {}, max: {n} }}", self.layout(element, lazy))
            }
            TypeRef::Array { element, length: None, .. } => format!("{{ array: {} }}", self.layout(element, lazy)),
            TypeRef::Array { element, length: Some(n), .. } => {
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
        format!("export const {name}Layout: {} = {layout};\n\n", self.rt("Layout"))
    }

    fn declares_layouts(&self) -> bool {
        self.declares_layouts.get()
    }

    /// A bound check from the runtime, as this file refers to it, recorded
    /// for the import.
    fn check(&self, name: &'static str) -> String {
        self.checks.borrow_mut().insert(name);
        self.rt(name)
    }

    /// The runtime checks this file calls, sorted.
    fn checks(&self) -> Vec<&'static str> {
        self.checks.borrow().iter().copied().collect()
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
            // A type is imported by its identifier; its `Layout`'s name is
            // never a reserved word.
            let named = |(declared, bound): &(String, String), suffix: &str| {
                let (declared, bound) = match suffix {
                    "" => (ident(declared), ident(bound)),
                    _ => (format!("{declared}{suffix}"), format!("{bound}{suffix}")),
                };
                if declared == bound {
                    declared
                } else {
                    format!("{declared} as {bound}")
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
                ident(name)
            }
            // TypeScript has no fixed-length array short of a tuple, so `T[N]`
            // is `T[]` too. A union element needs its parentheses.
            TypeRef::Array { element, .. } => match **element {
                // An array of `char` is a string.
                TypeRef::Primitive(PrimitiveType::Char) => "string".to_string(),
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
        PrimitiveType::Char => "char",
    }
}

/// The TypeScript type for an IDL primitive.
fn primitive_ts_type(p: PrimitiveType) -> &'static str {
    match p {
        // A single `char` is a string of exactly one code point, checked by
        // the codecs: TypeScript has no character type.
        PrimitiveType::String | PrimitiveType::Char => "string",
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
