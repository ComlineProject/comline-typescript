use comline_codegen::{GenerateRequest, Mode, PackageMeta, TargetLanguage};
use comline_codegen_typescript::generate_typescript;
use comline_core::schema::ir::frozen::types::{Literal, PrimitiveType, TypeRef};
use comline_core::schema::ir::frozen::unit::{ConfigValue, FrozenArgument, FrozenUnit};

fn code_req(schemas: &[(String, Vec<FrozenUnit>)]) -> GenerateRequest {
    GenerateRequest {
        mode: Mode::Code,
        schemas: schemas.to_vec(),
        package: PackageMeta {
            name: "test".into(),
            version: "0.1.0".into(),
        },
        target: TargetLanguage { language: "typescript".into(), version: comline_codegen_typescript::LANG_VERSION.into() },
        wire_format: "packed@1".into(),
        external_std: false,
        validate_on_decode: Default::default(),
        async_api: false,
        encodings: comline_codegen::encodings::official_for("typescript"),
    }
}

fn lib_req(schemas: &[(String, Vec<FrozenUnit>)]) -> GenerateRequest {
    GenerateRequest {
        mode: Mode::Lib,
        schemas: schemas.to_vec(),
        package: PackageMeta {
            name: "chat".into(),
            version: "0.3.0".into(),
        },
        target: TargetLanguage { language: "typescript".into(), version: comline_codegen_typescript::LANG_VERSION.into() },
        wire_format: "packed@1".into(),
        external_std: false,
        validate_on_decode: Default::default(),
        async_api: false,
        encodings: comline_codegen::encodings::official_for("typescript"),
    }
}

fn external_std_req(schemas: &[(String, Vec<FrozenUnit>)]) -> GenerateRequest {
    GenerateRequest {
        external_std: true,
        ..lib_req(schemas)
    }
}

/// The schema's own file; a protocol on a connection brings the package's
/// `connection.ts` too.
fn one(units: Vec<FrozenUnit>) -> String {
    let schemas = vec![("account".to_string(), units)];
    let mut files = generate_typescript(&code_req(&schemas)).unwrap();
    assert_eq!(files[0].path.to_str().unwrap(), "account.ts");
    assert!(files.iter().skip(1).all(|f| f.path.to_str() == Some("connection.ts")));
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
    // Each declaration carries its `Layout`, the alias's its target's.
    assert!(out.contains("import type { Layout } from \"@comline/runtime\";"), "got: {out}");
    assert!(out.contains("export const UserIdLayout: Layout = \"u64\";"), "got: {out}");
    assert!(
        out.contains("export const GreetingLayout: Layout = { struct: [[\"sender\", () => UserIdLayout]] };"),
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
fn every_type_declares_its_layout() {
    let out = one(vec![struct_of("Point", vec![field("x", "u32"), field("y", "f64")])]);
    assert!(out.contains("x: number;"), "got: {out}");
    assert!(out.contains("export const PointLayout: Layout = { struct: [[\"x\", \"u32\"], [\"y\", \"f64\"]] };"), "got: {out}");
    // Only the type: the runtime isn't loaded for it.
    assert!(out.contains("import type { Layout } from \"@comline/runtime\";"), "got: {out}");
}

/// Only the fields that hold a `bigint` are listed, however deep it is.
#[test]
fn a_layout_follows_arrays_options_and_named_types() {
    let mut tree = struct_of(
        "Tree",
        vec![
            field("leaves", "Leaf[]"),
            field("big", "u128[4]"),
            // Recursive: the function form is what makes this load.
            field("children", "Tree[]"),
        ],
    );
    if let FrozenUnit::Struct { fields, .. } = &mut tree {
        if let FrozenUnit::Field { optional, .. } = &mut fields[0] {
            *optional = true;
        }
    }
    let out = one(vec![struct_of("Leaf", vec![field("id", "s64"), field("label", "string")]), tree]);
    assert!(
        out.contains("export const LeafLayout: Layout = { struct: [[\"id\", \"s64\"], [\"label\", \"string\"]] };"),
        "got: {out}"
    );
    assert!(
        out.contains(
            "export const TreeLayout: Layout = { struct: [[\"leaves\", { option: { array: () => LeafLayout } }], \
             [\"big\", { fixed: \"u128\", length: 4 }], [\"children\", { array: () => TreeLayout }]] };"
        ),
        "got: {out}"
    );
}

/// A union's members are told apart by kind, so each member is described.
#[test]
fn a_union_lists_every_member() {
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
        out.contains("export const HolderLayout: Layout = { struct: [[\"value\", { union: [\"string\", \"u64\", \"bool\"] }]] };"),
        "got: {out}"
    );
}

/// The client decodes a result, and an error's data, with their shapes;
/// the dispatcher decodes params with theirs.
#[test]
fn every_call_passes_its_layout() {
    let out = one(chat_units());
    assert!(out.contains("codec.decode<ChatHistoryParams>(params, ChatHistoryParamsLayout)"), "got: {out}");
    assert!(out.contains("codec.encode((await this.impl.send(p)) ?? null, MessageLayout)"), "got: {out}");
    assert!(out.contains("codec.encode(null, \"unit\")"), "got: {out}");
    assert!(out.contains("call({ id: 0, name: \"send\" }, params, { layout: ChatSendParamsLayout })"), "got: {out}");
    assert!(out.contains("call({ id: 2, name: \"wipe\" }, null, { layout: \"unit\" })"), "got: {out}");
    assert!(out.contains("notify({ id: 3, name: \"note\" }, params, { layout: ChatNoteParamsLayout })"), "got: {out}");
    assert!(out.contains("decode<Message>(env.ok, MessageLayout)"), "got: {out}");
    assert!(out.contains("decode<Message[]>(env.ok, { array: MessageLayout })"), "got: {out}");
    assert!(out.contains("decode<Rejected>(env.err.body, RejectedLayout)"), "got: {out}");
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

    // Erasable syntax: a `const` object and a union, not an `enum`.
    assert!(!out.contains("enum Status"));
    assert!(out.contains("export const Status = {"));
    assert!(out.contains("Active: \"Active\","));
    assert!(out.contains("Inactive: \"Inactive\","));
    assert!(out.contains("export type Status = (typeof Status)[keyof typeof Status];"));
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
            // The lockstep `Client` / `Server`, which `datagram@1` keeps now
            // that a connection is the default.
            parameters: vec![FrozenUnit::Property {
                name: "framing".into(),
                value: ConfigValue::Str("datagram".into()),
            }],
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
    assert!(out.contains("if (e instanceof RejectedError) { reply.err(RejectedError.ordinal, codec.encode(e.data, RejectedLayout)); return; }"));
    assert!(out.contains("await this.impl.note(p);")); // one-way: no reply

    // client + serve helper, on `datagram@1` and the package's `Format`
    // unless told otherwise
    assert!(out.contains("export const Format: Codec = new PackedCodec();"));
    assert!(out.contains("export class ChatClient {"));
    assert!(out.contains("codec: Codec = Format, framing: Framing = new DatagramFraming()"));
    assert!(out.contains("case RejectedError.ordinal:"));
    assert!(out.contains("await this.client.notify({ id: 3, name: \"note\" }, params, { layout: ChatNoteParamsLayout });"));
    assert!(out.contains(
        "export function serveChat(impl: Chat, transport: Transport, codec: Codec = Format, framing: Framing = new DatagramFraming()): Promise<void> {"
    ));
}

#[test]
fn framing_annotation_and_package_default_pick_jsonrpc() {
    // @framing = "jsonrpc" on the protocol (core writes the package's
    // `wire.framing` the same way)
    let mut units = chat_units();
    if let FrozenUnit::Protocol { parameters, .. } = &mut units[2] {
        parameters[0] = FrozenUnit::Property {
            name: "framing".into(),
            value: ConfigValue::Str("jsonrpc".into()),
        };
    }
    let out = one(units);
    assert!(out.contains("    JsonRpcFraming,"));
    assert!(out.contains("framing: Framing = new JsonRpcFraming()"));
    assert!(!out.contains("new DatagramFraming()"));
    // JSON-RPC carries JSON, whatever the package's format.
    assert!(out.contains("codec: Codec = new JsonCodec()"), "{out}");
    assert!(!out.contains("Format"), "{out}");

}

#[test]
fn an_unknown_wire_format_is_an_error() {
    let schemas = vec![("account".to_string(), chat_units())];
    let req = GenerateRequest { wire_format: "packed".into(), ..code_req(&schemas) };
    let error = generate_typescript(&req).unwrap_err();
    assert_eq!(
        error.to_string(),
        "encoding `packed` has no typescript mapping in the request: map it in comline.toml, as \
         `encodings = { \"packed\" = \"<type>\" }`"
    );
}

/// `chat_units` over `framing`, which nothing in this generator knows.
fn acme_units(framing: &str) -> Vec<FrozenUnit> {
    let mut units = chat_units();
    for unit in &mut units {
        if let FrozenUnit::Protocol { parameters, .. } = unit {
            parameters.retain(|p| !matches!(p, FrozenUnit::Property { name, .. } if name == "framing"));
            parameters.push(FrozenUnit::Property { name: "framing".into(), value: ConfigValue::Str(framing.into()) });
        }
    }
    units
}

fn acme_req(mode: Mode) -> GenerateRequest {
    let acme = |class: &str| comline_codegen::protocol::EncodingMapping {
        type_path: class.into(),
        package: Some("acme-encodings".into()),
        version: Some("^0.2.0".into()),
    };
    let schemas = vec![("account".to_string(), acme_units("com.acme.lines@1"))];
    let mut req = GenerateRequest { mode, wire_format: "com.acme.cbor@1".into(), ..lib_req(&schemas) };
    req.encodings.insert("com.acme.lines@1".into(), acme("LinesFraming"));
    req.encodings.insert("com.acme.cbor@1".into(), acme("CborCodec"));
    req
}

#[test]
fn an_unmapped_framing_is_an_error_not_a_fallback() {
    let schemas = vec![("account".to_string(), acme_units("com.acme.lines@1"))];
    let error = generate_typescript(&code_req(&schemas)).unwrap_err().to_string();
    assert!(error.starts_with("encoding `com.acme.lines@1` has no typescript mapping in the request"), "{error}");
}

/// A third-party framing and codec, imported from the package their mapping
/// names, kept in `runtime/test/generated/acme.ts` so the Node job
/// type-checks it against a stub of that package
/// (`runtime/test/generated/acme-encodings.ts`). Regenerate with
/// `TS_BLESS=1 cargo test -p comline-codegen-typescript`.
#[test]
fn a_third_party_framing_and_codec_are_imported_from_their_package() {
    let mut files = generate_typescript(&acme_req(Mode::Code)).unwrap();
    let generated = files.remove(0).contents;
    assert!(generated.contains("import { LinesFraming, CborCodec } from \"acme-encodings\";\n"), "{generated}");
    assert!(generated.contains("framing: Framing = new LinesFraming()"), "{generated}");
    assert!(generated.contains("export const Format: Codec = new CborCodec();"), "{generated}");
    assert!(!generated.contains("DatagramFraming"), "{generated}");
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../runtime/test/generated/acme.ts");
    if std::env::var_os("TS_BLESS").is_some() {
        std::fs::write(path, &generated).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        generated, committed,
        "generated acme drifted from runtime/test/generated/acme.ts — \
         re-bless with TS_BLESS=1 cargo test -p comline-codegen-typescript"
    );
}

/// `Clock`, lockstep (`datagram`), and `Link`, on a connection (the
/// default), both running `handshake`.
fn hello_units(handshake: &str) -> Vec<FrozenUnit> {
    let protocol = |name: &str, framing: Option<&str>| {
        let mut parameters =
            vec![FrozenUnit::Property { name: "handshake".into(), value: ConfigValue::Str(handshake.into()) }];
        if let Some(framing) = framing {
            parameters.push(FrozenUnit::Property { name: "framing".into(), value: ConfigValue::Str(framing.into()) });
        }
        FrozenUnit::Protocol {
            docstring: name.into(),
            name: name.into(),
            parameters,
            functions: vec![function("now", vec![], Some(TypeRef::Primitive(PrimitiveType::U32)), vec![])],
            span: (0, 0),
        }
    };
    vec![protocol("Clock", Some("datagram")), protocol("Link", None)]
}

#[test]
fn an_unmapped_handshake_is_an_error_not_a_fallback() {
    let schemas = vec![("hello".to_string(), hello_units("com.acme.hello@1"))];
    let error = generate_typescript(&code_req(&schemas)).unwrap_err().to_string();
    assert!(error.starts_with("encoding `com.acme.hello@1` has no typescript mapping in the request"), "{error}");
}

/// A third-party handshake, imported from the package its mapping names and
/// passed wherever generated code opens: the lockstep `Client` / `Server`,
/// and the package's `accept` / `connect`. Kept in
/// `runtime/test/generated/hello/` so the Node job type-checks it against
/// the stub package (`runtime/test/generated/acme-encodings.ts`), whose
/// `HelloHandshake` implements the runtime's `Handshake`. Regenerate with
/// `TS_BLESS=1 cargo test -p comline-codegen-typescript`.
#[test]
fn a_third_party_handshake_is_imported_and_run() {
    let schemas = vec![("hello".to_string(), hello_units("com.acme.hello@1"))];
    let mut req = code_req(&schemas);
    req.encodings.insert(
        "com.acme.hello@1".into(),
        comline_codegen::protocol::EncodingMapping {
            type_path: "HelloHandshake".into(),
            package: Some("acme-encodings".into()),
            version: Some("^0.2.0".into()),
        },
    );
    let files = generate_typescript(&req).unwrap();
    let file = |name: &str| files.iter().find(|f| f.path.to_str() == Some(name)).unwrap().contents.clone();
    let (hello, connection) = (file("hello.ts"), file("connection.ts"));
    assert!(hello.contains("import { HelloHandshake } from \"acme-encodings\";\n"), "{hello}");
    assert!(hello.contains("await Client.connect(transport, codec, IR_HASH, framing, new HelloHandshake())"), "{hello}");
    assert!(hello.contains(".serve(transport, IR_HASH, new HelloHandshake());"), "{hello}");
    assert!(connection.contains("import { HelloHandshake } from \"acme-encodings\";\n"), "{connection}");
    assert!(
        connection.contains("await Connection.accept(transport, Format, CONNECTION_IR_HASH, undefined, new HelloHandshake())"),
        "{connection}"
    );
    for (name, generated) in [("hello.ts", &hello), ("connection.ts", &connection)] {
        let path = format!("{}/../runtime/test/generated/hello/{name}", env!("CARGO_MANIFEST_DIR"));
        if std::env::var_os("TS_BLESS").is_some() {
            std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
            std::fs::write(&path, generated).unwrap();
            continue;
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            *generated, committed,
            "generated {name} drifted from runtime/test/generated/hello/ — \
             re-bless with TS_BLESS=1 cargo test -p comline-codegen-typescript"
        );
    }
}

#[test]
fn lib_output_depends_on_a_mapped_package() {
    let files = generate_typescript(&acme_req(Mode::Lib)).unwrap();
    let manifest = &files.iter().find(|f| f.path.to_str() == Some("package.json")).unwrap().contents;
    assert!(manifest.contains("    \"acme-encodings\": \"^0.2.0\""), "{manifest}");
    assert_eq!(manifest.matches("@comline/runtime").count(), 1, "{manifest}");
}

#[test]
fn msgpack_is_refused_until_the_runtime_has_a_codec() {
    let schemas = vec![("account".to_string(), chat_units())];
    let req = GenerateRequest { wire_format: "msgpack@1".into(), ..code_req(&schemas) };
    let error = generate_typescript(&req).unwrap_err().to_string();
    assert!(error.contains("no MessagePack codec"), "{error}");
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
    // Only its `Layout`'s type, which loads nothing.
    assert!(out.contains("import type { Layout } from \"@comline/runtime\";\n"), "{out}");
    assert_eq!(out.matches("import").count(), 1, "{out}");
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

    // The declared version and up, never a ceiling: npm would refuse a newer compiler.
    assert!(pkg.contains("\"peerDependencies\": {\n    \"typescript\": \">=5.0\"\n  }"));
    assert!(pkg.contains("\"typescript\": { \"optional\": true }"));
    let tsconfig = by_path("tsconfig.json");
    assert!(tsconfig.contains("\"NodeNext\""));
    assert!(tsconfig.contains("\"target\": \"ES2020\""));
    assert!(tsconfig.contains("\"exactOptionalPropertyTypes\": true"));
    assert!(by_path("src/chat.ts")
        .starts_with("// Generated by Comline\n// For TypeScript 5.0 or later; verified up to 5.9.\n"));

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
        !out.contains("http") && !out.contains("HttpMethod"),
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
    assert!(!out.contains("elsewhere"), "got: {out}");
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
    let req = GenerateRequest {
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
    let req = GenerateRequest {
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
fn a_layout_from_another_schema_is_imported_as_a_value() {
    let schemas = wide_across_schemas();
    let out = code_file(&schemas, "events");
    assert!(out.contains("import { StampLayout, TagLayout } from \"./ids.js\";"), "got: {out}");
    assert!(out.contains("import type { Stamp, Tag } from \"./ids.js\";"), "got: {out}");
    assert!(
        out.contains("export const EventLayout: Layout = { struct: [[\"stamp\", () => StampLayout], [\"tag\", () => TagLayout]] };"),
        "got: {out}"
    );
}

/// A package of plain data names the runtime only in an erased
/// `import type { Layout }`: an optional peer, not a dependency.
#[test]
fn lib_mode_makes_the_runtime_an_optional_peer_for_layouts() {
    let schemas = wide_across_schemas();
    let files = generate_typescript(&lib_req(&schemas)).unwrap();
    let pkg = &files
        .iter()
        .find(|f| f.path.to_str().unwrap() == "package.json")
        .unwrap()
        .contents;
    assert!(!pkg.contains("\"dependencies\""), "got: {pkg}");
    assert!(
        pkg.contains("\"peerDependencies\": {\n    \"@comline/runtime\": \"^0.1.0\",\n"),
        "got: {pkg}"
    );
    assert!(pkg.contains("\"@comline/runtime\": { \"optional\": true },"), "got: {pkg}");
}

#[test]
fn handshake_none_passes_no_handshake_and_documents_what_is_given_up() {
    use comline_core::schema::ir::frozen::unit::Guarantee;
    let out = one(vec![FrozenUnit::Protocol {
        docstring: String::new(),
        parameters: vec![
            FrozenUnit::Property { name: "handshake".into(), value: ConfigValue::Str("none".into()) },
            FrozenUnit::Property {
                name: "unverified".into(),
                value: ConfigValue::Str("the 2009 gateway".into()),
            },
            FrozenUnit::Unverified(vec![Guarantee::SchemaAgreement, Guarantee::EncodingAgreement]),
        ],
        name: "Gate".into(),
        functions: vec![function("ping", vec![], Some(TypeRef::Primitive(PrimitiveType::U32)), vec![])],
        span: (0, 0),
    }]);
    // The lockstep `Client` / `Server` it was written against; on a connection
    // see `the_package_connection_runs_its_handshake`.
    let out = {
        let _ = out;
        let mut units = vec![FrozenUnit::Protocol {
            docstring: String::new(),
            parameters: vec![
                FrozenUnit::Property { name: "handshake".into(), value: ConfigValue::Str("none".into()) },
                FrozenUnit::Property {
                    name: "unverified".into(),
                    value: ConfigValue::Str("the 2009 gateway".into()),
                },
                FrozenUnit::Unverified(vec![Guarantee::SchemaAgreement, Guarantee::EncodingAgreement]),
            ],
            name: "Gate".into(),
            functions: vec![function("ping", vec![], Some(TypeRef::Primitive(PrimitiveType::U32)), vec![])],
            span: (0, 0),
        }];
        if let FrozenUnit::Protocol { parameters, .. } = &mut units[0] {
            parameters.push(FrozenUnit::Property { name: "framing".into(), value: ConfigValue::Str("datagram".into()) });
        }
        one(units)
    };

    assert!(out.contains("    NoHandshake,\n"), "{out}");
    assert!(out.contains("await Client.connect(transport, codec, IR_HASH, framing, new NoHandshake())"));
    assert!(out.contains(".serve(transport, IR_HASH, new NoHandshake())"));
    let doc = "/**\n * **Unverified:** gives up schema agreement and encoding agreement (handshake `none`).\n \
               * Reason given: the 2009 gateway\n */\n";
    assert!(out.contains(&format!("{doc}export class GateDispatcher")), "{out}");
    assert!(out.contains(&format!("{doc}export class GateClient")), "{out}");
}

#[test]
fn a_protocol_with_the_default_handshake_imports_no_no_handshake() {
    let out = one(vec![FrozenUnit::Protocol {
        docstring: String::new(),
        parameters: vec![],
        name: "Plain".into(),
        functions: vec![function("ping", vec![], None, vec![])],
        span: (0, 0),
    }]);
    assert!(!out.contains("NoHandshake"));
    assert!(!out.contains("Unverified"));
}

/// Two protocols on one connection: `Chat`, which the accepting side
/// provides, and `Events`, which the dialling side does.
const LINK: &str = r#"
@framing = "datagram@2"
protocol Chat {
    function send(text: string) -> u64;
    function count() -> u64;
}

@provider = Client
@framing = "datagram@2"
protocol Events {
    function message(text: string) -> bool;
    function ping();
}
"#;

fn link_units() -> Vec<FrozenUnit> {
    use comline_core::schema::ir::compiler::interpreter::incremental::IncrementalInterpreter;
    use comline_core::schema::ir::compiler::Compile;
    IncrementalInterpreter::from_source(LINK)
}

#[test]
fn a_connection_protocol_gets_a_sender_and_peer_taking_handlers() {
    let out = one(link_units());
    assert!(out.contains("export class EventsSender {"));
    assert!(out.contains("message(peer: Peer, params: EventsMessageParams): Promise<boolean>;"));
    assert!(out.contains("static readonly PROTOCOL = 1;"));
    assert!(out.contains("export const CONNECTION_IR_HASH = "));
    assert!(!out.contains("ChatClient"), "no lockstep client for a connection protocol");
    assert!(!out.contains("serveChat"));
}

/// `async` asks for what TypeScript always generates: handlers and senders
/// that return Promises. The output is the same with it or without.
#[test]
fn async_changes_nothing_in_typescript() {
    let schemas = vec![("link".to_string(), link_units())];
    let plain = generate_typescript(&code_req(&schemas)).unwrap();
    let asynchronous = generate_typescript(&GenerateRequest { async_api: true, ..code_req(&schemas) }).unwrap();
    assert_eq!(plain[0].contents, asynchronous[0].contents);
    assert!(plain[0].contents.contains("Promise<"));
}

/// [`LINK`] over JSON-RPC: `Chat` names only its framing, and joins the
/// connection because `Events`, which the client provides, is on one;
/// `Events` qualifies its method names.
const LINK_JSONRPC: &str = r#"
@framing = "jsonrpc"
protocol Chat {
    function send(text: string) -> u64;
    function count() -> u64;
}

@provider = Client
@framing = { name = "jsonrpc", method_names = qualified }
protocol Events {
    function message(text: string) -> bool;
    function ping();
}
"#;

fn link_jsonrpc_units() -> Vec<FrozenUnit> {
    use comline_core::schema::ir::compiler::interpreter::incremental::IncrementalInterpreter;
    use comline_core::schema::ir::compiler::Compile;
    IncrementalInterpreter::from_source(LINK_JSONRPC)
}

#[test]
fn jsonrpc_on_a_connection_names_calls_by_method() {
    let schemas = vec![("link".to_string(), link_jsonrpc_units())];
    let out = generate_typescript(&code_req(&schemas)).unwrap().remove(0).contents;
    assert!(out.contains(r#"export const CHAT_CALLS = ["send", "count"] as const;"#), "{out}");
    assert!(out.contains(r#"export const EVENTS_CALLS = ["link.Events/message", "link.Events/ping"] as const;"#), "{out}");
    assert!(out.contains(r#"name: "link.Events/message""#), "the sender calls the qualified method: {out}");
    assert!(!out.contains("ChatClient"), "Chat is on the connection too");
    assert!(out.contains("new JsonRpcConnectionFraming()"), "the dispatcher's doc says how to open it: {out}");
}

/// Two JSON-RPC protocols the server provides on one connection, both with
/// a `send`: bare method names can't tell them apart.
#[test]
fn bare_jsonrpc_names_that_would_clash_on_a_connection_are_refused() {
    use comline_core::schema::ir::compiler::interpreter::incremental::IncrementalInterpreter;
    use comline_core::schema::ir::compiler::Compile;

    let source = |admin_framing: &str| {
        format!(
            "@framing = \"jsonrpc\"\nprotocol Chat {{\n    function send(text: string) -> u64;\n}}\n\n\
             @framing = {admin_framing}\nprotocol Admin {{\n    function send(text: string) -> u64;\n}}\n\n\
             @provider = Client\n@framing = \"jsonrpc\"\nprotocol Events {{\n    function ping();\n}}\n"
        )
    };
    let generate = |admin_framing: &str| {
        let schemas = vec![("link".to_string(), IncrementalInterpreter::from_source(&source(admin_framing)))];
        generate_typescript(&code_req(&schemas)).map(|_| ())
    };
    let err = generate("\"jsonrpc\"").unwrap_err().to_string();
    assert!(err.contains("`link::Chat` and `link::Admin` both have a function `send`"), "{err}");
    generate("{ name = \"jsonrpc\", method_names = qualified }").unwrap();
}

/// The generated connection protocols, kept in
/// `runtime/test/generated/link.ts` so the Node job type-checks and runs
/// them. Regenerate with `TS_BLESS=1 cargo test -p comline-codegen-typescript`.
#[test]
fn generated_link_matches_the_runtime_test_fixture() {
    let schemas = vec![("link".to_string(), link_units())];
    let generated = generate_typescript(&code_req(&schemas)).unwrap().remove(0).contents;
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../runtime/test/generated/link.ts");
    if std::env::var_os("TS_BLESS").is_some() {
        std::fs::write(path, &generated).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        generated, committed,
        "generated link drifted from runtime/test/generated/link.ts — \
         re-bless with TS_BLESS=1 cargo test -p comline-codegen-typescript"
    );
}

/// The same over JSON-RPC, in `runtime/test/generated/link_jsonrpc.ts`.
#[test]
fn generated_jsonrpc_link_matches_the_runtime_test_fixture() {
    let schemas = vec![("link".to_string(), link_jsonrpc_units())];
    let generated = generate_typescript(&code_req(&schemas)).unwrap().remove(0).contents;
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../runtime/test/generated/link_jsonrpc.ts");
    if std::env::var_os("TS_BLESS").is_some() {
        std::fs::write(path, &generated).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        generated, committed,
        "generated link drifted from runtime/test/generated/link_jsonrpc.ts — \
         re-bless with TS_BLESS=1 cargo test -p comline-codegen-typescript"
    );
}

/// A package of protocols across schemas, none naming a framing: on one
/// connection by default, served through the package's `Services`.
const GAME: &str = "protocol Account {\n    function login(name: string) -> u32;\n}\n\n\
                    protocol Player {\n    function level(id: u32) -> u64;\n}\n";
const ITEMS: &str = "struct Item {\n    name: string\n    count: u8\n}\n\n\
                     protocol Inventory {\n    function items(id: u32) -> Item[];\n}\n\n\
                     @provider = Client\nprotocol Events {\n    function changed(count: u8);\n}\n";

fn game_schemas() -> Vec<(String, Vec<FrozenUnit>)> {
    use comline_core::schema::ir::compiler::interpreter::incremental::IncrementalInterpreter;
    use comline_core::schema::ir::compiler::Compile;
    vec![
        ("game".to_string(), IncrementalInterpreter::from_source(GAME)),
        ("items".to_string(), IncrementalInterpreter::from_source(ITEMS)),
    ]
}

#[test]
fn the_package_connection_gets_services_and_serve() {
    let schemas = game_schemas();
    let files = generate_typescript(&code_req(&schemas)).unwrap();
    let module = &files.iter().find(|f| f.path.to_str() == Some("connection.ts")).unwrap().contents;
    for expected in [
        "import * as ns_game from \"./game.js\";",
        "export const Format: Codec = new PackedCodec();",
        "export interface Services {\n    account: ns_game.Account;\n    player: ns_game.Player;\n    inventory: ns_items.Inventory;\n}",
        "export interface ClientServices {\n    events: ns_items.Events;\n}",
        "    new ns_items.InventoryDispatcher(services.inventory).provideOn(conn);",
        "export async function serve(transport: Transport, services: Services): Promise<void> {",
        "const conn = await Connection.connect(transport, Format, CONNECTION_IR_HASH);",
    ] {
        assert!(module.contains(expected), "missing `{expected}` in:\n{module}");
    }

    // In `lib` mode it's beside the schemas, its names at the root.
    let files = generate_typescript(&lib_req(&schemas)).unwrap();
    let index = &files.iter().find(|f| f.path.to_str() == Some("src/index.ts")).unwrap().contents;
    assert!(index.ends_with("export * from \"./connection.js\";\n"), "{index}");
    assert!(files.iter().any(|f| f.path.to_str() == Some("src/connection.ts")));
}

/// The package's `serve` and `connect`, kept in
/// `runtime/test/generated/services/` so the Node job type-checks and runs
/// them over `packed@1`. Regenerate with `TS_BLESS=1`.
#[test]
fn generated_services_match_the_runtime_test_fixture() {
    let schemas = game_schemas();
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../runtime/test/generated/services");
    for file in generate_typescript(&code_req(&schemas)).unwrap() {
        let path = std::path::Path::new(dir).join(&file.path);
        if std::env::var_os("TS_BLESS").is_some() {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(&path, &file.contents).unwrap();
            continue;
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            file.contents, committed,
            "generated services drifted from {} — re-bless with TS_BLESS=1 cargo test -p comline-codegen-typescript",
            path.display()
        );
    }
}
