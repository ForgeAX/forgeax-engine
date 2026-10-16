// packages/wgpu-wasm/src/naga.rs — three-phase wasm-bindgen exports.
//
// Byte-for-byte equivalent of the lib.rs in the legacy naga wasm-pack shim
// crate (feat-20260508-shader-pipeline-mvp + plan-strategy §S-1 + research
// Finding 6; that crate was deleted in feat-20260511-naga-rhi-wgpu-merge M5)
// — moved here so the merged @forgeax/engine-wgpu-wasm crate produces a single wasm
// artefact sharing the naga 30 instance with the wgpu rhi surface (research
// F-2 Cargo dedup).
//
// Shape invariants (unchanged from the legacy archived crate):
// - Single concern per export: parse / validate / emit_reflection each map to one naga
//   library phase (wgsl::parse_str / Validator::validate / in-house reflection derivation).
// - Error pass-through: Rust-side Result<T, JsValue> → JS-side catch reads .lineNum /
//   .linePos / .message directly (the JS-side ShaderError factory consumes these fields,
//   see plan-strategy §S-7).
// - Opaque handles: ParsedModule / ValidatedModule are wasm-bindgen exported structs,
//   so JS can only hold a handle — it cannot inspect naga IR fields directly
//   (charter proposition 4 + opaque handle invariant).
// - Reflection is fully explicit: emit_reflection emits a JSON with every field present
//   (hasDynamicOffset / minBindingSize defaults written out), and the visibility field
//   is an integer bitmask (plan-strategy §S-9 / D-R9).

use naga::valid::{Capabilities, GlobalUse, ModuleInfo, ValidationFlags, Validator};
use naga::{
    AddressSpace, Binding, Expression, Handle, ImageClass, ImageDimension, Module, SampleLevel,
    Scalar, ScalarKind, ShaderStage, StorageAccess, StorageFormat, TypeInner, VectorSize,
};
use serde::{Deserialize, Serialize};
use serde_json;
use wasm_bindgen::prelude::*;

// === Three-phase export handles ====================================================

/// Handle for the `parse` output. JS holds an opaque struct it cannot inspect; the
/// only legal next move is to feed it into `validate` (plan-strategy §S-1 opaque handle).
#[wasm_bindgen]
pub struct ParsedModule {
    module: Module,
}

/// Handle for the `validate` output. Carries both Module and ModuleInfo; passed into
/// `emit_reflection`.
#[wasm_bindgen]
pub struct ValidatedModule {
    module: Module,
    info: ModuleInfo,
}

// === Phase 1: parse ================================================================

/// WGSL source -> `naga::Module`. On failure throws a `JsError` whose payload carries
/// `message` / `line_num` / `line_pos`.
#[wasm_bindgen]
pub fn parse(source: &str) -> Result<ParsedModule, JsError> {
    match naga::front::wgsl::parse_str(source) {
        Ok(module) => Ok(ParsedModule { module }),
        Err(err) => {
            let loc = err.location(source);
            let summary = err.emit_to_string(source);
            let payload = ParseErrorPayload {
                message: err.message().to_string(),
                summary,
                line_num: loc.as_ref().map(|l| l.line_number),
                line_pos: loc.as_ref().map(|l| l.line_position),
            };
            Err(JsError::new(&serde_json::to_string(&payload).unwrap_or_else(|_| "parse failed".into())))
        }
    }
}

#[derive(Serialize, Deserialize)]
struct ParseErrorPayload {
    message: String,
    summary: String,
    line_num: Option<u32>,
    line_pos: Option<u32>,
}

// === Phase 2: validate =============================================================

/// `naga::Module` -> `ModuleInfo`. On failure throws a `JsError` whose message is the
/// validator's prose diagnostic (no source position is attached).
#[wasm_bindgen]
pub fn validate(parsed: ParsedModule) -> Result<ValidatedModule, JsError> {
    let mut validator = Validator::new(ValidationFlags::all(), Capabilities::all());
    match validator.validate(&parsed.module) {
        Ok(info) => Ok(ValidatedModule {
            module: parsed.module,
            info,
        }),
        Err(err) => Err(JsError::new(&format!("validate failed: {err}"))),
    }
}

// === Phase 3: emit_reflection ======================================================

/// Validate the selected graphics stages, rather than merely the whole module.
#[wasm_bindgen]
pub fn validate_render_entries(
    validated: &ValidatedModule,
    vertex: &str,
    fragment: Option<String>,
    color_formats: Option<String>,
) -> Result<(), JsError> {
    let module = &validated.module;
    let vertex_entry = module.entry_points.iter()
        .find(|entry| entry.name == vertex && entry.stage == ShaderStage::Vertex)
        .ok_or_else(|| JsError::new(&format!("vertex entry '{vertex}' does not exist")))?;
    let Some(fragment) = fragment else { return Ok(()) };
    let fragment_entry = module.entry_points.iter()
        .find(|entry| entry.name == fragment && entry.stage == ShaderStage::Fragment)
        .ok_or_else(|| JsError::new(&format!("fragment entry '{fragment}' does not exist")))?;
    if let Some(formats_json) = color_formats {
        let formats: Vec<String> = serde_json::from_str(&formats_json)
            .map_err(|e| JsError::new(&format!("invalid color formats: {e}")))?;
        let mut colors = Vec::new();
        if let Some(result) = &fragment_entry.function.result {
            collect_stage_locations(module, result.ty, result.binding.as_ref(), &mut colors);
        }
        if colors.len() != formats.len() {
            return Err(JsError::new("material output count differs from selected fragment outputs"));
        }
        for (index, format) in formats.iter().enumerate() {
            let (_, ty, _) = colors.iter().find(|(location, _, _)| *location == index as u32)
                .ok_or_else(|| JsError::new(&format!("missing fragment output @location({index})")))?;
            let scalar = match module.types[*ty].inner {
                TypeInner::Scalar(scalar) | TypeInner::Vector { scalar, .. } => scalar,
                _ => return Err(JsError::new("fragment output must be scalar or vector")),
            };
            let expected = if format.ends_with("uint") { naga::ScalarKind::Uint }
                else if format.ends_with("sint") { naga::ScalarKind::Sint }
                else { naga::ScalarKind::Float };
            if scalar.kind != expected {
                return Err(JsError::new(&format!("fragment output @location({index}) is incompatible with {format}")));
            }
        }
    }
    let mut outputs = Vec::new();
    if let Some(result) = &vertex_entry.function.result {
        collect_stage_locations(module, result.ty, result.binding.as_ref(), &mut outputs);
    }
    let mut inputs = Vec::new();
    for argument in &fragment_entry.function.arguments {
        collect_stage_locations(module, argument.ty, argument.binding.as_ref(), &mut inputs);
    }
    for (location, ty, binding) in inputs {
        let compatible = outputs.iter().any(|(output_location, output_ty, output_binding)| {
            *output_location == location
                && module.types[*output_ty].inner == module.types[ty].inner
                && *output_binding == binding
        });
        if !compatible {
            return Err(JsError::new(&format!(
                "fragment entry '{fragment}' input @location({location}) has no compatible output from vertex entry '{vertex}'"
            )));
        }
    }
    Ok(())
}

fn collect_stage_locations<'a>(
    module: &'a Module,
    ty: Handle<naga::Type>,
    binding: Option<&'a Binding>,
    locations: &mut Vec<(u32, Handle<naga::Type>, &'a Binding)>,
) {
    if let Some(binding @ Binding::Location { location, .. }) = binding {
        locations.push((*location, ty, binding));
    } else if let TypeInner::Struct { members, .. } = &module.types[ty].inner {
        for member in members {
            collect_stage_locations(module, member.ty, member.binding.as_ref(), locations);
        }
    }
}

/// `ValidatedModule` + options JSON -> `BindGroupLayoutDescriptor[]` JSON string.
///
/// `options_json` shape: `{ "dynamicOffsets": [{ "group": u32, "binding": u32 }, ...] }`.
/// The naga IR does not express the dynamic-offset dimension (see research Finding 2
/// footnote), so it is injected via JS-side options.
#[wasm_bindgen]
pub fn emit_reflection(validated: &ValidatedModule, options_json: &str) -> Result<String, JsError> {
    let options: ReflectionOptions = serde_json::from_str(options_json)
        .unwrap_or(ReflectionOptions { dynamic_offsets: Vec::new() });
    let bgls = derive_bgls(&validated.module, &validated.info, &options);
    let uv_set_count = derive_uv_set_count(&validated.module);
    let output = ReflectionOutput {
        schema_version: "shader-reflection/2",
        bound_globals: derive_bound_globals(&validated.module, &validated.info),
        uv_set_count,
        bindings: bgls,
    };
    serde_json::to_string(&output)
        .map_err(|e| JsError::new(&format!("reflection serialize failed: {e}")))
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReflectionOptions {
    #[serde(default)]
    dynamic_offsets: Vec<DynamicOffsetSpec>,
}

#[derive(Serialize, Deserialize)]
struct DynamicOffsetSpec {
    group: u32,
    binding: u32,
}

// === BGL JSON shape (matches @forgeax/engine-types BindGroupLayoutDescriptor) ===============

#[derive(Serialize)]
struct Bgl {
    label: String,
    entries: Vec<BglEntry>,
}

#[derive(Serialize)]
struct BglEntry {
    binding: u32,
    visibility: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    buffer: Option<BufferBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sampler: Option<SamplerBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    texture: Option<TextureBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "storageTexture")]
    storage_texture: Option<StorageTextureBinding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BufferBinding {
    #[serde(rename = "type")]
    ty: &'static str,
    has_dynamic_offset: bool,
    min_binding_size: u32,
}

#[derive(Serialize)]
struct SamplerBinding {
    #[serde(rename = "type")]
    ty: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextureBinding {
    sample_type: &'static str,
    view_dimension: &'static str,
    multisampled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageTextureBinding {
    access: &'static str,
    format: &'static str,
    view_dimension: &'static str,
}

// === Generic shader-reflection/2 output ===========================================

#[derive(Serialize)]
struct BoundGlobal {
    group: u32,
    binding: u32,
    #[serde(rename = "addressSpace")]
    address_space: &'static str,
    #[serde(rename = "resourceKind")]
    resource_kind: &'static str,
    visibility: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    members: Option<Vec<ReflectionMember>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    span: Option<u32>,
    /// Byte step used when indexing a runtime-sized storage array.
    #[serde(rename = "elementStride", skip_serializing_if = "Option::is_none")]
    element_stride: Option<u32>,
}

#[derive(Serialize)]
struct ReflectionMember {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    offset: u32,
    size: u32,
    alignment: u32,
}

#[derive(Serialize)]
struct ReflectionOutput {
    #[serde(rename = "schemaVersion")]
    schema_version: &'static str,
    #[serde(rename = "boundGlobals")]
    bound_globals: Vec<BoundGlobal>,
    #[serde(rename = "uvSetCount")]
    uv_set_count: u32,
    // Keep the generic BGL projection in this wire during the one-cut reader
    // migration. It has no Material classification and is removed once all
    // consumers read boundGlobals directly.
    bindings: Vec<Bgl>,
}

fn derive_bound_globals(module: &Module, info: &ModuleInfo) -> Vec<BoundGlobal> {
    let mut globals = Vec::new();
    for (handle, variable) in module.global_variables.iter() {
        let Some(binding) = variable.binding else { continue };
        let visibility = compute_visibility(module, info, handle);
        let (members, span, element_stride) = match variable.space {
            AddressSpace::Uniform => {
                let ty = &module.types[variable.ty];
                match &ty.inner {
                    TypeInner::Struct { members, span } => (
                        Some(reflection_members(module, members)),
                        Some(*span),
                        None,
                    ),
                    TypeInner::Array { base, stride, .. } => {
                        let (members, span) = match &module.types[*base].inner {
                            TypeInner::Struct { members, span } => {
                                (Some(reflection_members(module, members)), Some(*span))
                            }
                            _ => (Some(Vec::new()), Some(0)),
                        };
                        (members, span, Some(*stride))
                    }
                    _ => (Some(Vec::new()), Some(0), None),
                }
            }
            AddressSpace::Storage { .. } => {
                let ty = &module.types[variable.ty];
                match &ty.inner {
                    TypeInner::Array { base, stride, .. } => {
                        let (members, span) = match &module.types[*base].inner {
                            TypeInner::Struct { members, span } => {
                                (Some(reflection_members(module, members)), Some(*span))
                            }
                            _ => (Some(Vec::new()), Some(0)),
                        };
                        (members, span, Some(*stride))
                    }
                    TypeInner::Struct { members, span } => (
                        Some(reflection_members(module, members)),
                        Some(*span),
                        Some(*span),
                    ),
                    _ => (
                        Some(Vec::new()),
                        Some(0),
                        ty.inner.try_size(module.to_ctx()),
                    ),
                }
            }
            _ => (None, None, None),
        };
        globals.push(BoundGlobal {
            group: binding.group,
            binding: binding.binding,
            address_space: reflection_address_space(&variable.space),
            resource_kind: reflection_resource_kind(module, variable),
            visibility,
            name: variable.name.clone(),
            members,
            span,
            element_stride,
        });
    }
    globals.sort_by_key(|global| (global.group, global.binding));
    globals
}

fn reflection_members(module: &Module, members: &[naga::StructMember]) -> Vec<ReflectionMember> {
    members
        .iter()
        .filter_map(|member| {
            let name = member.name.as_ref()?;
            let member_ty = &module.types[member.ty];
            Some(ReflectionMember {
                name: name.clone(),
                ty: reflection_type_name(member_ty),
                offset: member.offset,
                size: member_ty.inner.try_size(module.to_ctx()).unwrap_or(0),
                alignment: reflection_alignment(member_ty),
            })
        })
        .collect()
}

fn reflection_address_space(space: &AddressSpace) -> &'static str {
    match space {
        AddressSpace::Uniform => "uniform",
        AddressSpace::Storage { .. } => "storage",
        AddressSpace::Handle => "handle",
        _ => "other",
    }
}

fn reflection_resource_kind(module: &Module, variable: &naga::GlobalVariable) -> &'static str {
    match (&variable.space, &module.types[variable.ty].inner) {
        (AddressSpace::Uniform, _) => "buffer",
        (AddressSpace::Storage { .. }, _) => "storage-buffer",
        (AddressSpace::Handle, TypeInner::Sampler { .. }) => "sampler",
        (AddressSpace::Handle, TypeInner::Image { .. }) => "texture",
        _ => "unknown",
    }
}

fn reflection_type_name(ty: &naga::Type) -> String {
    match ty.inner {
        TypeInner::Scalar(scalar) => scalar_name(scalar).to_string(),
        TypeInner::Vector { size, scalar } => {
            format!("vec{}<{}>", u8::from(size), scalar_name(scalar))
        }
        TypeInner::Matrix { columns, rows, scalar } => format!(
            "mat{}x{}<{}>",
            u8::from(columns),
            u8::from(rows),
            scalar_name(scalar)
        ),
        _ => "struct".to_string(),
    }
}

fn scalar_name(scalar: Scalar) -> &'static str {
    match scalar.kind {
        ScalarKind::Float => "f32",
        ScalarKind::Sint => "i32",
        ScalarKind::Uint => "u32",
        ScalarKind::Bool => "bool",
        ScalarKind::AbstractInt => "abstract-int",
        ScalarKind::AbstractFloat => "abstract-float",
    }
}

fn reflection_alignment(ty: &naga::Type) -> u32 {
    match ty.inner {
        TypeInner::Scalar(scalar) => scalar.width as u32,
        TypeInner::Vector { size, scalar } => {
            let components = u8::from(size) as u32;
            if components >= 3 {
                scalar.width as u32 * 4
            } else {
                scalar.width as u32 * components
            }
        }
        TypeInner::Matrix { rows, scalar, .. } => {
            scalar.width as u32 * u8::from(rows) as u32
        }
        _ => 1,
    }
}

// === uvSetCount derivation from vertex @location (D-4 convention) ==================

/// Derive uvSetCount from vertex entry-point @location declarations.
///
/// D-4 convention (plan-strategy):
/// - location 2 is uv0 (always present if any UV)
/// - locations >= 6 are extra UV sets (uv1..uv7 map to location 6..12)
/// - Only vec2<f32> args at locations >= 6 are counted as extra UV
/// - Skip robustness: uvSetCount = 1 + max(location>=6) - 5;
///   jump from 6→8 implies presence of uv1(loc6), uv2(loc7), uv3(loc8) = 4 sets
/// - If no vertex entry-point or no @location(2): uvSetCount = 0
fn derive_uv_set_count(module: &Module) -> u32 {
    let mut max_uv_location: i32 = -1;

    for ep in &module.entry_points {
        if ep.stage != ShaderStage::Vertex {
            continue;
        }
        for arg in &ep.function.arguments {
            // arg.binding is None when a struct type wraps vertex inputs
            // (WGSL `fn vs(in: VsIn)`). In that case naga keeps @location
            // on the struct members. We must recurse into the struct.
            if let Some(Binding::Location { location, .. }) = &arg.binding {
                visit_location(*location, &module.types[arg.ty], &mut max_uv_location);
                continue;
            }
            // No binding on the arg itself — check if `arg.ty` is a struct
            // whose members carry @location (the WGSL `struct VsIn { ... }`
            // pattern).
            let ty = &module.types[arg.ty];
            if let TypeInner::Struct { ref members, .. } = ty.inner {
                for member in members {
                    if let Some(Binding::Location { location, .. }) = &member.binding {
                        let member_ty = &module.types[member.ty];
                        visit_location(*location, member_ty, &mut max_uv_location);
                    }
                }
            }
        }
    }

    if max_uv_location < 0 {
        return 0; // no vertex entry-point → no UV at all
    }

    if max_uv_location <= 2 {
        return 1; // only location 2 (uv0) present → 1 set
    }

    // D-4 skip robustness: max(location >= 6) - 5 extra sets
    // e.g. max=6 → 6-5=1 extra → 2 total; max=8 → 8-5=3 extra → 4 total
    1 + (max_uv_location as u32 - 5)
}

/// Visit a single @location with its type. Only vec2<f32> at locations
/// >= 6 count as extra UV. location 2 (uv0) is always counted.
fn visit_location(location: u32, ty: &naga::Type, max_uv_location: &mut i32) {
    if location == 2 {
        if *max_uv_location < 2 {
            *max_uv_location = 2;
        }
        return;
    }

    // locations >= 6: only vec2<f32> count as UV (filter pos/normal/tangent/skin)
    if location >= 6 {
        if matches!(
            ty.inner,
            TypeInner::Vector {
                size: VectorSize::Bi,
                scalar: Scalar { kind: ScalarKind::Float, width: 4, .. }
            }
        ) {
            if (location as i32) > *max_uv_location {
                *max_uv_location = location as i32;
            }
        }
    }
}

// === Reflection derivation main flow ===============================================

fn derive_bgls(module: &Module, info: &ModuleInfo, options: &ReflectionOptions) -> Vec<Bgl> {
    use std::collections::BTreeMap;

    let mut groups: BTreeMap<u32, BTreeMap<u32, BglEntry>> = BTreeMap::new();

    for (handle, var) in module.global_variables.iter() {
        let Some(rb) = &var.binding else { continue };
        let visibility = compute_visibility(module, info, handle);
        let entry = derive_entry(module, info, handle, var, rb.binding, visibility, options);
        groups.entry(rb.group).or_default().insert(rb.binding, entry);
    }

    groups
        .into_iter()
        .map(|(group_idx, entries)| Bgl {
            label: format!("@group({group_idx})"),
            entries: entries.into_values().collect(),
        })
        .collect()
}

fn compute_visibility(
    module: &Module,
    info: &ModuleInfo,
    handle: Handle<naga::GlobalVariable>,
) -> u32 {
    let mut bits: u32 = 0;
    for (idx, ep) in module.entry_points.iter().enumerate() {
        let fn_info = &info.get_entry_point(idx);
        let usage = fn_info[handle];
        if usage.is_empty() {
            continue;
        }
        bits |= match ep.stage {
            ShaderStage::Vertex => 0x1,
            ShaderStage::Fragment => 0x2,
            ShaderStage::Compute => 0x4,
            _ => 0,
        };
        let _ = usage.contains(GlobalUse::READ) || usage.contains(GlobalUse::WRITE) || usage.contains(GlobalUse::QUERY);
    }
    bits
}

fn derive_entry(
    module: &Module,
    _info: &ModuleInfo,
    handle: Handle<naga::GlobalVariable>,
    var: &naga::GlobalVariable,
    binding: u32,
    visibility: u32,
    options: &ReflectionOptions,
) -> BglEntry {
    let ty = &module.types[var.ty];
    let mut entry = BglEntry {
        binding,
        visibility,
        buffer: None,
        sampler: None,
        texture: None,
        storage_texture: None,
    };

    match (&var.space, &ty.inner) {
        (AddressSpace::Uniform, _) => {
            let has_dynamic_offset = is_dynamic_offset(&var.binding, options);
            entry.buffer = Some(BufferBinding {
                ty: "uniform",
                has_dynamic_offset,
                min_binding_size: 0,
            });
        }
        (AddressSpace::Storage { access }, _) => {
            let ty_str: &'static str = if access.contains(StorageAccess::STORE) {
                "storage"
            } else {
                "read-only-storage"
            };
            let has_dynamic_offset = is_dynamic_offset(&var.binding, options);
            entry.buffer = Some(BufferBinding {
                ty: ty_str,
                has_dynamic_offset,
                min_binding_size: 0,
            });
        }
        (AddressSpace::Handle, TypeInner::Sampler { comparison }) => {
            let ty_str: &'static str = if *comparison {
                "comparison"
            } else if module_uses_filtered_sample_with_global(module, handle) {
                "filtering"
            } else {
                "non-filtering"
            };
            entry.sampler = Some(SamplerBinding { ty: ty_str });
        }
        (AddressSpace::Handle, TypeInner::Image { dim, arrayed, class }) => match class {
            ImageClass::Storage { format, access } => {
                let access_str: &'static str = if access.contains(StorageAccess::LOAD) && access.contains(StorageAccess::STORE) {
                    "read-write"
                } else if access.contains(StorageAccess::STORE) {
                    "write-only"
                } else {
                    "read-only"
                };
                entry.storage_texture = Some(StorageTextureBinding {
                    access: access_str,
                    format: storage_format_str(*format),
                    view_dimension: image_dim_str(*dim, *arrayed),
                });
            }
            ImageClass::Sampled { kind, multi } => {
                let sample_type: &'static str = match kind {
                    ScalarKind::Sint => "sint",
                    ScalarKind::Uint => "uint",
                    ScalarKind::Float => {
                        if module_uses_filtered_sample_with_image(module, handle) {
                            "float"
                        } else {
                            "unfilterable-float"
                        }
                    }
                    _ => "unfilterable-float",
                };
                entry.texture = Some(TextureBinding {
                    sample_type,
                    view_dimension: image_dim_str(*dim, *arrayed),
                    multisampled: *multi,
                });
            }
            ImageClass::Depth { multi } => {
                entry.texture = Some(TextureBinding {
                    sample_type: "depth",
                    view_dimension: image_dim_str(*dim, *arrayed),
                    multisampled: *multi,
                });
            }
            ImageClass::External => {}
        },
        _ => {}
    }
    entry
}

fn is_dynamic_offset(rb: &Option<naga::ResourceBinding>, options: &ReflectionOptions) -> bool {
    let Some(rb) = rb else { return false };
    options
        .dynamic_offsets
        .iter()
        .any(|d| d.group == rb.group && d.binding == rb.binding)
}

/// WebGPU view dimension of a reflected image; `arrayed` selects the array
/// forms, so `texture_2d_array` / `texture_cube_array` round-trip into a BGL.
fn image_dim_str(dim: ImageDimension, arrayed: bool) -> &'static str {
    match (dim, arrayed) {
        (ImageDimension::D1, _) => "1d",
        (ImageDimension::D2, false) => "2d",
        (ImageDimension::D2, true) => "2d-array",
        (ImageDimension::D3, _) => "3d",
        (ImageDimension::Cube, false) => "cube",
        (ImageDimension::Cube, true) => "cube-array",
    }
}

fn module_uses_filtered_sample_with_global(
    module: &Module,
    sampler_handle: Handle<naga::GlobalVariable>,
) -> bool {
    for (_, func) in module.functions.iter() {
        if function_filtered_sample_with(func, module, sampler_handle, true) {
            return true;
        }
    }
    for ep in module.entry_points.iter() {
        if function_filtered_sample_with(&ep.function, module, sampler_handle, true) {
            return true;
        }
    }
    false
}

fn module_uses_filtered_sample_with_image(
    module: &Module,
    image_handle: Handle<naga::GlobalVariable>,
) -> bool {
    for (_, func) in module.functions.iter() {
        if function_filtered_sample_with(func, module, image_handle, false) {
            return true;
        }
    }
    for ep in module.entry_points.iter() {
        if function_filtered_sample_with(&ep.function, module, image_handle, false) {
            return true;
        }
    }
    false
}

fn function_filtered_sample_with(
    func: &naga::Function,
    module: &Module,
    target: Handle<naga::GlobalVariable>,
    is_sampler: bool,
) -> bool {
    for (_, expr) in func.expressions.iter() {
        if let Expression::ImageSample { image, sampler, level, .. } = expr {
            if !matches!(level, SampleLevel::Auto) {
                continue;
            }
            let probe = if is_sampler { *sampler } else { *image };
            if expression_resolves_to_global(func, module, probe, target) {
                return true;
            }
        }
    }
    false
}

fn expression_resolves_to_global(
    func: &naga::Function,
    _module: &Module,
    expr: Handle<Expression>,
    target: Handle<naga::GlobalVariable>,
) -> bool {
    match func.expressions[expr] {
        Expression::GlobalVariable(handle) => handle == target,
        Expression::Load { pointer } => expression_resolves_to_global(func, _module, pointer, target),
        _ => false,
    }
}

fn storage_format_str(fmt: StorageFormat) -> &'static str {
    match fmt {
        StorageFormat::R8Unorm => "r8unorm",
        StorageFormat::R8Snorm => "r8snorm",
        StorageFormat::R8Uint => "r8uint",
        StorageFormat::R8Sint => "r8sint",
        StorageFormat::R16Uint => "r16uint",
        StorageFormat::R16Sint => "r16sint",
        StorageFormat::R16Float => "r16float",
        StorageFormat::Rg8Unorm => "rg8unorm",
        StorageFormat::Rg8Snorm => "rg8snorm",
        StorageFormat::Rg8Uint => "rg8uint",
        StorageFormat::Rg8Sint => "rg8sint",
        StorageFormat::R32Uint => "r32uint",
        StorageFormat::R32Sint => "r32sint",
        StorageFormat::R32Float => "r32float",
        StorageFormat::Rg16Uint => "rg16uint",
        StorageFormat::Rg16Sint => "rg16sint",
        StorageFormat::Rg16Float => "rg16float",
        StorageFormat::Rgba8Unorm => "rgba8unorm",
        StorageFormat::Rgba8Snorm => "rgba8snorm",
        StorageFormat::Rgba8Uint => "rgba8uint",
        StorageFormat::Rgba8Sint => "rgba8sint",
        StorageFormat::Bgra8Unorm => "bgra8unorm",
        StorageFormat::Rgb10a2Uint => "rgb10a2uint",
        StorageFormat::Rgb10a2Unorm => "rgb10a2unorm",
        StorageFormat::Rg11b10Ufloat => "rg11b10ufloat",
        StorageFormat::Rg32Uint => "rg32uint",
        StorageFormat::Rg32Sint => "rg32sint",
        StorageFormat::Rg32Float => "rg32float",
        StorageFormat::Rgba16Uint => "rgba16uint",
        StorageFormat::Rgba16Sint => "rgba16sint",
        StorageFormat::Rgba16Float => "rgba16float",
        StorageFormat::Rgba32Uint => "rgba32uint",
        StorageFormat::Rgba32Sint => "rgba32sint",
        StorageFormat::Rgba32Float => "rgba32float",
        StorageFormat::R64Uint => "r64uint",
        StorageFormat::R16Unorm => "r16unorm",
        StorageFormat::R16Snorm => "r16snorm",
        StorageFormat::Rg16Unorm => "rg16unorm",
        StorageFormat::Rg16Snorm => "rg16snorm",
        StorageFormat::Rgba16Unorm => "rgba16unorm",
        StorageFormat::Rgba16Snorm => "rgba16snorm",
    }
}
