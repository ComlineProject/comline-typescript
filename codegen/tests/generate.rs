use comline_codegen::{GenRequest, Mode, PackageMeta};
use comline_codegen_typescript::generate_typescript;
use comline_core::schema::ir::compiler::interpreted::kind_search::{KindValue, Primitive};
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
    }
}

fn one(units: Vec<FrozenUnit>) -> String {
    let schemas = vec![("account".to_string(), units)];
    let mut files = generate_typescript(&code_req(&schemas)).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path.to_str().unwrap(), "account.ts");
    files.remove(0).contents
}

fn field(name: &str, ty: &str) -> FrozenUnit {
    FrozenUnit::Field {
        docstring: None,
        parameters: vec![],
        optional: false,
        name: name.into(),
        kind_value: KindValue::Namespaced(ty.into(), None),
        span: (0, 0),
    }
}

fn arg(name: &str, kind: KindValue) -> FrozenArgument {
    FrozenArgument {
        name: name.into(),
        kind,
        span: (0, 0),
    }
}

fn function(
    name: &str,
    args: Vec<FrozenArgument>,
    ret: Option<KindValue>,
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
                kind_value: KindValue::Namespaced("string[]".to_string(), None),
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
            name: "UserId".to_string(),
            target: KindValue::Namespaced("u64".to_string(), None),
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

    assert!(out.contains("export type UserId = number;"), "got: {out}");
    assert!(out.contains("sender: UserId;"), "got: {out}");
}

#[test]
fn string_enum_from_enum() {
    let out = one(vec![FrozenUnit::Enum {
        docstring: None,
        name: "Status".to_string(),
        variants: vec![
            FrozenUnit::EnumVariant(KindValue::EnumVariant("Active".to_string(), None), (0, 0)),
            FrozenUnit::EnumVariant(KindValue::EnumVariant("Inactive".to_string(), None), (0, 0)),
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
        },
        FrozenUnit::Protocol {
            docstring: "Chat".into(),
            name: "Chat".into(),
            parameters: vec![],
            functions: vec![
                function(
                    "send",
                    vec![arg("text", KindValue::Namespaced("string".into(), None))],
                    Some(KindValue::Namespaced("Message".into(), None)),
                    vec![0],
                ),
                function(
                    "history",
                    vec![arg("limit", KindValue::Primitive(Primitive::U32(None)))],
                    Some(KindValue::Namespaced("Message[]".into(), None)),
                    vec![],
                ),
                function("wipe", vec![], Some(KindValue::Unit), vec![]),
                function(
                    "note",
                    vec![arg("text", KindValue::Namespaced("string".into(), None))],
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
        variants: vec![FrozenUnit::EnumVariant(
            KindValue::EnumVariant("Active".to_string(), None),
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
    let schemas = vec![
        (
            "none".to_string(),
            vec![
                import("types::*", None),
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
