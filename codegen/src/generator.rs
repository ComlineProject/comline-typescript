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
//! compiles in both modes. See [`build_import_map`].
//!
//! `code` mode emits bare `<namespace>.ts`; `lib` mode adds a `package.json`
//! (declaring `@comline/runtime`), a `tsconfig.json`, and an `index.ts` barrel
//! per namespace level ([`NamespaceTree`]). See design/generation.md.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use comline_core::schema::ir::compiler::interpreted::kind_search::KindValue;
use comline_core::schema::ir::frozen::schema_ir_hash;
use comline_core::schema::ir::frozen::unit::FrozenUnit;

use eyre::{bail, Result};

use comline_codegen::{GenRequest, GeneratedFile, Mode, PackageMeta};

/// The npm package generated RPC code imports from. Not published yet — a
/// generated `lib` package declares this range and expects it resolvable
/// (`npm link`, a local registry, or a future publish). See
/// `ComlineProject/comline-typescript/runtime`.
const RUNTIME_PACKAGE: &str = "@comline/runtime";
const RUNTIME_VERSION: &str = "^0.1.0";

pub fn generate_typescript(req: &GenRequest) -> Result<Vec<GeneratedFile>> {
    let default_framing = req.default_framing.as_deref();

    match req.mode {
        Mode::Code => Ok(req
            .schemas
            .iter()
            .map(|(namespace, units)| GeneratedFile {
                path: PathBuf::from(format!("{namespace}.ts")),
                contents: schema_source(namespace, units, req.schemas, default_framing),
            })
            .collect()),

        Mode::Lib => {
            let tree = NamespaceTree::build(req.schemas)?;

            let has_protocol = req.schemas.iter().any(|(_, units)| {
                units
                    .iter()
                    .any(|u| matches!(u, FrozenUnit::Protocol { .. }))
            });

            let mut files = vec![
                GeneratedFile {
                    path: PathBuf::from("package.json"),
                    contents: package_json(&req.package, has_protocol),
                },
                GeneratedFile {
                    path: PathBuf::from("tsconfig.json"),
                    contents: TSCONFIG.to_string(),
                },
            ];
            tree.emit_files("src", req.schemas, default_framing, &mut files);
            Ok(files)
        }
    }
}

/// The `src/` tree `lib` mode emits: each `/`-joined namespace segment becomes
/// one directory level, and every level gets an `index.ts` re-exporting its
/// children under their own names (`export * as http from "./http.js"`). A
/// node is either a schema (leaf) or a grouping of deeper namespaces (`std`
/// grouping `std/http` and `std/validators`) — never both, since
/// `export * as std` would then have two candidates and no way to choose.
///
/// Mirroring namespaces rather than flattening every name into the package
/// root is what makes a collision between, say, your own `Request` and
/// `std/http`'s impossible: TypeScript refuses ambiguous `export *`
/// re-exports (TS2308), and `std` is implicit in every package.
///
/// Deliberately not shared with comline-rust's `ModuleTree`, which this
/// parallels: that one encodes 2021-edition `mod.rs`-free rules and a
/// reserved crate root, this one emits `index.ts` barrels and has neither.
/// One type covering both would be parameterised until it was two
/// implementations behind a single name.
struct NamespaceTree<'a> {
    schema: Option<(&'a str, &'a [FrozenUnit])>,
    // Alphabetical, not first-seen order: deterministic output (stable for
    // diffing and the CAS) matters more than mirroring schema order.
    children: BTreeMap<String, NamespaceTree<'a>>,
}

impl<'a> NamespaceTree<'a> {
    fn empty() -> Self {
        Self {
            schema: None,
            children: BTreeMap::new(),
        }
    }

    fn build(schemas: &'a [(String, Vec<FrozenUnit>)]) -> Result<Self> {
        let mut root = Self::empty();
        for (namespace, units) in schemas {
            let mut node = &mut root;
            for segment in namespace.split('/') {
                node = node
                    .children
                    .entry(segment.to_string())
                    .or_insert_with(Self::empty);
            }
            node.schema = Some((namespace.as_str(), units));
        }
        root.check_no_schema_is_also_a_namespace("")?;
        Ok(root)
    }

    fn check_no_schema_is_also_a_namespace(&self, path: &str) -> Result<()> {
        if self.schema.is_some() && !self.children.is_empty() {
            bail!(
                "typescript lib mode can't generate `{path}`: it's both a \
                 schema and a namespace of deeper schemas (e.g. `{path}/x`), \
                 so the barrel's `export * as {}` has no single module to \
                 name - rename one of them",
                path.rsplit('/').next().unwrap_or(path)
            )
        }
        for (segment, child) in &self.children {
            let child_path = if path.is_empty() {
                segment.clone()
            } else {
                format!("{path}/{segment}")
            };
            child.check_no_schema_is_also_a_namespace(&child_path)?;
        }
        Ok(())
    }

    /// `export * as <segment>` for each direct child — this node's own
    /// `index.ts`, whether that is `src/index.ts` or `src/std/index.ts`.
    fn barrel(&self) -> String {
        let mut s = String::from("// Generated by Comline\n\n");
        for (segment, child) in &self.children {
            let module = if child.schema.is_some() {
                format!("./{segment}.js")
            } else {
                format!("./{segment}/index.js")
            };
            s.push_str(&format!("export * as {segment} from \"{module}\";\n"));
        }
        s
    }

    /// This node's `index.ts` and everything below it, under `dir`
    /// (`"src"` for the root).
    fn emit_files(
        &self,
        dir: &str,
        schemas: &'a [(String, Vec<FrozenUnit>)],
        default_framing: Option<&str>,
        files: &mut Vec<GeneratedFile>,
    ) {
        files.push(GeneratedFile {
            path: PathBuf::from(format!("{dir}/index.ts")),
            contents: self.barrel(),
        });
        for (segment, child) in &self.children {
            match child.schema {
                Some((namespace, units)) => files.push(GeneratedFile {
                    path: PathBuf::from(format!("{dir}/{segment}.ts")),
                    contents: schema_source(namespace, units, schemas, default_framing),
                }),
                None => {
                    child.emit_files(&format!("{dir}/{segment}"), schemas, default_framing, files)
                }
            }
        }
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

fn package_json(pkg: &PackageMeta, has_protocol: bool) -> String {
    let name = pkg.name.to_lowercase();
    let dep = if has_protocol {
        format!("\n  \"dependencies\": {{\n    \"{RUNTIME_PACKAGE}\": \"{RUNTIME_VERSION}\"\n  }},")
    } else {
        String::new()
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
/// package, which [`build_import_map`] needs to expand a glob `use`.
fn schema_source(
    namespace: &str,
    units: &[FrozenUnit],
    schemas: &[(String, Vec<FrozenUnit>)],
    default_framing: Option<&str>,
) -> String {
    let types = TypeMapper::new(units, schemas);
    let has_protocol = units
        .iter()
        .any(|u| matches!(u, FrozenUnit::Protocol { .. }));
    let errors = error_type_names(units);

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

/// Schema-global error ordinal -> the `error` interface's name.
fn error_type_names(units: &[FrozenUnit]) -> HashMap<u16, String> {
    units
        .iter()
        .filter_map(|u| match u {
            FrozenUnit::Error { ordinal, name, .. } => Some((*ordinal, name.clone())),
            _ => None,
        })
        .collect()
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
        let call_arg = match &f.params_ty {
            Some(ty) => {
                s.push_str(&format!(
                    "                const p = codec.decode<{ty}>(params);\n"
                ));
                "p"
            }
            None => "",
        };
        if f.one_way {
            s.push_str(&format!(
                "                await this.impl.{}({call_arg});\n\
                 \x20               return;\n",
                f.name
            ));
        } else if f.throws.is_empty() {
            s.push_str(&format!(
                "                reply.ok(codec.encode((await this.impl.{}({call_arg})) ?? null));\n\
                 \x20               return;\n",
                f.name
            ));
        } else {
            s.push_str("                try {\n");
            s.push_str(&format!(
                "                    reply.ok(codec.encode((await this.impl.{}({call_arg})) ?? null));\n",
                f.name
            ));
            s.push_str("                } catch (e) {\n");
            for (_, err) in &f.throws {
                s.push_str(&format!(
                    "                    if (e instanceof {err}Error) {{ reply.err({err}Error.ordinal, codec.encode(e.data)); return; }}\n"
                ));
            }
            s.push_str("                    throw e;\n");
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
    /// Bound name -> (namespace, the name as that schema declares it).
    imports: HashMap<String, (String, String)>,
    used: RefCell<BTreeSet<String>>,
}

impl TypeMapper {
    fn new(units: &[FrozenUnit], schemas: &[(String, Vec<FrozenUnit>)]) -> Self {
        Self {
            imports: build_import_map(units, schemas),
            used: RefCell::new(BTreeSet::new()),
        }
    }

    /// `import type` lines for every imported name the rendering reached for,
    /// one per source module, relative to `namespace`.
    fn import_header(&self, namespace: &str) -> String {
        // (original, bound) pairs per namespace; sorted, so output is stable.
        let mut by_module: BTreeMap<&str, BTreeSet<(&str, &str)>> = BTreeMap::new();
        let used = self.used.borrow();
        for bound in used.iter() {
            let Some((ns, original)) = self.imports.get(bound) else {
                continue;
            };
            // A schema never imports from itself; a `use` resolving back here
            // would otherwise emit a circular self-import.
            if ns == namespace {
                continue;
            }
            by_module
                .entry(ns.as_str())
                .or_default()
                .insert((original.as_str(), bound.as_str()));
        }

        let mut s = String::new();
        for (module, names) in by_module {
            let list = names
                .iter()
                .map(|(original, bound)| {
                    if original == bound {
                        (*original).to_string()
                    } else {
                        format!("{original} as {bound}")
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "import type {{ {list} }} from \"{}\";\n",
                relative_specifier(namespace, module)
            ));
        }
        if !s.is_empty() {
            s.push('\n');
        }
        s
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
        // A named type. If one of this schema's `use` declarations bound the
        // name, record it so the header imports it; the emitted name is the
        // same either way (the binding, aliased or not).
        if self.imports.contains_key(s) {
            self.used.borrow_mut().insert(s.to_string());
        }
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

/// Bound name -> (namespace, declared name), for every name this schema's
/// `use` declarations bind to a type in another schema.
///
/// Core already expands every `use` form - plain, aliased, item-list - into
/// one leaf `FrozenUnit::Import(path, alias, _)` per bound name
/// (`resolve_use_declaration`), so a reference's origin is a flat entry right
/// here and no other schema's units need consulting. The exception is a glob,
/// which binds no name for core to list: `schemas` carries the target schema,
/// so expand it here rather than leaving its references bare.
///
/// Keeping the *declared* name alongside the namespace is what makes an alias
/// work: `use types::Greeting as G` has to emit
/// `import type { Greeting as G }`, since `G` is this schema's name for it and
/// `Greeting` is the only name the other module exports.
fn build_import_map(
    units: &[FrozenUnit],
    schemas: &[(String, Vec<FrozenUnit>)],
) -> HashMap<String, (String, String)> {
    let declares = |namespace: &str| {
        schemas
            .iter()
            .find(|(n, _)| n == namespace)
            .map(|(_, units)| units)
    };

    let mut map = HashMap::new();
    for unit in units {
        let FrozenUnit::Import(path, alias, _) = unit else {
            continue;
        };

        if let Some(namespace) = path.strip_suffix("::*") {
            let namespace = namespace.replace("::", "/");
            // Nothing to import from a schema this package doesn't carry.
            if let Some(units) = declares(&namespace) {
                for name in declared_names(units) {
                    map.insert(name.clone(), (namespace.clone(), name));
                }
            }
            continue;
        }

        let Some((namespace, name)) = path.rsplit_once("::") else {
            continue; // a single-segment path binds no name here
        };
        let namespace = namespace.replace("::", "/");
        if declares(&namespace).is_none() {
            continue;
        }
        let bound = alias.clone().unwrap_or_else(|| name.to_string());
        map.insert(bound, (namespace, name.to_string()));
    }
    map
}

/// The names a schema exports as types — what a glob `use` of it binds.
fn declared_names(units: &[FrozenUnit]) -> Vec<String> {
    units
        .iter()
        .filter_map(|u| match u {
            FrozenUnit::Struct { name, .. }
            | FrozenUnit::Error { name, .. }
            | FrozenUnit::Enum { name, .. }
            | FrozenUnit::TypeAlias { name, .. }
            | FrozenUnit::Protocol { name, .. } => Some(name.clone()),
            _ => None,
        })
        .collect()
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

/// `get_user` -> `GetUser`, for deriving a type name from a function name.
fn pascal(s: &str) -> String {
    s.split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

/// `UserService` -> `USER_SERVICE`, for the call-table const.
fn screaming_snake(s: &str) -> String {
    let mut out = String::new();
    for (i, ch) in s.char_indices() {
        if ch.is_uppercase() && i != 0 {
            out.push('_');
        }
        out.extend(ch.to_uppercase());
    }
    out
}
