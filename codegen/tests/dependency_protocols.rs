//! A dependency's protocol that the package doesn't reach (generation#143, step
//! 0 of the dependency protocols proposal): it is generated as a type, but it
//! isn't on the package's connection, so it isn't in `Services`, isn't in the
//! Hello, and is addressed by position instead of by the package's wire
//! numbers.
//!
//! Both packages of generation's conformance fixtures are generated, and their
//! output is kept in `runtime/test/generated/dependency/` so the Node job
//! type-checks it (`npm run typecheck:generated`). Regenerate with
//! `TS_BLESS=1 cargo test -p comline-codegen-typescript`.

use comline_codegen::validation::ValidateOnDecode;
use comline_codegen::{connections, facts, GenerateRequest, PackageMeta, TargetLanguage};
use comline_codegen_typescript::generate_typescript;
use comline_conformance::{dependency_and_own_protocols, dependency_protocol, Fixture};

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

/// Every file generated for `fx`, checked against `runtime/test/generated/dependency/<dir>`.
fn generated(fx: &Fixture, dir: &str) -> Vec<(String, String)> {
    let req = request(fx);
    let files = generate_typescript(&req).unwrap_or_else(|e| panic!("{}: {e:#}", fx.name));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/test/generated/dependency").join(dir);
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

/// A package that uses only a dependency's types generates, and has no
/// connection: the dependency's protocol is a type to generate, nothing more.
#[test]
fn a_package_using_only_a_dependencys_types_has_no_connection() {
    let files = generated(&dependency_protocol(), "only");
    assert!(files.iter().all(|(p, _)| p != "connection.ts"), "{:?}", files.iter().map(|(p, _)| p).collect::<Vec<_>>());
    // The dependency's protocol keeps its generated types.
    let greeting = file(&files, "localdeps/greeting.ts");
    assert!(greeting.contains("export interface Foo"), "{greeting}");
    assert!(greeting.contains("export class FooDispatcher"), "{greeting}");
    // Nothing in it is addressed by the package's facts.
    assert!(!greeting.contains("checkCall"), "{greeting}");
}

/// With a protocol of its own, the package's connection serves that one:
/// `Services` and the Hello leave the dependency's out, which is addressed by
/// position where `Chat` is addressed by its wire numbers.
#[test]
fn a_dependencys_protocol_is_not_in_services_or_the_hello() {
    let files = generated(&dependency_and_own_protocols(), "own");
    let connection = file(&files, "connection.ts");
    assert!(connection.contains("export interface Services {\n    chat: ns_api.Chat;\n}"), "{connection}");
    assert!(!connection.contains("Foo"), "{connection}");
    assert!(!connection.contains("localdeps"), "{connection}");
    assert!(!connection.contains("ns_localdeps"), "{connection}");

    // The Hello and the protocols by number name only `Chat`.
    assert!(connection.contains(" * - 0 `api::Chat`, line 0.1.0: `greet` 0\n"), "{connection}");
    assert!(connection.contains("new Map<number, string>([[0, \"api::Chat\"]])"), "{connection}");

    // The dependency's protocol is still generated, with no wire numbers of the
    // package's: its calls are by position.
    let greeting = file(&files, "localdeps/greeting.ts");
    assert!(greeting.contains("export interface Foo"), "{greeting}");
    assert!(!greeting.contains("checkCall"), "{greeting}");
    let api = file(&files, "api.ts");
    assert!(api.contains("checkCall"), "{api}");
}
