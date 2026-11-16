//! The conformance corpus (`comline-conformance`, in ComlineProject/generation)
//! run over this generator: its output for every fixture, at each of its
//! version boundaries, against the goldens under `tests/golden/`; the
//! generator protocol round trip; and the proof of every claim in `SUPPORT`,
//! with the report `FEATURES.md` and `features.json` at the repository root.
//! Regenerate the goldens and the report with:
//!
//! ```text
//! CONFORMANCE_BLESS=1 cargo test -p comline-codegen-typescript --test conformance
//! ```
//!
//! A blessed golden is a snapshot of what the generator does now: a diff in
//! one is a change to what it emits, to be read as one.

use std::path::Path;

use comline_conformance::harness::{self, Generator};

const GENERATOR: Generator = Generator {
    language: "typescript",
    generate: comline_codegen_typescript::generate_typescript,
    register: comline_codegen_typescript::register,
    support: comline_codegen_typescript::SUPPORT,
    versions: comline_codegen_typescript::VERSIONS,
};

#[test]
fn the_protocol_generates_what_the_generator_does() {
    harness::the_protocol_generates_what_the_generator_does(&GENERATOR);
}

#[test]
fn corpus_matches_golden() {
    harness::corpus_matches_golden(
        &GENERATOR,
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden"),
    );
}

#[test]
fn support_is_proven() {
    harness::support_is_proven(
        &GENERATOR,
        &Path::new(env!("CARGO_MANIFEST_DIR")).join(".."),
    );
}
