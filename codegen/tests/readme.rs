//! The README's feature section is rendered from [`comline_codegen_typescript::SUPPORT`], so it
//! can't drift from what the generator claims. Rewrite it with:
//!
//! ```text
//! FEATURES_BLESS=1 cargo test -p comline-codegen-typescript --test readme
//! ```

use std::collections::BTreeMap;
use std::path::Path;

use comline_codegen::features::{markdown, Column};

const START: &str = "<!-- features:start -->";
const END: &str = "<!-- features:end -->";

#[test]
fn readme_features_match_the_support_table() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../README.md");
    let readme = std::fs::read_to_string(&path).unwrap();
    let table = markdown(
        &[Column { generator: "typescript", version: comline_codegen_typescript::LANG_VERSION, support: comline_codegen_typescript::SUPPORT }],
        &BTreeMap::new(),
    );
    let section = format!(
        "{START}\n<!-- Generated from `SUPPORT` in `codegen/src/lib.rs` - don't edit by hand. -->\n\n{table}\n{END}"
    );

    let start = readme.find(START).expect("the README has a features section");
    let end = readme.find(END).expect("the features section is closed") + END.len();
    if readme[start..end] == section {
        return;
    }
    if std::env::var_os("FEATURES_BLESS").is_some() {
        std::fs::write(&path, format!("{}{section}{}", &readme[..start], &readme[end..])).unwrap();
        return;
    }
    panic!("README's feature section is out of date - run with FEATURES_BLESS=1");
}
