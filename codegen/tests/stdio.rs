//! The TypeScript generator as its own process (`comline-gen-typescript`) answers exactly
//! what calling it directly does, for every package of the conformance corpus
//! at each of the generator's version boundaries.

use std::io::Write;
use std::process::{Command, Stdio};

use comline_codegen::protocol::{decode, encode, FileOut, Request, Response};
use comline_codegen::{GenerateRequest, PackageMeta, TargetLanguage};
use comline_codegen_typescript::{generate_typescript, VERSIONS};
use comline_conformance::{corpus, Fixture};
use comline_core::schema::idl::annotations::DEFAULT_FORMAT;

/// `request` on the binary's stdin, its stdout decoded.
fn run(request: &Request) -> Response {
    let mut child = Command::new(env!("CARGO_BIN_EXE_comline-gen-typescript"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn comline-gen-typescript");
    child.stdin.take().unwrap().write_all(&encode(request).unwrap()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "comline-gen-typescript exited with {}", out.status);
    decode(&out.stdout).expect("a Response on stdout")
}

fn request(fx: &Fixture, version: &str) -> GenerateRequest {
    GenerateRequest {
        mode: fx.mode,
        schemas: fx.schemas.clone(),
        package: PackageMeta { name: "conformance".into(), version: "0.0.0".into() },
        target: TargetLanguage { language: "typescript".into(), version: version.into() },
        wire_format: fx.wire_format.map_or_else(|| DEFAULT_FORMAT.to_string(), str::to_string),
        external_std: fx.external_std,
        validate_on_decode: fx.validate_on_decode,
        async_api: fx.async_api,
        encodings: comline_codegen::encodings::official_for("typescript"),
    }
}

#[test]
fn the_binary_generates_what_the_linked_generator_does() {
    let mut generated = 0;
    let mut refused = 0;
    for fx in corpus() {
        for version in VERSIONS.boundaries() {
            let req = request(&fx, version);
            let expected = match generate_typescript(&req) {
                Ok(files) => Ok(files.into_iter().map(FileOut::from).collect::<Vec<_>>()),
                Err(e) => Err(format!("{e:#}")),
            };
            let is_ok = expected.is_ok();
            let got = match run(&Request::generate(req)) {
                Response::Generate(generated) => Ok(generated.files),
                Response::Error { message } => Err(message),
                other => panic!("{} @ {version}: unexpected {other:?}", fx.name),
            };
            assert_eq!(got, expected, "{} @ {version}", fx.name);
            if is_ok { generated += 1 } else { refused += 1 }
        }
    }
    assert!(generated >= 20, "only {generated} runs generated files ({refused} were refused)");
}

#[test]
fn the_binary_describes_the_typescript_generator() {
    let Response::Describe(d) = run(&Request::describe()) else { panic!("not a Describe") };
    let mut ids: Vec<&str> = d.languages.iter().map(|l| l.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, ["ts", "typescript"]);
    assert!(d.languages.iter().all(|l| l.versions.floor == VERSIONS.floor));
}

#[test]
fn the_ts_alias_generates_the_same() {
    let fx = corpus().into_iter().next().unwrap();
    let mut req = request(&fx, VERSIONS.floor);
    let expected = generate_typescript(&req).unwrap().into_iter().map(FileOut::from).collect::<Vec<_>>();
    req.target.language = "ts".into();
    let Response::Generate(generated) = run(&Request::generate(req)) else { panic!("not a Generate") };
    assert_eq!(generated.files, expected);
}
