//! The TypeScript generator as its own process: one CBOR `Request` on stdin,
//! one CBOR `Response` on stdout. The same generator the CLI links, behind
//! the generator protocol, so it also builds for `wasm32-wasip1`.

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut registry = comline_codegen::Registry::new();
    comline_codegen_typescript::register(&mut registry);
    comline_codegen::protocol::serve_stdio(&registry)
}
