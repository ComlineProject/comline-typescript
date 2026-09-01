use comline_codegen::{GenRequest, Mode, PackageMeta};
use comline_codegen_typescript::generate_typescript;
use comline_core::schema::ir::frozen::unit::{FrozenUnit, FrozenArgument};
use comline_core::schema::ir::compiler::interpreted::kind_search::{KindValue, Primitive};

fn code_req(schemas: &[(String, Vec<FrozenUnit>)]) -> GenRequest<'_> {
    GenRequest {
        mode: Mode::Code,
        schemas,
        package: PackageMeta { name: "test".into(), version: "0.1.0".into() },
    }
}

fn lib_req(schemas: &[(String, Vec<FrozenUnit>)]) -> GenRequest<'_> {
    GenRequest {
        mode: Mode::Lib,
        schemas,
        package: PackageMeta { name: "chat".into(), version: "0.3.0".into() },
    }
}

fn one(units: Vec<FrozenUnit>) -> String {
    let schemas = vec![("account".to_string(), units)];
    let mut files = generate_typescript(&code_req(&schemas)).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path.to_str().unwrap(), "account.ts");
    files.remove(0).contents
}

#[test]
fn interface_from_struct() {
    let out = one(vec![FrozenUnit::Struct {
        docstring: None,
        parameters: vec![],
        name: "User".to_string(),
        fields: vec![
            FrozenUnit::Field {
                docstring: None,
                parameters: vec![],
                optional: false,
                name: "id".to_string(),
                kind_value: KindValue::Namespaced("s32".to_string(), None),
                span: (0, 0),
            },
            FrozenUnit::Field {
                docstring: None,
                parameters: vec![],
                optional: false,
                name: "username".to_string(),
                kind_value: KindValue::Namespaced("string".to_string(), None),
                span: (0, 0),
            },
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

#[test]
fn interface_from_protocol() {
    let out = one(vec![FrozenUnit::Protocol {
        docstring: "A user service".to_string(),
        name: "UserService".to_string(),
        parameters: vec![],
        functions: vec![
            FrozenUnit::Function {
                docstring: String::new(),
                name: "get_user".to_string(),
                synchronous: true,
                arguments: vec![FrozenArgument {
                    name: "id".to_string(),
                    kind: KindValue::Primitive(Primitive::S32(None)),
                    span: (0, 0),
                }],
                _return: Some(KindValue::Namespaced("User".to_string(), None)),
                throws: vec![],
                span: (0, 0),
            },
            FrozenUnit::Function {
                docstring: String::new(),
                name: "ping".to_string(),
                synchronous: true,
                arguments: vec![],
                _return: None,
                throws: vec![],
                span: (0, 0),
            },
        ],
        span: (0, 0),
    }]);

    assert!(out.contains("export interface UserService {"));
    assert!(out.contains("get_user(id: number): User;"));
    assert!(out.contains("ping(): void;"));
}

#[test]
fn lib_mode_is_not_implemented() {
    let schemas = vec![("account".to_string(), vec![])];
    let err = generate_typescript(&lib_req(&schemas)).unwrap_err().to_string();
    assert!(err.contains("lib mode"));
}
