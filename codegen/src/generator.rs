//! TypeScript generation: frozen IR -> `.ts` source.
//!
//! Per schema file:
//! - `struct`   -> `export interface`
//! - `error`    -> `export interface` (the wire payload) + `export class
//!   <Name>Error` (the throwable, carrying `.data` and a static `.ordinal`)
//! - `enum`     -> `export enum` with string values (JSON interop)
//! - `protocol` -> the full RPC shape against `@comline/runtime`: an `IR_HASH`
//!   const, a `<Proto><Fn>Params` interface per function, a `<Proto>` provider
//!   interface of `Promise`-returning methods, a `<PROTO>_CALLS` table, a
//!   `<Proto>Dispatcher` (`implements Dispatch`), a `<Proto>Client`, and a
//!   `serve<Proto>` helper. Framing follows `@framing` / the package default.
//!
//! A type another schema declares is imported from that schema by relative
//! specifier (`import type { Greeting } from "./types.js"`), so the output
//! compiles in both modes. Which name comes from where is
//! [`comline_codegen::symbols`]'s answer, not this crate's. With `external_std`,
//! `std`'s own schemas are not emitted at all and their types come from
//! [`STD_PACKAGE`] instead.
//!
//! `code` mode emits bare `<namespace>.ts`; `lib` mode adds a `package.json`
//! (declaring `@comline/runtime` and `@comline/std` as needed), a
//! `tsconfig.json`, and an `index.ts` barrel per namespace level
//! ([`NamespaceTree`], laid out by [`TsLayout`]). See design/generation.md.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use comline_core::schema::ir::compiler::interpreted::kind_search::{KindValue, Primitive};
use comline_core::schema::ir::frozen::schema_ir_hash;
use comline_core::schema::ir::frozen::unit::FrozenUnit;

use eyre::Result;

use comline_codegen::modules::{NamespaceTree, TreeLayout};
use comline_codegen::naming::{pascal, screaming_snake};
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
    let default_framing = req.default_framing.as_deref();
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

    match req.mode {
        Mode::Code => Ok(emitted
            .iter()
            .map(|(namespace, units)| {
                let source =
                    schema_source(namespace, units, req.schemas, default_framing, external_std);
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
            .collect()),

        Mode::Lib => {
            let tree = NamespaceTree::build(emitted, &TsLayout)?;

            let has_protocol = emitted.iter().any(|(_, units)| {
                units
                    .iter()
                    .any(|u| matches!(u, FrozenUnit::Protocol { .. }))
            });

            let mut files = vec![
                GeneratedFile {
                    path: PathBuf::from("package.json"),
                    contents: package_json(&req.package, has_protocol, std.needs_std_dependency),
                },
                GeneratedFile {
                    path: PathBuf::from("tsconfig.json"),
                    contents: TSCONFIG.to_string(),
                },
            ];
            // The render closure takes every schema in the request, not just
            // the ones in this tree: a reference resolves against all of
            // them, including an external `std` this package emits no file
            // for.
            files.extend(tree.emit("src", &TsLayout, &|namespace, units| {
                schema_source(namespace, units, req.schemas, default_framing, external_std)
            }));
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
    \x20   \"target\": \"ES2022\",\n\
    \x20   \"module\": \"NodeNext\",\n\
    \x20   \"moduleResolution\": \"NodeNext\",\n\
    \x20   \"outDir\": \"dist\",\n\
    \x20   \"rootDir\": \"src\",\n\
    \x20   \"declaration\": true,\n\
    \x20   \"strict\": true,\n\
    \x20   \"skipLibCheck\": true\n\
    \x20 },\n\
    \x20 \"include\": [\"src/**/*.ts\"]\n\
    }\n";

fn package_json(pkg: &PackageMeta, has_protocol: bool, needs_std_dep: bool) -> String {
    let name = pkg.name.to_lowercase();
    let mut entries: Vec<String> = Vec::new();
    if has_protocol {
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
fn schema_source(
    namespace: &str,
    units: &[FrozenUnit],
    schemas: &[(String, Vec<FrozenUnit>)],
    default_framing: Option<&str>,
    external_std: bool,
) -> String {
    let types = TypeMapper::new(units, schemas, external_std);
    let has_protocol = units
        .iter()
        .any(|u| matches!(u, FrozenUnit::Protocol { .. }));
    let errors = error_names(units);

    // Which framings the protocols in this file reach for.
    let picks: Vec<FramingChoice> = units
        .iter()
        .filter_map(|u| match u {
            FrozenUnit::Protocol { parameters, .. } => {
                Some(framing_choice(parameters, default_framing))
            }
            _ => None,
        })
        .collect();

    // The runtime import and the `IR_HASH` const, which only depend on the
    // schema's own shape.
    let mut runtime_import = String::new();
    let mut ir_hash = String::new();
    if has_protocol {
        let mut values = vec![
            "Client",
            "Server",
            "Handshake",
            "RuntimeError",
            "resolveKind",
        ];
        if picks.iter().any(|p| !p.jsonrpc) {
            values.push("DatagramFraming");
        }
        if picks.iter().any(|p| p.jsonrpc) {
            values.push("JsonRpcFraming");
        }
        runtime_import.push_str("import {\n");
        for v in values {
            runtime_import.push_str(&format!("    {v},\n"));
        }
        for t in ["Codec", "Dispatch", "Framing", "Kind", "Reply", "Transport"] {
            runtime_import.push_str(&format!("    type {t},\n"));
        }
        runtime_import.push_str("} from \"@comline/runtime\";\n\n");

        ir_hash.push_str(&format!(
            "/** Canonical digest of the frozen IR this file was generated from — the\n\
             *  two ends of a connection must agree on it. */\n\
             export const IR_HASH = {:#018x}n;\n\n",
            schema_ir_hash(units)
        ));
    }

    // The declarations, built before the header: rendering them is what tells
    // `types` which imported names this file actually refers to.
    let mut decls = String::new();
    for unit in units {
        match unit {
            FrozenUnit::Struct { name, fields, .. } => {
                decls.push_str(&interface(name, fields, &types));
            }
            FrozenUnit::Error {
                name,
                fields,
                ordinal,
                ..
            } => {
                decls.push_str(&interface(name, fields, &types));
                decls.push_str(&error_class(name, *ordinal));
            }
            FrozenUnit::Enum { name, variants, .. } => {
                decls.push_str(&string_enum(name, variants));
            }
            FrozenUnit::TypeAlias { name, target, .. } => {
                decls.push_str(&type_alias(name, target, &types));
            }
            FrozenUnit::Constant {
                docstring,
                name,
                kind_value,
                ..
            } => {
                decls.push_str(&constant(docstring.as_deref(), name, kind_value));
            }
            FrozenUnit::Protocol {
                name,
                functions,
                parameters,
                ..
            } => {
                decls.push_str(&protocol(
                    name,
                    functions,
                    &framing_choice(parameters, default_framing),
                    &errors,
                    &types,
                ));
            }
            _ => {}
        }
    }

    // External package first, then relative imports, then the file's own
    // content - the order a hand-written module would use.
    let mut output = String::from("// Generated by Comline\n\n");
    output.push_str(&runtime_import);
    output.push_str(&types.import_header(namespace));
    output.push_str(&ir_hash);
    output.push_str(&decls);
    output
}

// ── data types ─────────────────────────────────────────────────────────────

/// `export type NAME = TARGET;` - transparent like Rust's own `type` (not a
/// newtype): `ts_type` already maps any `KindValue` to a real TS type
/// expression, named or primitive, so this is the same mapping every field
/// already goes through, just at the top level of the file instead of
/// inside an interface.
fn type_alias(name: &str, target: &KindValue, types: &TypeMapper) -> String {
    format!("export type {name} = {};\n\n", types.ts_type(target))
}

/// `const MAX_RETRIES: u8 = 5` -> `export const MAX_RETRIES = 5;`.
///
/// Declarations used to vanish here: a schema of nothing but constants
/// generated an empty file. Only safe to emit since core#92, which stopped
/// inferring the primitive from the literal - before that a `u8` constant
/// and a `u64` one were indistinguishable in the IR.
///
/// **No type annotation, deliberately.** TypeScript has no `u8`, so
/// annotating would mean writing `number` and throwing away what the
/// inferred literal type (`5`) already says more precisely. The exception is
/// a 128-bit integer, which [`primitive_ts_type`] maps to `bigint` and which
/// therefore needs the `n` suffix on the literal to *be* one.
fn constant(docstring: Option<&str>, name: &str, kind_value: &KindValue) -> String {
    let KindValue::Primitive(primitive) = kind_value else {
        // Validation refuses a constant of a named type, so this is
        // unreachable from a real build.
        return String::new();
    };
    let Some(literal) = primitive.value_str() else {
        return String::new();
    };

    let value = match primitive {
        Primitive::String(_) => format!("{literal:?}"),
        // `bigint` is a distinct type from `number`, and `7` is not one.
        Primitive::U128(_) | Primitive::S128(_) => format!("{literal}n"),
        _ => literal,
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
            kind_value,
            optional,
            ..
        } = field
        {
            let opt = if *optional { "?" } else { "" };
            s.push_str(&format!(
                "    {name}{opt}: {};\n",
                types.ts_type(kind_value)
            ));
        }
    }
    s.push_str("}\n\n");
    s
}

/// The throwable for an `error`: a provider `throw`s `new <Name>Error(data)`;
/// the dispatcher catches it and the client re-raises it, both keyed by
/// `<Name>Error.ordinal`.
fn error_class(name: &str, ordinal: u16) -> String {
    format!(
        "export class {name}Error extends Error {{\n\
        \x20   static readonly ordinal = {ordinal};\n\
        \x20   constructor(readonly data: {name}) {{\n\
        \x20       super(\"{name}\");\n\
        \x20       this.name = \"{name}Error\";\n\
        \x20   }}\n\
        }}\n\n"
    )
}

fn string_enum(name: &str, variants: &[FrozenUnit]) -> String {
    let mut s = format!("export enum {name} {{\n");
    for variant in variants {
        if let FrozenUnit::EnumVariant(kv, _) = variant {
            let v = match kv {
                KindValue::EnumVariant(n, _) | KindValue::Namespaced(n, _) => n.clone(),
                _ => "Unknown".to_string(),
            };
            s.push_str(&format!("    {v} = \"{v}\",\n"));
        }
    }
    s.push_str("}\n\n");
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
        _ => None,
    }
}

/// A protocol's framing, most specific first: its own `@framing`, then the
/// package `default_framing`, then datagram.
fn framing_choice(parameters: &[FrozenUnit], default_framing: Option<&str>) -> FramingChoice {
    annotation(parameters, "framing")
        .and_then(|name| framing_for(&name))
        .or_else(|| default_framing.and_then(framing_for))
        .unwrap_or(FramingChoice {
            ctor: "DatagramFraming",
            jsonrpc: false,
        })
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

// ── protocol ───────────────────────────────────────────────────────────────

struct FnInfo {
    name: String,
    params_ty: Option<String>,
    args: Vec<(String, String)>,
    /// The declared return type; `void` for a one-way call or a `()` return.
    ret: String,
    one_way: bool,
    /// `(ordinal, error interface name)` for each `!`. Empty for a one-way call.
    throws: Vec<(u16, String)>,
}

fn protocol(
    proto: &str,
    functions: &[FrozenUnit],
    framing: &FramingChoice,
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
                    .map(|a| (a.name.clone(), types.ts_type(&a.kind)))
                    .collect();
                let params_ty =
                    (!args.is_empty()).then(|| format!("{proto}{}Params", pascal(name)));
                let ret = match _return {
                    None | Some(KindValue::Unit) => "void".to_string(),
                    Some(kv) => types.ts_type(kv),
                };
                let throws: Vec<(u16, String)> = if one_way {
                    Vec::new()
                } else {
                    throws
                        .iter()
                        .map(|o| {
                            (
                                *o,
                                errors
                                    .get(o)
                                    .cloned()
                                    .unwrap_or_else(|| format!("UnknownError{o}")),
                            )
                        })
                        .collect()
                };
                Some(FnInfo {
                    name: name.clone(),
                    params_ty,
                    args,
                    ret,
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
        s.push_str(&format!(
            "    {}({}): Promise<{}>;\n",
            f.name,
            f.params_ty
                .as_ref()
                .map_or(String::new(), |t| format!("params: {t}")),
            f.ret
        ));
    }
    s.push_str("}\n\n");

    // 3. the call table
    let calls_const = format!("{}_CALLS", screaming_snake(proto));
    let call_names = fns
        .iter()
        .map(|f| format!("\"{}\"", f.name))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!(
        "export const {calls_const} = [{call_names}] as const;\n\n"
    ));

    // 4. the dispatcher
    s.push_str(&format!(
        "export class {proto}Dispatcher implements Dispatch {{\n\
        \x20   constructor(private readonly impl: {proto}) {{}}\n\n\
        \x20   calls(): readonly string[] {{\n\
        \x20       return {calls_const};\n\
        \x20   }}\n\n\
        \x20   async dispatch(call: Kind, params: Uint8Array, codec: Codec, reply: Reply): Promise<void> {{\n\
        \x20       switch (resolveKind(call, {calls_const})) {{\n"
    ));
    for (i, f) in fns.iter().enumerate() {
        s.push_str(&format!("            case {i}: {{\n"));
        // Emitted *inside* the `try` below, so params that will not decode are
        // handled with the same arity awareness as a handler that throws.
        let decode_line = match &f.params_ty {
            Some(ty) => format!("                    const p = codec.decode<{ty}>(params);\n"),
            None => String::new(),
        };
        let call_arg = if f.params_ty.is_some() { "p" } else { "" };
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
            s.push_str(&format!(
                "                    reply.ok(codec.encode((await this.impl.{}({call_arg})) ?? null));\n",
                f.name
            ));
            // Only bind the exception when there is a declared error to test
            // it against; an unused binding is a lint failure in the output.
            if f.throws.is_empty() {
                s.push_str("                } catch {\n");
            } else {
                s.push_str("                } catch (e) {\n");
            }
            for (_, err) in &f.throws {
                s.push_str(&format!(
                    "                    if (e instanceof {err}Error) {{ reply.err({err}Error.ordinal, codec.encode(e.data)); return; }}\n"
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
        \x20   }\n\
        }\n\n",
    );

    // 5. the client
    s.push_str(&format!(
        "export class {proto}Client {{\n\
        \x20   constructor(private readonly client: Client) {{}}\n\n\
        \x20   static async connect(transport: Transport, codec: Codec, framing: Framing = new {ctor}()): Promise<{proto}Client> {{\n\
        \x20       const hs = new Handshake({{ irHash: IR_HASH, wireFormat: codec.name, framing: framing.name }});\n\
        \x20       return new {proto}Client(await Client.connect(transport, codec, hs, framing));\n\
        \x20   }}\n",
        ctor = framing.ctor
    ));
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
        s.push('\n');
        if f.one_way {
            s.push_str(&format!(
                "    async {}({sig_params}): Promise<void> {{\n\
                 \x20       await this.client.notify({{ id: {i}, name: \"{}\" }}, {arg});\n\
                 \x20   }}\n",
                f.name, f.name
            ));
            continue;
        }
        s.push_str(&format!(
            "    async {}({sig_params}): Promise<{}> {{\n\
             \x20       const env = await this.client.call({{ id: {i}, name: \"{}\" }}, {arg});\n",
            f.name, f.ret, f.name
        ));
        if f.ret == "void" {
            s.push_str("        if (\"ok\" in env) return;\n");
        } else {
            s.push_str(&format!(
                "        if (\"ok\" in env) return this.client.codec.decode<{}>(env.ok);\n",
                f.ret
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
                     \x20               throw new {err}Error(this.client.codec.decode<{err}>(env.err.body));\n"
                ));
            }
            s.push_str("            default:\n");
            s.push_str("                throw RuntimeError.remote(env.err.id);\n");
            s.push_str("        }\n");
        }
        s.push_str("    }\n");
    }
    s.push_str("}\n\n");

    // 6. the serve helper
    s.push_str(&format!(
        "export function serve{proto}(impl: {proto}, transport: Transport, codec: Codec, framing: Framing = new {ctor}()): Promise<void> {{\n\
        \x20   const hs = new Handshake({{ irHash: IR_HASH, wireFormat: codec.name, framing: framing.name }});\n\
        \x20   return new Server(new {proto}Dispatcher(impl), codec, framing).serveHandshaked(transport, hs);\n\
        }}\n\n",
        ctor = framing.ctor
    ));

    s
}

// ── type mapping ───────────────────────────────────────────────────────────

/// Maps a `KindValue` to a TypeScript type expression, and remembers which
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
        }
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

        let mut s = String::new();
        for (module, names) in by_module {
            let list = names
                .iter()
                .map(|(declared, bound)| {
                    if declared == bound {
                        declared.clone()
                    } else {
                        format!("{declared} as {bound}")
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "import type {{ {list} }} from \"{}\";\n",
                self.specifier_for(namespace, &module)
            ));
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

    fn ts_type(&self, kind: &KindValue) -> String {
        match kind {
            KindValue::Primitive(p) => self.map_str_type(p.name()),
            KindValue::Namespaced(name, _) => self.map_str_type(name),
            KindValue::EnumVariant(name, _) => name.clone(),
            KindValue::Unit => "void".to_string(),
            _ => "unknown".to_string(),
        }
    }

    fn map_str_type(&self, s: &str) -> String {
        if let Some(inner) = s.strip_suffix("[]") {
            return format!("{}[]", self.map_str_type(inner));
        }
        if let Some(mapped) = primitive_ts_type(s) {
            return mapped;
        }
        // A named type. Resolving is what records it for the header; the
        // emitted name is the same either way (the binding, aliased or not),
        // because an alias is this schema's own name for it.
        self.uses.resolve(s);
        s.to_string()
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

/// The TypeScript type for an IDL primitive, or `None` if the name isn't one
/// (a type some schema declares).
fn primitive_ts_type(s: &str) -> Option<String> {
    let ts = match s {
        "string" | "str" => "string",
        "bool" => "boolean",
        // 128-bit integers overflow `number`'s 2^53 exact range — use `bigint`.
        "u128" | "i128" | "s128" => "bigint",
        // TypeScript has one plain numeric type; the narrower widths map to it.
        "float" | "double" | "int" | "u8" | "u16" | "u32" | "u64" | "i8" | "i16" | "i32"
        | "i64" | "s8" | "s16" | "s32" | "s64" => "number",
        _ => return None,
    };
    Some(ts.to_string())
}
