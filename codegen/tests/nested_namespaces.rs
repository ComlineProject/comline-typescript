//! A protocol in a nested schema (`chat/admin`, generation#148) and a package
//! whose dependency's protocols share a method name with its own
//! (generation#147).
//!
//! A protocol's path in the generated text is `chat::admin::Admin`, every
//! segment joined by `::`, not the request's `chat/admin::Admin`; only the
//! text, no number, order or hash is made from it. The output is kept in
//! `runtime/test/generated/nested/` and `runtime/test/generated/clash/` so the
//! Node job type-checks it (`npm run typecheck:generated`). Regenerate with
//! `TS_BLESS=1 cargo test -p comline-codegen-typescript`.

use comline_codegen::validation::ValidateOnDecode;
use comline_codegen::{connections, facts, GenerateRequest, PackageMeta, TargetLanguage};
use comline_codegen_typescript::generate_typescript;
use comline_conformance::{dependency_and_own_protocols, nested_protocol, Fixture};
use comline_core::schema::ir::frozen::unit::{ConfigValue, FrozenUnit};

/// The request `comline generation` would send for `fx`: with the facts of the
/// package's own schemas when they're needed.
fn request(fx: &Fixture) -> GenerateRequest {
    let dependencies: Vec<String> = fx.dependencies.iter().map(|d| d.to_string()).collect();
    let own: Vec<_> = fx
        .schemas
        .iter()
        .filter(|(namespace, _)| !connections::is_dependency(&dependencies, namespace))
        .cloned()
        .collect();
    let mut req = GenerateRequest {
        mode: fx.mode,
        schemas: fx.schemas.clone(),
        package: PackageMeta { name: "conformance".into(), version: "0.1.0".into() },
        target: TargetLanguage {
            language: "typescript".into(),
            version: comline_codegen_typescript::LANG_VERSION.into(),
        },
        wire_format: "packed@1".into(),
        external_std: false,
        validate_on_decode: ValidateOnDecode::Off,
        async_api: false,
        encodings: comline_codegen::encodings::official_for("typescript"),
        facts: None,
        dependencies,
    };
    if facts::needed_in(&req) {
        req.facts = Some(comline_conformance::facts_for(&own, "packed@1"));
    }
    req
}

/// Every file generated for `req`, checked against `runtime/test/generated/<dir>`.
fn generated(req: &GenerateRequest, dir: &str) -> Vec<(String, String)> {
    let files = generate_typescript(req).unwrap_or_else(|e| panic!("{dir}: {e:#}"));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/test/generated").join(dir);
    let mut out = Vec::new();
    for file in files {
        let path = root.join(&file.path);
        if std::env::var_os("TS_BLESS").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &file.contents).unwrap();
        } else {
            let committed = std::fs::read_to_string(&path).unwrap_or_default();
            assert_eq!(
                file.contents, committed,
                "generated output drifted from {} — re-bless with TS_BLESS=1 cargo test -p comline-codegen-typescript",
                path.display()
            );
        }
        out.push((file.path.to_str().unwrap().to_string(), file.contents));
    }
    out
}

fn file<'a>(files: &'a [(String, String)], path: &str) -> &'a str {
    &files.iter().find(|(p, _)| p == path).unwrap_or_else(|| panic!("no `{path}` in {:?}", files.iter().map(|(p, _)| p).collect::<Vec<_>>())).1
}

/// The protocol's path reads `chat::admin::Admin` everywhere the generated
/// text shows it: the Hello comment, `PROTOCOLS` and the `checkCall` the
/// sender makes (which is what an `Unavailable` error names). The request's
/// `chat/admin` spelling is nowhere in it.
#[test]
fn a_nested_protocols_path_is_spelled_with_colons() {
    let files = generated(&request(&nested_protocol()), "nested");

    let connection = file(&files, "connection.ts");
    assert!(connection.contains(" * - `admin`: 0 `chat::admin::Admin`, line 0.1.0: `greet` 0\n"), "{connection}");
    assert!(connection.contains("new Map<number, string>([[0, \"chat::admin::Admin\"]])"), "{connection}");

    let admin = file(&files, "chat/admin.ts");
    assert!(admin.contains(", \"chat::admin::Admin\", \"greet\");"), "{admin}");

    for (path, text) in &files {
        assert!(!text.contains("chat/admin::"), "{path}: {text}");
        assert!(!text.contains("`chat/admin"), "{path}: {text}");
    }
}

/// The display path is the only thing that changed: the facts-addressed wire
/// numbers and the connection's hash are the same whichever way the namespace
/// is spelled.
#[test]
fn the_display_path_changes_no_number_or_hash() {
    let req = request(&nested_protocol());
    let files = generated(&req, "nested");
    // The package's digest is defined once, in the module its files share,
    // and the package module re-exports it.
    let wire = file(&files, "wire.ts");
    let hash = format!("CONNECTION_IR_HASH = {:#018x}n;", connections::connection_ir_hash(&req.schemas));
    assert!(wire.contains(&hash), "{wire}");
    let connection = file(&files, "connection.ts");
    assert!(connection.contains("export { CONNECTION_IR_HASH, Format } from \"./wire.js\";"), "{connection}");
    let admin = file(&files, "chat/admin.ts");
    assert!(admin.contains("checkCall(this.peer, AdminSender.PROTOCOL, 0, "), "{admin}");
}

/// A dependency's `jsonrpc` protocol sharing a function name with the
/// package's own is no clash: the dependency's isn't on the package's
/// connection (generation#147), so generation isn't refused.
#[test]
fn a_dependencys_jsonrpc_method_name_does_not_refuse_generation() {
    let mut fixture = dependency_and_own_protocols();
    let jsonrpc = || FrozenUnit::Property { name: "framing".to_string(), value: ConfigValue::Str("jsonrpc".to_string()) };
    for (_, units) in &mut fixture.schemas {
        for unit in units {
            if let FrozenUnit::Protocol { parameters, .. } = unit {
                for p in parameters.iter_mut() {
                    if matches!(p, FrozenUnit::Property { name, .. } if name == "framing") {
                        *p = jsonrpc();
                    }
                }
            }
        }
    }
    // The client provides `Events`, which is what puts `jsonrpc` protocols on a
    // connection where bare method names matter.
    let api = &mut fixture.schemas.iter_mut().find(|(n, _)| n == "api").unwrap().1;
    let mut events = api.iter().find(|u| matches!(u, FrozenUnit::Protocol { name, .. } if name == "Chat")).unwrap().clone();
    if let FrozenUnit::Protocol { name, parameters, functions, .. } = &mut events {
        *name = "Events".to_string();
        parameters.push(FrozenUnit::Property { name: "provider".to_string(), value: ConfigValue::Name("Client".to_string()) });
        if let Some(FrozenUnit::Function { name, .. }) = functions.first_mut() {
            *name = "notify".to_string();
        }
    }
    api.push(events);
    let req = request(&fixture);

    // `localdeps`' `Foo` and the package's `Chat` both have `greet`, which the
    // check unaware of dependencies refuses.
    assert!(connections::check(&req.schemas, &req.encodings).is_err());
    assert!(connections::check_in(&req).is_ok());

    let files = generated(&req, "clash");
    assert!(file(&files, "localdeps/greeting.ts").contains("export interface Foo"));
    let connection = file(&files, "connection.ts");
    assert!(connection.contains("chat?: ns_api.Chat;"), "{connection}");
    assert!(connection.contains("events?: ns_api.Events;"), "{connection}");
    assert!(!connection.contains("Foo"), "{connection}");

    // Two of the package's own still clash, the dependency or not.
    let mut own = req.clone();
    let api = &mut own.schemas.iter_mut().find(|(n, _)| n == "api").unwrap().1;
    let mut admin = api.iter().find(|u| matches!(u, FrozenUnit::Protocol { name, .. } if name == "Chat")).unwrap().clone();
    if let FrozenUnit::Protocol { name, .. } = &mut admin {
        *name = "Admin".to_string();
    }
    api.push(admin);
    assert!(connections::check_in(&own).is_err());
}
