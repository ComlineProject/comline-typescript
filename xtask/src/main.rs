//! Regenerates `std-extra/` — the `@comline/std` package — from Comline's
//! real `std` schemas, by running the same `generate_typescript` every
//! consumer's `comline generate -m lib` call goes through, so the package is
//! never hand-edited, only regenerated.
//!
//! `cargo run -p xtask` writes it; `cargo run -p xtask -- --check` diffs
//! instead and exits non-zero on drift (the CI guard).
//!
//! Unlike comline-rust's equivalent there is no pin to check. `comline_std`
//! is reached by git rev, so regenerating it and repointing that rev are two
//! commits and need two guards; `@comline/std` is reached by semver range
//! (npm can't install from a repository subdirectory), so a regeneration is
//! self-contained.

use std::fs;
use std::path::PathBuf;

use comline_codegen::{GenRequest, Mode, PackageMeta};
use comline_codegen_typescript::generate_typescript;
use comline_core::package::build::PackageSources;
use comline_core::package::stdlib;
use comline_core::schema::ir::frozen::unit::FrozenUnit;

/// The version `@comline/std` publishes as. Must match the range the
/// generator declares for it (`STD_VERSION` in `codegen/src/generator.rs`),
/// or a consumer's generated manifest asks for something that doesn't exist.
const STD_PACKAGE_VERSION: &str = "0.1.0";

fn main() -> eyre::Result<()> {
    let check = std::env::args().any(|a| a == "--check");

    // std's own real manifest (`congregation std`) - compiling it standalone
    // means every schema's own namespace comes out prefixed with that
    // congregation name (`["std", "http"]`), same as any package's own
    // schemas would be under its own name. Strip that leading segment:
    // `@comline/std` is its own package root, so a consumer imports from
    // `@comline/std/http`, not `@comline/std/std/http`.
    let mut sources = PackageSources::new().config(stdlib::manifest());
    for (namespace, source) in stdlib::schemas() {
        sources = sources.schema(namespace, source);
    }
    let context = sources.compile()?;

    let schemas: Vec<(String, Vec<FrozenUnit>)> = context
        .schema_contexts
        .iter()
        .filter_map(|sc| {
            let sc = sc.borrow();
            let units = sc.frozen_schema.borrow().clone()?;
            let rest = match sc.namespace.split_first() {
                Some((first, rest)) if first == "std" => rest,
                _ => &sc.namespace[..],
            };
            Some((rest.join("/"), units))
        })
        .collect();

    let req = GenRequest {
        mode: Mode::Lib,
        schemas: &schemas,
        package: PackageMeta {
            name: "@comline/std".to_string(),
            version: STD_PACKAGE_VERSION.to_string(),
        },
        // The one generator this repo registers, so the version it registers
        // under is the one `@comline/std`'s own manifest states.
        lang_version: comline_codegen_typescript::LANG_VERSION.to_string(),
        default_framing: None,
        // `@comline/std` *is* std, generated as an ordinary standalone
        // package - `external_std` only matters to a consumer referencing
        // std, not to std's own generation.
        external_std: false,
    };

    let files = generate_typescript(&req)?;

    let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../std-extra");
    let mut drift = false;

    for file in &files {
        let path = out_dir.join(&file.path);
        if check {
            let existing = fs::read_to_string(&path).unwrap_or_default();
            if existing != file.contents {
                eprintln!("drift: {}", path.display());
                drift = true;
            }
        } else {
            fs::create_dir_all(path.parent().unwrap())?;
            fs::write(&path, &file.contents)?;
            println!("wrote {}", path.display());
        }
    }

    if check && drift {
        eprintln!("std-extra/ is out of date - run `cargo run -p xtask` to regenerate it");
        std::process::exit(1);
    }

    Ok(())
}
