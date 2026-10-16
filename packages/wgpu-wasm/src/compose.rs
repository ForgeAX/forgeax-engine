// packages/wgpu-wasm/src/compose.rs — naga_oil 0.22 composition wasm-bindgen surface.
//
// Single entry point `compose_shader(entry_source, imports_json, defines_json)`
// exposed to JS via #[wasm_bindgen] per plan-strategy D-01 (Rust-side composer)
// + D-02 (naga_oil default-features=false).
//
// Contract (T-02 green phase populates the body; T-03 stub keeps this file
// compiling while the tests below are already in place for the red phase):
//   - `imports_json` — JSON object `{ "<module_name>": "<wgsl source>", ... }`.
//     Each value is raw WGSL whose first line must be `#define_import_path <module_name>`.
//   - `defines_json` — JSON object `{ "<DEF_NAME>": <bool>, ... }`. Only Bool
//     values are accepted; other value types trigger `shader-compile-failed`.
//   - Return (Ok) — composed WGSL source string (serialised via
//     `naga::back::wgsl::write_string` from the `naga::Module` that
//     `naga_oil::compose::Composer::make_naga_module` emits).
//   - Return (Err) — `JsError` whose message carries a structured prefix:
//       * `shader-import-not-found: <detail>` for `ImportNotFound` variants
//       * `shader-compile-failed: <detail>` for all other variants plus JSON
//         parse / naga writeback failures. The JS / TS shim in M3 will split
//         this prefix into a discriminated-union `ShaderError` with
//         `.code` / `.detail` fields.
//
// Test-side fixtures at the bottom exercise two scenarios (T-03):
//   1. happy path — `#import` resolution of a trivial helper + `#ifdef` bool
//   2. import-not-found — entry references an unregistered module id.

use std::collections::HashMap;

use naga_oil::compose::{
    ComposableModuleDescriptor, Composer, ComposerError, ComposerErrorInner, NagaModuleDescriptor,
    ShaderDefValue, ShaderLanguage,
};
use serde_json::Value as JsonValue;
use wasm_bindgen::prelude::*;

/// Compose a WGSL shader via naga_oil and serialise the composed naga module
/// back to WGSL text (plan-strategy D-01 Rust-side composer).
#[wasm_bindgen]
pub fn compose_shader(
    entry_source: &str,
    imports_json: &str,
    defines_json: &str,
) -> Result<String, JsError> {
    let imports = parse_imports_json(imports_json)?;
    let shader_defs = parse_defines_json(defines_json)?;

    // Composition validates source capability, not the eventual GPU device.
    // Match the final validator below; runtime device admission stays in RHI.
    let mut composer = Composer::default();
    composer.capabilities = naga::valid::Capabilities::all();

    // naga_oil 0.22's `add_composable_module` rejects a module whose `#import`
    // targets are not yet registered with the composer. The `imports` map
    // crosses the JSON boundary as a `serde_json::Map<String, Value>` which
    // defaults to a `BTreeMap` -- iteration is alphabetical, NOT topological.
    // When module A imports module B and A sorts before B (e.g. `ibl_sampling`
    // < `ibl_shared`), the naive single-pass loop fails with
    // `shader-import-not-found` for B even though B is present in the map.
    // Fix: fixed-point iteration -- on each pass, retry every still-pending
    // module; modules whose deps are now satisfied succeed and are removed
    // from the pending set. The loop converges in O(depth) passes (depth =
    // length of the longest #import chain). If a full pass makes zero
    // progress, the remaining failures are genuine errors and we surface the
    // first one (which preserves the legacy shader-import-not-found contract
    // when an import target truly is absent from the map).
    let mut pending: Vec<(String, String)> =
        imports.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    while !pending.is_empty() {
        let mut next_pending: Vec<(String, String)> = Vec::new();
        let mut last_err: Option<ComposerError> = None;
        let progress_before = pending.len();
        for (module_name, source) in pending.drain(..) {
            match composer.add_composable_module(ComposableModuleDescriptor {
                source: &source,
                file_path: &module_name,
                language: ShaderLanguage::Wgsl,
                as_name: None,
                additional_imports: &[],
                shader_defs: shader_defs.clone(),
            }) {
                Ok(_) => {}
                Err(e) => {
                    last_err = Some(e);
                    next_pending.push((module_name, source));
                }
            }
        }
        if next_pending.len() == progress_before {
            // No progress this pass -- surface the first error.
            if let Some(e) = last_err {
                return Err(js_error_from_composer_err(e));
            }
            break;
        }
        pending = next_pending;
    }

    let module = composer
        .make_naga_module(NagaModuleDescriptor {
            source: entry_source,
            file_path: "<entry>",
            shader_defs: shader_defs.clone(),
            ..Default::default()
        })
        .map_err(js_error_from_composer_err)?;

    // naga::back::wgsl::write_string wants a validated ModuleInfo.
    let info = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .map_err(|e| {
        JsError::new(&format!(
            "shader-compile-failed: final module validation failed: {e}"
        ))
    })?;

    naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty()).map_err(
        |e| JsError::new(&format!("shader-compile-failed: wgsl writeback failed: {e}")),
    )
}

fn parse_imports_json(raw: &str) -> Result<HashMap<String, String>, JsError> {
    let value: JsonValue = serde_json::from_str(raw)
        .map_err(|e| JsError::new(&format!("shader-compile-failed: imports_json parse: {e}")))?;
    let obj = value
        .as_object()
        .ok_or_else(|| JsError::new("shader-compile-failed: imports_json must be a JSON object"))?;
    let mut out = HashMap::with_capacity(obj.len());
    for (k, v) in obj {
        let s = v.as_str().ok_or_else(|| {
            JsError::new(&format!(
                "shader-compile-failed: imports_json['{k}'] must be a string"
            ))
        })?;
        out.insert(k.clone(), s.to_owned());
    }
    Ok(out)
}

fn parse_defines_json(raw: &str) -> Result<HashMap<String, ShaderDefValue>, JsError> {
    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let value: JsonValue = serde_json::from_str(raw)
        .map_err(|e| JsError::new(&format!("shader-compile-failed: defines_json parse: {e}")))?;
    let obj = value
        .as_object()
        .ok_or_else(|| JsError::new("shader-compile-failed: defines_json must be a JSON object"))?;
    let mut out = HashMap::with_capacity(obj.len());
    for (k, v) in obj {
        let def = match v {
            JsonValue::Bool(b) => ShaderDefValue::Bool(*b),
            _ => {
                return Err(JsError::new(&format!(
                    "shader-compile-failed: defines_json['{k}'] must be a boolean"
                )));
            }
        };
        out.insert(k.clone(), def);
    }
    Ok(out)
}

fn js_error_from_composer_err(err: ComposerError) -> JsError {
    let prefix = match &err.inner {
        ComposerErrorInner::ImportNotFound(_, _) => "shader-import-not-found",
        _ => "shader-compile-failed",
    };
    JsError::new(&format!("{prefix}: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_node_experimental);

    #[wasm_bindgen_test]
    fn compose_shader_imports_and_ifdef() {
        let entry = r#"
#import mod_a::foo_fn

#ifdef USE_VEC
@vertex
fn main() -> @builtin(position) vec4<f32> {
    foo_fn();
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
#else
@vertex
fn main() -> @builtin(position) vec4<f32> {
    foo_fn();
    return vec4<f32>(0.0, 1.0, 0.0, 1.0);
}
#endif
"#;

        let helper = r#"#define_import_path mod_a
fn foo_fn() {}
"#;

        let imports_json = serde_json::json!({ "mod_a": helper }).to_string();
        let defines_json = serde_json::json!({ "USE_VEC": true }).to_string();

        let composed = compose_shader(entry, &imports_json, &defines_json)
            .unwrap_or_else(|e| panic!("expected Ok, got Err: {:?}", e));
        assert!(
            composed.contains("foo_fn"),
            "composed output should reference the imported helper; got:\n{composed}"
        );
        assert!(
            composed.contains("1f") || composed.contains("1.0"),
            "USE_VEC=true branch should be selected; got:\n{composed}"
        );
    }

    #[wasm_bindgen_test]
    fn compose_shader_import_not_found() {
        let entry = r#"
#import missing_mod::bar_fn

@vertex
fn main() -> @builtin(position) vec4<f32> {
    bar_fn();
    return vec4<f32>(0.0);
}
"#;
        let imports_json = "{}";
        let defines_json = "{}";

        let err = compose_shader(entry, imports_json, defines_json)
            .err()
            .expect("compose_shader must error when #import target is absent");
        let msg = format!("{:?}", err);
        assert!(
            msg.contains("shader-import-not-found"),
            "expected shader-import-not-found prefix in error message, got: {msg}"
        );
    }
}
