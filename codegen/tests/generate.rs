use comline_codegen::{GenRequest, Mode, PackageMeta};
use comline_codegen_typescript::generate_typescript;
use comline_core::schema::ir::frozen::types::{Literal, PrimitiveType, TypeRef};
use comline_core::schema::ir::frozen::unit::{ConfigValue, FrozenArgument, FrozenUnit};

fn code_req(schemas: &[(String, Vec<FrozenUnit>)]) -> GenRequest<'_> {
    GenRequest {
        mode: Mode::Code,
        schemas,
        package: PackageMeta {
            name: "test".into(),
            version: "0.1.0".into(),
        },
        lang_version: comline_codegen_typescript::LANG_VERSION.into(),
        default_framing: None,
        external_std: false,
        validate_on_decode: Default::default(),
    }
}

fn lib_req(schemas: &[(String, Vec<FrozenUnit>)]) -> GenRequest<'_> {
    GenRequest {
        mode: Mode::Lib,
        schemas,
        package: PackageMeta {
            name: "chat".into(),
            version: "0.3.0".into(),
        },
        lang_version: comline_codegen_typescript::LANG_VERSION.into(),
        default_framing: None,
        external_std: false,
        validate_on_decode: Default::default(),
    }
}

fn external_std_req(schemas: &[(String, Vec<FrozenUnit>)]) -> GenRequest<'_> {
    GenRequest {
        external_std: true,
        ..lib_req(schemas)
    }
}

fn one(units: Vec<FrozenUnit>) -> String {
    let schemas = vec![("account".to_string(), units)];
    let mut files = generate_typescript(&code_req(&schemas)).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path.to_str().unwrap(), "account.ts");
    files.remove(0).contents
}

/// The type a schema spells `written` - a primitive name, a named type, or
/// either followed by `[]` / `[N]`.
fn type_of(written: &str) -> TypeRef {
    if let Some(rest) = written.strip_suffix(']') {
        let (element, length) = rest.rsplit_once('[').expect("an array type");
        return TypeRef::Array {
            element: Box::new(type_of(element)),
            length: (!length.is_empty()).then(|| length.parse().expect("an array length")),
        };
    }
    match PrimitiveType::from_name(written) {
        Some(p) => TypeRef::Primitive(p),
        None => TypeRef::Named(written.to_string()),
    }
}

fn field(name: &str, ty: &str) -> FrozenUnit {
    FrozenUnit::Field {
        docstring: None,
        parameters: vec![],
        optional: false,
        name: name.into(),
        ty: type_of(ty),
        default: None,
        span: (0, 0),
    }
}

fn arg(name: &str, ty: TypeRef) -> FrozenArgument {
    FrozenArgument {
        name: name.into(),
        ty,
        span: (0, 0),
    }
}

fn function(
    name: &str,
    args: Vec<FrozenArgument>,
    ret: Option<TypeRef>,
    throws: Vec<u16>,
) -> FrozenUnit {
    FrozenUnit::Function {
        docstring: String::new(),
        parameters: vec![],
        name: name.into(),
        arguments: args,
        _return: ret,
        throws,
        span: (0, 0),
    }
}

#[test]
fn interface_from_struct() {
    let out = one(vec![FrozenUnit::Struct {
        docstring: None,
        parameters: vec![],
        name: "User".to_string(),
        fields: vec![
            field("id", "s32"),
            field("username", "string"),
            FrozenUnit::Field {
                docstring: None,
                parameters: vec![],
                optional: true,
                name: "tags".to_string(),
                ty: TypeRef::Array { element: Box::new(TypeRef::Primitive(PrimitiveType::String)), length: None }, default: None,
                span: (0, 0),
            },
        ],
        span: (0, 0),
    }]);

    assert!(out.contains("export interface User {"));
    assert!(out.contains("id: number;"));
    assert!(out.contains("username: string;"));
    assert!(out.contains("tags?: string[];"));
}

#[test]
fn type_alias_emits_and_fields_reference_it_by_name() {
    let out = one(vec![
        FrozenUnit::TypeAlias {
            docstring: None,
            parameters: vec![],
            name: "UserId".to_string(),
            target: TypeRef::Primitive(PrimitiveType::U64),
            span: (0, 0),
        },
        FrozenUnit::Struct {
            docstring: None,
            parameters: vec![],
            name: "Greeting".to_string(),
            fields: vec![field("sender", "UserId")],
            span: (0, 0),
        },
    ]);

    assert!(out.contains("export type UserId = bigint;"), "got: {out}");
    assert!(out.contains("sender: UserId;"), "got: {out}");
    // A `u64` is a `bigint`, so both declarations carry a `Shape`.
    assert!(out.contains("import type { Shape } from \"@comline/runtime\";"), "got: {out}");
    assert!(out.contains("export const UserId: Shape = \"bigint\";"), "got: {out}");
    assert!(
        out.contains("export const Greeting: Shape = { fields: { sender: () => UserId } };"),
        "got: {out}"
    );
}

fn struct_of(name: &str, fields: Vec<FrozenUnit>) -> FrozenUnit {
    FrozenUnit::Struct {
        docstring: None,
        parameters: vec![],
        name: name.to_string(),
        fields,
        span: (0, 0),
    }
}

/// Nothing wide, nothing extra: no `Shape`, no runtime import.
#[test]
fn a_type_without_a_bigint_has_no_shape() {
    let out = one(vec![struct_of("Point", vec![field("x", "u32"), field("y", "f64")])]);
    assert!(out.contains("x: number;"), "got: {out}");
    assert!(!out.contains("Shape"), "got: {out}");
    assert!(!out.contains("@comline/runtime"), "got: {out}");
}

/// Only the fields that hold a `bigint` are listed, however deep it is.
#[test]
fn a_shape_follows_arrays_and_named_types() {
    let out = one(vec![
        struct_of("Leaf", vec![field("id", "s64"), field("label", "string")]),
        struct_of("Plain", vec![field("n", "u32")]),
        struct_of(
            "Tree",
            vec![
                field("leaves", "Leaf[]"),
                field("plain", "Plain"),
                field("big", "u128[4]"),
                // Recursive: the function form is what makes this load.
                field("children", "Tree[]"),
            ],
        ),
    ]);
    assert!(out.contains("export const Leaf: Shape = { fields: { id: \"bigint\" } };"), "got: {out}");
    assert!(!out.contains("export const Plain"), "got: {out}");
    assert!(
        out.contains(
            "export const Tree: Shape = { fields: { leaves: { array: () => Leaf }, \
             big: { array: \"bigint\" }, children: { array: () => Tree } } };"
        ),
        "got: {out}"
    );
}

/// A union's members are told apart by kind, so each member is described.
#[test]
fn a_union_with_a_bigint_names_every_member() {
    let mut s = struct_of("Holder", vec![]);
    if let FrozenUnit::Struct { fields, .. } = &mut s {
        fields.push(FrozenUnit::Field {
            docstring: None,
            parameters: vec![],
            optional: false,
            name: "value".into(),
            ty: TypeRef::Union(vec![type_of("string"), type_of("u64"), type_of("bool")]),
            default: None,
            span: (0, 0),
        });
    }
    let out = one(vec![s]);
    assert!(
        out.contains("export const Holder: Shape = { fields: { value: { union: [\"string\", \"bigint\", \"boolean\"] } } };"),
        "got: {out}"
    );
}

/// The client decodes a result, and an error's data, with their shapes;
/// the dispatcher decodes params with theirs.
#[test]
fn decoding_passes_each_shape() {
    let mut units = chat_units();
    if let FrozenUnit::Error { fields, .. } = &mut units[1] {
        fields.push(field("retry_after", "u64"));
    }
    if let FrozenUnit::Protocol { functions, .. } = &mut units[2] {
        if let FrozenUnit::Function { arguments, .. } = &mut functions[1] {
            arguments[0].ty = TypeRef::Primitive(PrimitiveType::U64);
        }
    }
    let out = one(units);
    assert!(out.contains("export const ChatHistoryParams: Shape = { fields: { limit: \"bigint\" } };"), "got: {out}");
    assert!(out.contains("codec.decode<ChatHistoryParams>(params, ChatHistoryParams)"), "got: {out}");
    assert!(out.contains("codec.decode<ChatSendParams>(params);"), "got: {out}");
    assert!(out.contains("decode<Message>(env.ok, Message)"), "got: {out}");
    assert!(out.contains("decode<Message[]>(env.ok, { array: () => Message })"), "got: {out}");
    assert!(out.contains("decode<Rejected>(env.err.body, Rejected)"), "got: {out}");
}

#[test]
fn string_enum_from_enum() {
    let out = one(vec![FrozenUnit::Enum {
        docstring: None,
        name: "Status".to_string(),
        variants: vec![
            FrozenUnit::EnumVariant("Active".to_string(), (0, 0)),
            FrozenUnit::EnumVariant("Inactive".to_string(), (0, 0)),
        ],
        span: (0, 0),
    }]);

    assert!(out.contains("export enum Status {"));
    assert!(out.contains("Active = \"Active\","));
    assert!(out.contains("Inactive = \"Inactive\","));
}

/// A struct, an `error`, and a protocol exercising: a throwing call with args, a
/// non-throwing call returning a list, a `()` return, and a one-way call.
fn chat_units() -> Vec<FrozenUnit> {
    vec![
        FrozenUnit::Struct {
            docstring: None,
            parameters: vec![],
            name: "Message".into(),
            fields: vec![field("body", "string"), field("seq", "u64")],
            span: (0, 0),
        },
        FrozenUnit::Error {
            docstring: None,
            parameters: vec![],
            ordinal: 0,
            imported_from: None,
            name: "Rejected".into(),
            message: "rejected: {self.reason}".into(),
            fields: vec![field("reason", "string")],
            span: Some((0, 0)),
            message_span: None,
            uninterpolated: vec![],
        },
        FrozenUnit::Protocol {
            docstring: "Chat".into(),
            name: "Chat".into(),
            parameters: vec![],
            functions: vec![
                function(
                    "send",
                    vec![arg("text", TypeRef::Primitive(PrimitiveType::String))],
                    Some(TypeRef::Named("Message".to_string())),
                    vec![0],
                ),
                function(
                    "history",
                    vec![arg("limit", TypeRef::Primitive(PrimitiveType::U32))],
                    Some(TypeRef::Array { element: Box::new(TypeRef::Named("Message".to_string())), length: None }),
                    vec![],
                ),
                function("wipe", vec![], Some(TypeRef::Unit), vec![]),
                function(
                    "note",
                    vec![arg("text", TypeRef::Primitive(PrimitiveType::String))],
                    None,
                    vec![],
                ),
            ],
            span: (0, 0),
        },
    ]
}

#[test]
fn protocol_emits_the_rpc_shape() {
    let out = one(chat_units());

    // handshake digest + the runtime import
    assert!(out.contains("export const IR_HASH = 0x"));
    assert!(out.contains("} from \"@comline/runtime\";"));

    // the wire payload interface + the throwable class, keyed by ordinal
    assert!(out.contains("export interface Rejected {\n    reason: string;\n}"));
    assert!(out.contains("export class RejectedError extends Error {"));
    assert!(out.contains("static readonly ordinal = 0;"));

    // params interfaces + provider interface
    assert!(out.contains("export interface ChatSendParams {\n    text: string;\n}"));
    assert!(out.contains("    /** @throws {RejectedError} */"));
    assert!(out.contains("    send(params: ChatSendParams): Promise<Message>;"));
    assert!(out.contains("    wipe(): Promise<void>;"));
    assert!(out.contains("    note(params: ChatNoteParams): Promise<void>;"));

    // call table + dispatcher
    assert!(out.contains(
        "export const CHAT_CALLS = [\"send\", \"history\", \"wipe\", \"note\"] as const;"
    ));
    assert!(out.contains("export class ChatDispatcher implements Dispatch {"));
    assert!(out.contains("if (e instanceof RejectedError) { reply.err(RejectedError.ordinal, codec.encode(e.data)); return; }"));
    assert!(out.contains("await this.impl.note(p);")); // one-way: no reply

    // client + serve helper, both wired to the datagram framing by default
    assert!(out.contains("export class ChatClient {"));
    assert!(out.contains("framing: Framing = new DatagramFraming()"));
    assert!(out.contains("case RejectedError.ordinal:"));
    assert!(out.contains("await this.client.notify({ id: 3, name: \"note\" }, params);"));
    assert!(out.contains(
        "export function serveChat(impl: Chat, transport: Transport, codec: Codec, framing: Framing = new DatagramFraming()): Promise<void> {"
    ));
}

#[test]
fn framing_annotation_and_package_default_pick_jsonrpc() {
    // @framing = "jsonrpc" on the protocol
    let mut units = chat_units();
    if let FrozenUnit::Protocol { parameters, .. } = &mut units[2] {
        parameters.push(FrozenUnit::Property {
            name: "framing".into(),
            value: ConfigValue::Str("jsonrpc".into()),
        });
    }
    let out = one(units);
    assert!(out.contains("    JsonRpcFraming,"));
    assert!(out.contains("framing: Framing = new JsonRpcFraming()"));
    assert!(!out.contains("new DatagramFraming()"));

    // …or the package default reaches an unannotated protocol
    let schemas = vec![("account".to_string(), chat_units())];
    let req = GenRequest {
        default_framing: Some("jsonrpc".to_string()),
        ..code_req(&schemas)
    };
    let out = generate_typescript(&req).unwrap().remove(0).contents;
    assert!(out.contains("framing: Framing = new JsonRpcFraming()"));
}

#[test]
fn a_schema_without_a_protocol_has_no_ir_hash_or_runtime_import() {
    let out = one(vec![FrozenUnit::Enum {
        docstring: None,
        name: "Status".to_string(),
        variants: vec![FrozenUnit::EnumVariant("Active".to_string(),
            (0, 0),
        )],
        span: (0, 0),
    }]);
    assert!(!out.contains("IR_HASH"));
    assert!(!out.contains("@comline/runtime"));
}

/// The generated `Chat` client / dispatcher, kept in
/// `runtime/test/generated/chat.ts` so the Node job type-checks and runs it.
/// Regenerate with `TS_BLESS=1 cargo test -p comline-codegen-typescript`.
#[test]
fn generated_chat_matches_the_runtime_test_fixture() {
    let generated = one(chat_units());
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime/test/generated/chat.ts"
    );
    if std::env::var_os("TS_BLESS").is_some() {
        std::fs::write(path, &generated).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        generated, committed,
        "generated Chat drifted from runtime/test/generated/chat.ts — \
         re-bless with TS_BLESS=1 cargo test -p comline-codegen-typescript"
    );
}

#[test]
fn lib_mode_emits_an_npm_package() {
    let schemas = vec![
        ("chat".to_string(), chat_units()),
        ("billing".to_string(), vec![]),
    ];
    let files = generate_typescript(&lib_req(&schemas)).unwrap();
    let by_path = |p: &str| {
        &files
            .iter()
            .find(|f| f.path.to_str().unwrap() == p)
            .unwrap()
            .contents
    };

    let pkg = by_path("package.json");
    assert!(pkg.contains("\"name\": \"chat\""));
    assert!(pkg.contains("\"version\": \"0.3.0\""));
    assert!(pkg.contains("\"type\": \"module\""));
    assert!(pkg.contains("\"@comline/runtime\": \"^0.1.0\"")); // a protocol pulls it in

    assert!(
        pkg.contains("\"./*\""),
        "subpath exports, for `chat/billing`: {pkg}"
    );

    assert!(by_path("tsconfig.json").contains("\"NodeNext\""));

    let index = by_path("src/index.ts");
    assert!(index.contains("export * as chat from \"./chat.js\";"));
    assert!(index.contains("export * as billing from \"./billing.js\";"));

    assert!(by_path("src/chat.ts").contains("export class ChatClient {"));
    assert!(files
        .iter()
        .any(|f| f.path.to_str().unwrap() == "src/billing.ts"));
}

#[test]
fn lib_mode_omits_the_runtime_dep_without_a_protocol() {
    let schemas = vec![("data".to_string(), vec![])];
    let files = generate_typescript(&lib_req(&schemas)).unwrap();
    let pkg = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "package.json")
        .unwrap()
        .contents;
    assert!(!pkg.contains("@comline/runtime"));
}

/// `use <path>` as core freezes it: one leaf entry per bound name.
fn import(path: &str, alias: Option<&str>) -> FrozenUnit {
    FrozenUnit::Import(path.into(), alias.map(Into::into), (0, 0))
}

fn struct_with(name: &str, fields: Vec<FrozenUnit>) -> FrozenUnit {
    FrozenUnit::Struct {
        docstring: None,
        parameters: vec![],
        name: name.into(),
        fields,
        span: (0, 0),
    }
}

/// A package shaped like a real one: the consumer's own schemas plus the
/// implicit std library, which is nested and present in *every* package -
/// the reason flat-only `lib` mode could never generate anything.
fn nested_package() -> Vec<(String, Vec<FrozenUnit>)> {
    vec![
        (
            "none".to_string(),
            vec![
                import("types::Greeting", None),
                struct_with("Test", vec![field("greeting", "Greeting")]),
            ],
        ),
        (
            "types".to_string(),
            vec![struct_with("Greeting", vec![field("message", "string")])],
        ),
        (
            "std/http".to_string(),
            vec![struct_with("Request", vec![field("uri", "str")])],
        ),
        (
            "std/validators".to_string(),
            vec![struct_with("StringBounds", vec![field("max", "u32")])],
        ),
    ]
}

#[test]
fn lib_mode_mirrors_nested_namespaces() {
    let schemas = nested_package();
    let files = generate_typescript(&lib_req(&schemas)).unwrap();
    let paths: Vec<&str> = files.iter().map(|f| f.path.to_str().unwrap()).collect();

    for expected in [
        "src/index.ts",
        "src/none.ts",
        "src/types.ts",
        "src/std/index.ts",
        "src/std/http.ts",
        "src/std/validators.ts",
    ] {
        assert!(paths.contains(&expected), "missing {expected}: {paths:?}");
    }

    let by_path = |p: &str| {
        &files
            .iter()
            .find(|f| f.path.to_str().unwrap() == p)
            .unwrap()
            .contents
    };

    // Each level names its children, so nothing is flattened into the
    // package root and `std/http`'s `Request` can't collide with yours.
    let root = by_path("src/index.ts");
    assert!(
        root.contains("export * as none from \"./none.js\";"),
        "got: {root}"
    );
    assert!(
        root.contains("export * as types from \"./types.js\";"),
        "got: {root}"
    );
    assert!(
        root.contains("export * as std from \"./std/index.js\";"),
        "a grouping node points at its own barrel: {root}"
    );
    assert!(
        !root.contains("std/http"),
        "the root names `std`, not its children: {root}"
    );

    let std_index = by_path("src/std/index.ts");
    assert!(
        std_index.contains("export * as http from \"./http.js\";"),
        "got: {std_index}"
    );
    assert!(
        std_index.contains("export * as validators from \"./validators.js\";"),
        "got: {std_index}"
    );
}

#[test]
fn lib_mode_refuses_a_schema_that_is_also_a_namespace() {
    let schemas = vec![
        ("std".to_string(), vec![]),
        ("std/http".to_string(), vec![]),
    ];
    let err = generate_typescript(&lib_req(&schemas))
        .unwrap_err()
        .to_string();
    assert!(err.contains("both a schema and a namespace"), "got: {err}");
    assert!(
        err.contains("export * as std"),
        "names the line it can't write: {err}"
    );
}

// ── cross-schema references ────────────────────────────────────────────────

/// The file a schema generates, by namespace, in `code` mode.
fn code_file(schemas: &[(String, Vec<FrozenUnit>)], namespace: &str) -> String {
    let files = generate_typescript(&code_req(schemas)).unwrap();
    files
        .iter()
        .find(|f| f.path.to_str().unwrap() == format!("{namespace}.ts"))
        .unwrap_or_else(|| panic!("no file for {namespace}"))
        .contents
        .clone()
}

#[test]
fn a_cross_schema_reference_is_imported() {
    let schemas = nested_package();
    let out = code_file(&schemas, "none");
    assert!(
        out.contains("import type { Greeting } from \"./types.js\";"),
        "a referenced type from another schema must be imported: {out}"
    );
    assert!(out.contains("greeting: Greeting;"), "got: {out}");
}

#[test]
fn a_cross_schema_import_is_imported_in_lib_mode_too() {
    let schemas = nested_package();
    let files = generate_typescript(&lib_req(&schemas)).unwrap();
    let none = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "src/none.ts")
        .unwrap()
        .contents;
    assert!(
        none.contains("import type { Greeting } from \"./types.js\";"),
        "got: {none}"
    );
}

#[test]
fn an_import_specifier_is_relative_to_the_importing_schema() {
    // `std/http` sits a directory down, so reaching a root-level schema is
    // `../`, and a sibling under `std/` is `./`.
    let schemas = vec![
        (
            "std/http".to_string(),
            vec![
                import("types::Greeting", None),
                import("std::validators::StringBounds", None),
                struct_with(
                    "Request",
                    vec![
                        field("greeting", "Greeting"),
                        field("bounds", "StringBounds"),
                    ],
                ),
            ],
        ),
        (
            "types".to_string(),
            vec![struct_with("Greeting", vec![field("message", "string")])],
        ),
        (
            "std/validators".to_string(),
            vec![struct_with("StringBounds", vec![field("max", "u32")])],
        ),
    ];
    let out = code_file(&schemas, "std/http");
    assert!(
        out.contains("import type { Greeting } from \"../types.js\";"),
        "got: {out}"
    );
    assert!(
        out.contains("import type { StringBounds } from \"./validators.js\";"),
        "a sibling namespace is `./`, not `../std/`: {out}"
    );
}

#[test]
fn an_alias_imports_the_name_the_other_schema_declares() {
    let schemas = vec![
        (
            "none".to_string(),
            vec![
                import("types::Greeting", Some("G")),
                struct_with("Test", vec![field("greeting", "G")]),
            ],
        ),
        (
            "types".to_string(),
            vec![struct_with("Greeting", vec![field("message", "string")])],
        ),
    ];
    let out = code_file(&schemas, "none");
    assert!(
        out.contains("import type { Greeting as G } from \"./types.js\";"),
        "`Greeting` is the only name the other module exports: {out}"
    );
    assert!(out.contains("greeting: G;"), "got: {out}");
}

#[test]
fn a_glob_use_binds_the_names_the_other_schema_declares() {
    // Core expands `use types::*` into the `::*` marker **plus** one leaf
    // `Import` per name the target declares - the marker alone binds
    // nothing. That is `resolve_use_declaration`, and it holds for `std` too:
    // a real project with `use std::http::*` generates
    // `crate::std::http::Request`, resolved from the leaves.
    //
    // The leaves were missing here, so this fixture was asserting against
    // input core never produces. It is the generator's own glob expansion
    // this used to exercise - redundant with core's, and now gone.
    let schemas = vec![
        (
            "none".to_string(),
            vec![
                import("types::*", None),
                import("types::Greeting", None),
                import("types::Unused", None),
                struct_with("Test", vec![field("greeting", "Greeting")]),
            ],
        ),
        (
            "types".to_string(),
            vec![
                struct_with("Greeting", vec![field("message", "string")]),
                struct_with("Unused", vec![]),
            ],
        ),
    ];
    let out = code_file(&schemas, "none");
    assert!(
        out.contains("import type { Greeting } from \"./types.js\";"),
        "got: {out}"
    );
    assert!(
        !out.contains("Unused"),
        "a glob still imports only what is used: {out}"
    );
}

#[test]
fn an_unused_use_emits_no_import() {
    // `use std::http::HttpMethod` with nothing referring to it - common in
    // real schemas, and an import for it would be dead weight.
    let schemas = vec![
        (
            "none".to_string(),
            vec![
                import("std::http::HttpMethod", None),
                struct_with("Test", vec![field("message", "string")]),
            ],
        ),
        (
            "std/http".to_string(),
            vec![FrozenUnit::Enum {
                docstring: None,
                name: "HttpMethod".into(),
                variants: vec![],
                span: (0, 0),
            }],
        ),
    ];
    let out = code_file(&schemas, "none");
    assert!(
        !out.contains("import"),
        "nothing is referenced, so nothing is imported: {out}"
    );
}

#[test]
fn a_reference_to_a_schema_the_package_does_not_carry_stays_bare() {
    // A generator that doesn't inline some dependency emits no file for it,
    // so an import pointing there would never resolve.
    let schemas = vec![(
        "none".to_string(),
        vec![
            import("elsewhere::Thing", None),
            struct_with("Test", vec![field("thing", "Thing")]),
        ],
    )];
    let out = code_file(&schemas, "none");
    assert!(!out.contains("import type"), "got: {out}");
    assert!(out.contains("thing: Thing;"), "got: {out}");
}

// ── external std ───────────────────────────────────────────────────────────

/// A package whose own schema uses a std type, with std present as it always
/// is - the shape every real project has.
fn package_using_std() -> Vec<(String, Vec<FrozenUnit>)> {
    vec![
        (
            "none".to_string(),
            vec![
                import("std::http::Request", None),
                struct_with("Test", vec![field("req", "Request")]),
            ],
        ),
        (
            "std/http".to_string(),
            vec![struct_with("Request", vec![field("uri", "str")])],
        ),
        (
            "std/validators".to_string(),
            vec![struct_with("StringBounds", vec![field("max", "u32")])],
        ),
    ]
}

#[test]
fn external_std_emits_no_std_files() {
    let schemas = package_using_std();
    let files = generate_typescript(&external_std_req(&schemas)).unwrap();
    let paths: Vec<&str> = files.iter().map(|f| f.path.to_str().unwrap()).collect();

    assert!(paths.contains(&"src/none.ts"), "{paths:?}");
    assert!(
        !paths.iter().any(|p| p.contains("std")),
        "std comes from its own package, so nothing here: {paths:?}"
    );

    // ... and the barrel doesn't name a module that was never written.
    let index = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "src/index.ts")
        .unwrap()
        .contents;
    assert!(!index.contains("std"), "got: {index}");
}

/// The regression this is most at risk of: std is filtered out of the emitted
/// set, and if references were resolved against *that* list instead of the
/// whole request, every std import would vanish and the bare names would be
/// back. Pairs with
/// `a_reference_to_a_schema_the_package_does_not_carry_stays_bare`, which
/// asserts the opposite case through the same code - together they pin the
/// distinction between "not emitted" and "not known".
#[test]
fn external_std_is_still_imported_though_no_file_is_emitted() {
    let schemas = package_using_std();
    let files = generate_typescript(&external_std_req(&schemas)).unwrap();
    let none = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "src/none.ts")
        .unwrap()
        .contents;

    assert!(
        none.contains("import type { Request } from \"@comline/std/http\";"),
        "the `std` segment is stripped - `@comline/std` is its own root: {none}"
    );
    assert!(none.contains("req: Request;"), "got: {none}");
}

#[test]
fn external_std_declares_the_dependency() {
    let schemas = package_using_std();
    let files = generate_typescript(&external_std_req(&schemas)).unwrap();
    let pkg = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "package.json")
        .unwrap()
        .contents;
    assert!(pkg.contains("\"@comline/std\": \"^0.1.0\""), "got: {pkg}");
}

#[test]
fn external_std_declares_nothing_when_there_was_no_std() {
    // A request with no std schemas at all: the flag is on, but there is
    // nothing it applied to, so the dependency would be a lie.
    let schemas = vec![(
        "none".to_string(),
        vec![struct_with("Test", vec![field("message", "string")])],
    )];
    let files = generate_typescript(&external_std_req(&schemas)).unwrap();
    let pkg = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "package.json")
        .unwrap()
        .contents;
    assert!(!pkg.contains("@comline/std"), "got: {pkg}");
}

#[test]
fn inlined_std_imports_by_relative_path() {
    // The default: std is part of this package, so it is reached the same way
    // any other schema is.
    let schemas = package_using_std();
    let files = generate_typescript(&lib_req(&schemas)).unwrap();
    let none = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "src/none.ts")
        .unwrap()
        .contents;
    assert!(
        none.contains("import type { Request } from \"./std/http.js\";"),
        "got: {none}"
    );
    assert!(
        files
            .iter()
            .any(|f| f.path.to_str().unwrap() == "src/std/http.ts"),
        "and the file is written"
    );

    let pkg = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "package.json")
        .unwrap()
        .contents;
    assert!(
        !pkg.contains("@comline/std"),
        "nothing external to declare: {pkg}"
    );
}

#[test]
fn external_std_in_code_mode_says_what_to_install() {
    // `code` mode has no manifest to put the dependency in, so the file does
    // the telling.
    let schemas = package_using_std();
    let req = GenRequest {
        external_std: true,
        ..code_req(&schemas)
    };
    let files = generate_typescript(&req).unwrap();
    let none = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "none.ts")
        .unwrap()
        .contents;

    assert!(
        none.contains("npm install @comline/std@^0.1.0"),
        "got: {none}"
    );
    assert!(
        none.contains("import type { Request } from \"@comline/std/http\";"),
        "got: {none}"
    );
    assert!(
        !files
            .iter()
            .any(|f| f.path.to_str().unwrap().contains("std")),
        "still no std files in code mode"
    );
}

#[test]
fn a_file_not_touching_std_gets_no_install_note() {
    // `none` uses std; `plain` doesn't, and only `none` should carry the note.
    let mut schemas = package_using_std();
    schemas.push((
        "plain".to_string(),
        vec![struct_with("Plain", vec![field("message", "string")])],
    ));
    let req = GenRequest {
        external_std: true,
        ..code_req(&schemas)
    };
    let files = generate_typescript(&req).unwrap();
    let plain = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "plain.ts")
        .unwrap()
        .contents;
    assert!(!plain.contains("npm install"), "got: {plain}");
}

/// A schema of nothing but constants generated an empty file - the
/// declarations were dropped on the floor.
#[test]
fn constants_are_emitted() {
    let constant = |doc: Option<&str>, name: &str, ty: PrimitiveType, value: Literal| {
        FrozenUnit::Constant {
            docstring: doc.map(str::to_string),
            name: name.to_string(),
            ty: TypeRef::Primitive(ty),
            value: Some(value),
            span: (0, 0),
        }
    };
    let schemas = vec![(
        "limits".to_string(),
        vec![
            constant(
                Some("How many times a client retries."),
                "MAX_RETRIES",
                PrimitiveType::U8,
                Literal::Integer(5),
            ),
            constant(
                None,
                "SERVICE_NAME",
                PrimitiveType::String,
                Literal::String("store".into()),
            ),
            constant(None, "DEBUG", PrimitiveType::Bool, Literal::Bool(true)),
            constant(None, "HUGE", PrimitiveType::U128, Literal::Integer(7)),
            constant(None, "BIG", PrimitiveType::U64, Literal::Integer(9)),
        ],
    )];
    let out = code_file(&schemas, "limits");

    assert!(
        out.contains(
            "/**\n * How many times a client retries.\n */\nexport const MAX_RETRIES = 5;"
        ),
        "got: {out}"
    );
    // No `: number` annotation - the inferred literal type says more.
    assert!(!out.contains("MAX_RETRIES: number"), "got: {out}");
    assert!(
        out.contains("export const SERVICE_NAME = \"store\";"),
        "got: {out}"
    );
    assert!(out.contains("export const DEBUG = true;"), "got: {out}");
    // `bigint`, so the literal needs the suffix to actually be one.
    assert!(out.contains("export const HUGE = 7n;"), "got: {out}");
    assert!(out.contains("export const BIG = 9n;"), "got: {out}");
}

/// `! A, B`. The IR has always modelled `throws` as a list, so this needed
/// nothing — but nothing proved it either, because the grammar could only
/// produce one.
#[test]
fn a_function_with_several_throws_documents_and_catches_each() {
    let error = |ordinal: u16, name: &str| FrozenUnit::Error {
        docstring: None,
        parameters: vec![],
        ordinal,
        imported_from: None,
        name: name.to_string(),
        message: format!("{name} happened"),
        fields: vec![],
        span: None,
        message_span: None,
        uninterpolated: vec![],
    };
    let proto = FrozenUnit::Protocol {
        docstring: String::new(),
        parameters: vec![],
        name: "Vault".to_string(),
        // The `!` clause's own order, which need not be ordinal order.
        functions: vec![function("open", vec![], Some(TypeRef::Unit), vec![1, 0])],
        span: (0, 0),
    };
    let src = one(vec![error(0, "NotFound"), error(1, "Denied"), proto]);

    // Both errors are documented on the interface, in clause order.
    assert!(
        src.contains("/** @throws {DeniedError | NotFoundError} */"),
        "{src}"
    );
    // The dispatcher tests for each, and still faults on anything else.
    assert!(
        src.contains("if (e instanceof DeniedError) { reply.err(DeniedError.ordinal,"),
        "{src}"
    );
    assert!(
        src.contains("if (e instanceof NotFoundError) { reply.err(NotFoundError.ordinal,"),
        "{src}"
    );
    assert!(src.contains("reply.fault();"), "{src}");
    // And the client maps both ordinals back to their thrown class.
    assert!(src.contains("case DeniedError.ordinal:"), "{src}");
    assert!(src.contains("case NotFoundError.ordinal:"), "{src}");
    // A peer's fault is a runtime error, taken off the union first.
    assert!(
        src.contains("if (\"fault\" in env) throw RuntimeError.provider();"),
        "{src}"
    );
}

/// `error Rude` becomes `class RudeError`, so a declared `RudeError` of any
/// kind collides with it — the TypeScript route into the same bug Rust hits
/// via `<Proto>Error`.
#[test]
fn an_error_suffix_that_collides_with_a_declaration_is_refused() {
    let declared = FrozenUnit::Struct {
        docstring: None,
        parameters: vec![],
        name: "RudeError".to_string(),
        fields: vec![],
        span: (0, 0),
    };
    let error = FrozenUnit::Error {
        docstring: None,
        parameters: vec![],
        ordinal: 0,
        imported_from: None,
        name: "Rude".to_string(),
        message: "no".into(),
        fields: vec![],
        span: None,
        message_span: None,
        uninterpolated: vec![],
    };
    let schemas = vec![("chat".to_string(), vec![declared, error])];
    let err = generate_typescript(&code_req(&schemas)).expect_err("the name is taken");
    let message = err.to_string();
    assert!(message.contains("declares struct `RudeError`"), "{message}");
    assert!(message.contains("error `Rude`"), "{message}");
}

/// The protocol-derived names are checked too, not just the `Error` suffix.
#[test]
fn a_protocol_derived_name_collides_too() {
    let declared = FrozenUnit::Struct {
        docstring: None,
        parameters: vec![],
        name: "ChatDispatcher".to_string(),
        fields: vec![],
        span: (0, 0),
    };
    let proto = FrozenUnit::Protocol {
        docstring: String::new(),
        parameters: vec![],
        name: "Chat".to_string(),
        functions: vec![],
        span: (0, 0),
    };
    let schemas = vec![("chat".to_string(), vec![declared, proto])];
    let err = generate_typescript(&code_req(&schemas)).expect_err("the name is taken");
    assert!(
        err.to_string().contains("declares struct `ChatDispatcher`"),
        "{err}"
    );
}

/// The fixture schema must keep generating — this check is additive, not a
/// new hurdle for schemas that were already fine.
#[test]
fn the_chat_fixture_has_no_collisions() {
    let schemas = vec![("chat".to_string(), chat_units())];
    assert!(generate_typescript(&code_req(&schemas)).is_ok());
}

/// Floats are `number`, a fixed array is `T[]` (TypeScript has no
/// fixed-length array short of a tuple), and a union is `A | B` -
/// parenthesised when it is an array's element. Unions rendered as
/// `unknown` before core froze types structurally.
#[test]
fn floats_fixed_arrays_and_unions_render() {
    let either = TypeRef::Union(vec![type_of("string"), type_of("u32")]);
    let union_field = |name: &str, ty: TypeRef| FrozenUnit::Field {
        docstring: None,
        parameters: vec![],
        optional: false,
        name: name.into(),
        ty,
        default: None,
        span: (0, 0),
    };
    let schemas = vec![(
        "shapes".to_string(),
        vec![FrozenUnit::Struct {
            docstring: None,
            parameters: vec![],
            name: "Sample".to_string(),
            fields: vec![
                field("ratio", "f32"),
                field("digest", "u8[64]"),
                union_field("either", either.clone()),
                union_field(
                    "many",
                    TypeRef::Array { element: Box::new(either), length: None },
                ),
            ],
            span: (0, 0),
        }],
    )];
    let out = code_file(&schemas, "shapes");
    for line in [
        "    ratio: number;\n",
        "    digest: number[];\n",
        "    either: string | number;\n",
        "    many: (string | number)[];\n",
    ] {
        assert!(out.contains(line), "missing {line:?} in: {out}");
    }
}

fn wide_across_schemas() -> Vec<(String, Vec<FrozenUnit>)> {
    vec![
        (
            "ids".to_string(),
            vec![
                struct_of("Stamp", vec![field("at", "u64")]),
                struct_of("Tag", vec![field("n", "u8")]),
            ],
        ),
        (
            "events".to_string(),
            vec![
                import("ids::Stamp", None),
                import("ids::Tag", None),
                struct_of("Event", vec![field("stamp", "Stamp"), field("tag", "Tag")]),
            ],
        ),
    ]
}

/// A shape from another schema is a value, so its name can't come in through
/// `import type`; a name used only as a type still does.
#[test]
fn a_shape_from_another_schema_is_imported_as_a_value() {
    let schemas = wide_across_schemas();
    let out = code_file(&schemas, "events");
    assert!(out.contains("import { Stamp } from \"./ids.js\";"), "got: {out}");
    assert!(out.contains("import type { Tag } from \"./ids.js\";"), "got: {out}");
    assert!(
        out.contains("export const Event: Shape = { fields: { stamp: () => Stamp } };"),
        "got: {out}"
    );
}

/// A package of plain data needs the runtime once a type has a `Shape`.
#[test]
fn lib_mode_declares_the_runtime_dep_for_a_shape() {
    let schemas = wide_across_schemas();
    let files = generate_typescript(&lib_req(&schemas)).unwrap();
    let pkg = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "package.json")
        .unwrap()
        .contents;
    assert!(pkg.contains("\"@comline/runtime\""), "got: {pkg}");
}
