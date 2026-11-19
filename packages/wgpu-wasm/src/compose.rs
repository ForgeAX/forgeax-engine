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

use std::cell::RefCell;
use std::collections::HashMap;

use crate::naga::write_checked_wgsl_with_transform;
use naga_oil::compose::{
    comment_strip_iter::CommentReplaceExt,
    preprocess::Preprocessor,
    tokenizer::{Token, Tokenizer},
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
    normalize: Option<js_sys::Function>,
) -> Result<String, JsError> {
    let imports = parse_imports_json(imports_json)?;
    let shader_defs = parse_defines_json(defines_json)?;

    // Only definition-independent imports can retain compiled imported IR.
    // Entry IR is always rebuilt and validated. Auto bindings have a mutable
    // allocation counter, so those requests always use a fresh Composer.
    let automatic_bindings = entry_source.contains("@binding(auto)")
        || imports
            .values()
            .any(|source| source.contains("@binding(auto)"));
    let previous = if automatic_bindings || imports_json.len() > 2 * 1024 * 1024 {
        None
    } else {
        IMPORT_COMPOSER.with(|slot| slot.borrow_mut().take())
    };
    let independent = !automatic_bindings
        && imports_json.len() <= 2 * 1024 * 1024
        && IMPORT_PREFLIGHT.with(|preprocessor| {
            imports.iter().all(|(name, source)| {
                previous
                    .as_ref()
                    .is_some_and(|cached| cached.imports.get(name) == Some(source))
                    || preprocessor
                        .get_preprocessor_metadata(source, false)
                        .is_ok_and(|metadata| {
                            metadata.name.as_ref() == Some(name)
                                && metadata.effective_defs.is_empty()
                                && metadata.defines.is_empty()
                        })
            })
        });
    let mut composer = if independent {
        previous
            .map(|cached| retain_import_prefix(cached, &imports))
            .unwrap_or_else(fresh_composer)
    } else {
        fresh_composer()
    };
    let registered = !composer.module_sets.is_empty();
    if registered {
        // Registration pins supplied definitions into each module. Independent
        // imported IR cannot read them, but entry conflict admission still must
        // see this request's exact map, including removed or changed names.
        for module in composer.module_sets.values_mut() {
            module.shader_defs = shader_defs.clone();
        }
    }
    let result = compose_with_imports(
        &mut composer,
        entry_source,
        &imports,
        &shader_defs,
        normalize.as_ref(),
    );
    if result.is_ok() && independent {
        // Definition maps are request inputs, not dependencies of retained IR.
        for module in composer.module_sets.values_mut() {
            module.shader_defs = HashMap::new();
        }
        IMPORT_COMPOSER.with(|slot| {
            *slot.borrow_mut() = Some(ImportComposer { imports, composer });
        });
    }
    result
}

struct ImportComposer {
    imports: HashMap<String, String>,
    composer: Composer,
}

fn fresh_composer() -> Composer {
    let mut composer = Composer::default();
    composer.capabilities = naga::valid::Capabilities::all();
    composer
}

fn retain_import_prefix(mut cached: ImportComposer, imports: &HashMap<String, String>) -> Composer {
    // Naga Oil assigns spans by registration index. Retain only the unchanged
    // prefix: replacing a hole would reuse a surviving module's span index.
    // Dependencies register first, so removing the suffix cannot invalidate a
    // retained prefix module. Re-added modules receive the original contiguous
    // index sequence; native validation and source diagnostics stay unchanged.
    let first_changed = cached
        .composer
        .module_index
        .iter()
        .filter(|(_, name)| cached.imports.get(*name) != imports.get(*name))
        .map(|(index, _)| *index)
        .min()
        .unwrap_or(cached.composer.module_sets.len() + 1);
    let removed: Vec<String> = cached
        .composer
        .module_index
        .iter()
        .filter(|(index, _)| **index >= first_changed)
        .map(|(_, name)| name.clone())
        .collect();
    for name in removed {
        cached.composer.remove_composable_module(&name);
    }
    cached
        .composer
        .module_index
        .retain(|index, _| *index < first_changed);
    let retained = cached.composer.module_sets.len();
    if retained + 1 != first_changed
        || cached.composer.module_index.len() != retained
        || cached.composer.module_index.iter().any(|(index, name)| {
            *index == 0 || *index > retained || !cached.composer.module_sets.contains_key(name)
        })
    {
        return fresh_composer();
    }
    cached.composer
}

thread_local! {
    // One bounded source closure and its stable registration prefix. Each
    // independent imported module retains one IR selection; entries stay fresh.
    static IMPORT_COMPOSER: RefCell<Option<ImportComposer>> = RefCell::default();
    // Immutable regular expressions; source/definitions remain per request.
    static IMPORT_PREFLIGHT: Preprocessor = Preprocessor::default();
}

fn compose_with_imports(
    composer: &mut Composer,
    entry_source: &str,
    imports: &HashMap<String, String>,
    shader_defs: &HashMap<String, ShaderDefValue>,
    normalize: Option<&js_sys::Function>,
) -> Result<String, JsError> {
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
    let mut pending: Vec<(String, String)> = imports
        .iter()
        .filter(|(name, _)| !composer.module_sets.contains_key(*name))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
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

    IMPORT_PREFLIGHT.with(|preprocessor| {
        reject_imported_padding(preprocessor, composer, entry_source, shader_defs)
    })?;

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

    write_checked_wgsl_with_transform(&module, &info, normalize)
        .map_err(|error| JsError::new(&format!("shader-compile-failed: {error}")))
}

/// Naga Oil's imported-module writer currently drops explicit member padding
/// attributes while converting imported WGSL through its generated header.
/// Use the same public preprocessor that will select those imports/branches,
/// then reject the active attribute tokens before that lossy writer runs.
///
/// This boundary intentionally does not parse attribute arguments or derive
/// buffer layout. The checked WGSL writer below remains the sole layout guard
/// for the final Naga module.
fn reject_imported_padding(
    preprocessor: &Preprocessor,
    composer: &Composer,
    entry_source: &str,
    option_defs: &HashMap<String, ShaderDefValue>,
) -> Result<(), JsError> {
    let entry_metadata = preprocessor
        .get_preprocessor_metadata(entry_source, true)
        .map_err(|error| {
            JsError::new(&format!(
                "shader-compile-failed: naga-oil-import-layout-admission could not inspect entry defines: {error:?}"
            ))
        })?;

    // make_naga_module extends option definitions with entry-source defines,
    // then merges each selected imported module's definition map and rejects
    // conflicts. Mirror those exact merge rules for the preflight token view.
    let mut effective_defs = option_defs.clone();
    effective_defs.extend(entry_metadata.defines);
    let mut module_names: Vec<_> = composer.module_sets.keys().collect();
    module_names.sort();
    for module_name in &module_names {
        let Some(module) = composer.module_sets.get(*module_name) else {
            continue;
        };
        let mut definition_names: Vec<_> = module.shader_defs.keys().collect();
        definition_names.sort();
        for define_name in definition_names {
            let Some(value) = module.shader_defs.get(define_name) else {
                continue;
            };
            if effective_defs
                .get(define_name)
                .is_some_and(|previous| previous != value)
            {
                return Err(JsError::new(&format!(
                    "shader-compile-failed: naga-oil-import-layout-admission found inconsistent shader definition '{define_name}' while merging imported module '{module_name}'"
                )));
            }
            effective_defs.insert(define_name.clone(), *value);
        }
    }

    for module_name in module_names {
        let Some(module) = composer.module_sets.get(module_name) else {
            continue;
        };
        // Directives can separate an attribute's @ from its name. Only skip
        // preprocessing when no padding-name token exists at all; conditional
        // selection cannot introduce one. Selected modules still validate axes.
        if !may_contain_padding_attribute(&module.sanitized_source) {
            continue;
        }
        let preprocessed = preprocessor
            .preprocess(&module.sanitized_source, &effective_defs)
            .map_err(|error| {
                JsError::new(&format!(
                    "shader-compile-failed: naga-oil-import-layout-admission could not preprocess imported module '{module_name}': {error:?}"
                ))
            })?;
        if let Some(attribute) = imported_padding_attribute(&preprocessed.preprocessed_source) {
            return Err(JsError::new(&format!(
                "shader-compile-failed: naga-oil-import-layout-admission rejected active @{attribute} in imported module '{module_name}'; the Naga Oil imported-WGSL writer drops custom member-padding metadata, so this path cannot guarantee the buffer ABI. Use a naturally laid-out WGSL buffer whose host ABI matches Naga's reflected layout, or a writer that preserves the reflected padding. No shader artifact was emitted."
            )));
        }
    }

    Ok(())
}

// Classification is independent of shader definitions. Keep a bounded cache of
// complete source strings, never preprocessed text or an admitted shader result.
// Each WASM instance owns its cache; eviction only repeats the same token scan.
#[derive(Default)]
struct PaddingCandidates {
    sources: HashMap<String, bool>,
    bytes: usize,
}

impl PaddingCandidates {
    fn inspect(&mut self, source: &str) -> bool {
        if !source.contains('@') || (!source.contains("align") && !source.contains("size")) {
            return false;
        }
        if let Some(candidate) = self.sources.get(source) {
            return *candidate;
        }
        let mut lines = source.lines();
        let active_source = lines.replace_comments().collect::<Vec<_>>().join("\n");
        let candidate = Tokenizer::new(&active_source, false)
            .any(|token| matches!(token, Token::Identifier("align" | "size", _)));
        const LIMIT: usize = 2 * 1024 * 1024;
        const ENTRIES: usize = 256;
        if source.len() <= LIMIT {
            if self.bytes + source.len() > LIMIT || self.sources.len() >= ENTRIES {
                self.sources.clear();
                self.bytes = 0;
            }
            self.bytes += source.len();
            self.sources.insert(source.to_owned(), candidate);
        }
        candidate
    }
}

thread_local! {
    static PADDING_CANDIDATES: RefCell<PaddingCandidates> = RefCell::default();
}

fn may_contain_padding_attribute(source: &str) -> bool {
    PADDING_CANDIDATES.with(|cache| cache.borrow_mut().inspect(source))
}

fn imported_padding_attribute(source: &str) -> Option<&'static str> {
    let mut lines = source.lines();
    let active_source = lines.replace_comments().collect::<Vec<_>>().join("\n");
    let mut tokens = Tokenizer::new(&active_source, false).peekable();
    while let Some(token) = tokens.next() {
        if !matches!(token, Token::Other('@', _)) {
            continue;
        }
        match tokens.next() {
            Some(Token::Identifier("align", _)) => return Some("align"),
            Some(Token::Identifier("size", _)) => return Some("size"),
            _ => {}
        }
    }
    None
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

        let composed = compose_shader(entry, &imports_json, &defines_json, None)
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

        let err = compose_shader(entry, imports_json, defines_json, None)
            .err()
            .expect("compose_shader must error when #import target is absent");
        let msg = format!("{:?}", err);
        assert!(
            msg.contains("shader-import-not-found"),
            "expected shader-import-not-found prefix in error message, got: {msg}"
        );
    }
}
