//! Schema names as TypeScript identifiers.
//!
//! Core accepts any name the IDL can spell, and some are words TypeScript
//! won't take as the name of a declaration: `class`, `delete` and `new` are
//! reserved, `interface`, `let` and `static` are reserved in a module (which
//! every generated file is), and `number` or `object` can't name a type. A
//! declaration's name becomes an identifier wherever it's declared, referred
//! to or imported, so each such word takes a trailing underscore there:
//! `struct function` is `export interface function_`.
//!
//! What goes on the wire doesn't change: a field, an enum variant and a
//! function are property names, which can be any word, and an error's or a
//! method's wire name is a string.

/// Words TypeScript refuses as the name of a declared type or value, as
/// `tsc` reports them under the floor's strictest flags.
const RESERVED: &[&str] = &[
    // reserved words
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
    "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null",
    "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
    // reserved in strict mode, which a module always is, and in a module
    "implements", "interface", "let", "package", "private", "protected", "public", "static", "yield", "await",
    // not bindable in strict mode
    "arguments", "eval",
    // the names of TypeScript's own types
    "any", "unknown", "never", "number", "bigint", "boolean", "string", "symbol", "object", "undefined",
    // type operators, which can't be read as a type's name
    "keyof", "readonly", "unique", "infer", "as",
];

/// `name` as a TypeScript identifier for a declaration: itself, or with a
/// trailing underscore when TypeScript reserves it.
pub fn ident(name: &str) -> String {
    if is_reserved(name) {
        format!("{name}_")
    } else {
        name.to_string()
    }
}

/// A function's name as the method generated for it: on the provider
/// interface, and on the sender or client that calls it. `then` would make
/// either thenable (`await` would call it), `constructor` is the class's
/// own, and `peer` and `client` are the fields the sender and the client
/// hold. Each takes a trailing underscore; the name a call sends doesn't
/// change.
pub fn method_ident(name: &str) -> String {
    if ["then", "constructor", "peer", "client"].contains(&name) {
        format!("{name}_")
    } else {
        name.to_string()
    }
}

/// Whether `name` needs [`ident`]'s underscore.
pub fn is_reserved(name: &str) -> bool {
    RESERVED.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reserved_word_takes_an_underscore_and_others_are_kept() {
        assert_eq!(ident("class"), "class_");
        assert_eq!(ident("interface"), "interface_");
        assert_eq!(ident("number"), "number_");
        assert_eq!(ident("Message"), "Message");
        // Contextual keywords are fine as names.
        assert_eq!(ident("type"), "type");
        assert_eq!(ident("async"), "async");
    }
}
