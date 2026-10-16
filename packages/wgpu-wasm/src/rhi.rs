// packages/wgpu-wasm/src/rhi.rs — wgpu 30 + wasm-bindgen shim module.
//
// The merged @forgeax/engine-wgpu-wasm crate shares one Naga instance between
// wgpu and the shader pipeline. Cargo pins both to the maintained source tree.
//
// The crate-level #[wasm_bindgen(start)] hook is hoisted to lib.rs so both
// surfaces share one entry point; everything else (14 opaque handle structs +
// factory entry points + R-06 5-pattern wasm-bindgen attributes) lives here
// unchanged from the rhi-wgpu/crate origin.
//
// This crate wraps the `wgpu` Rust API in a wasm-bindgen surface that the TS
// shim (@forgeax/engine-rhi-wgpu) calls from JS. The surface follows the R-06
// 5-pattern form (gen_GpuDevice.rs):
//
//   1. Type declaration  — `#[wasm_bindgen]` extern type per 14 opaque handle.
//   2. Getter            — `#[wasm_bindgen(method, getter, ...)]` for readonly fields.
//   3. Setter            — `#[wasm_bindgen(method, setter, ...)]` (sparse; spec mostly readonly).
//   4. Fallible method   — `#[wasm_bindgen(catch, ...)] -> Result<X, JsValue>`.
//   5. Promise method    — async fn / `js_sys::Promise` for mapAsync / requestDevice / etc.
//
// Shape invariants:
// - 14 opaque handles each carry exactly one `#[wasm_bindgen]` attribute
//   on their `pub struct` definition (acceptanceCheck grep gate
//   `#[wasm_bindgen` >= 14 hits).
// - The Instance constructor uses `wgpu::util::new_instance_with_webgpu_detection`
//   (R-03 graceful fallback shape: probe `navigator.gpu` synchronously, drop
//   `BROWSER_WEBGPU` from the backend set when unsupported, fall through to
//   the wgpu webgl backend).
// - `Closure::wrap` is used to bridge wgpu Rust callbacks (e.g. the
//   device-lost callback) into JS callable shapes (R-06 5-pattern +
//   wasm-bindgen Closure attack vectors). The callback inside is
//   `FnMut(String, String)` so the wasm ABI marshalling stays trivial
//   (primitive types only; wgpu enums get formatted to debug strings before
//   crossing the boundary).
// - All Promise-returning JS APIs go through `wasm_bindgen_futures::JsFuture`
//   so the Rust async path stays composable with the wgpu async surface
//   (R-06 5 layer #1-#3).

use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use wgpu::Backends;

// bug-20260610 v9 side-channel registries: WebGL2 fallback was crashing in
// `wgpu_core::storage::Storage::get` with `ShaderModule[Id(0,0)] is no longer
// alive`. The earlier `read_wbg_ptr<RhiWgpuShaderModule>(js).inner` pointer-
// cast path could not preserve a guaranteed-live `wgpu::ShaderModule` /
// `wgpu::PipelineLayout` reference across the createShaderModule →
// createRenderPipeline boundary (clone-and-leak in v8 didn't help). Move the
// real wgpu::ShaderModule / wgpu::PipelineLayout into a Rust-side registry
// indexed by a monotonic token; JS holds the token via a `forgeaxToken`
// getter on the wasm-bindgen handle and passes it through inside the
// pipeline descriptor. The registry holds Arc-internal clones forever, so
// the wgpu_core storage entry stays valid for the lifetime of the wasm
// module — and the createRenderPipeline path resolves the modules via the
// registry rather than by dereferencing JS pointers.
//
// wasm32 is single-threaded, so thread_local! + RefCell suffices (wgpu
// dispatch types aren't Send on web targets, ruling out a sync::Mutex).
thread_local! {
    static SHADER_REGISTRY: RefCell<HashMap<u32, wgpu::ShaderModule>> = RefCell::new(HashMap::new());
    static LAYOUT_REGISTRY: RefCell<HashMap<u32, wgpu::PipelineLayout>> = RefCell::new(HashMap::new());
    static BGL_REGISTRY: RefCell<HashMap<u32, wgpu::BindGroupLayout>> = RefCell::new(HashMap::new());
    // bug-20260610 v17: Device token registry. surface.configure(desc)
    // reflects the device handle off `desc.device` and resolves it via the
    // registry rather than reading __wbg_ptr — same fix as shader / BGL /
    // pipeline-layout. wgpu_core was panicking with "Device[Id(0,0)] is no
    // longer alive" when configure dereferenced the JS handle, suggesting
    // the pointer-cast path either read uninitialized memory or wgpu-bindgen
    // had moved the box mid-call. Cloning out of a thread-local registry
    // sidesteps both failure modes.
    static DEVICE_REGISTRY: RefCell<HashMap<u32, (wgpu::Device, wgpu::Queue)>> = RefCell::new(HashMap::new());
    static DEVICE_ADAPTER_REGISTRY: RefCell<HashMap<u32, wgpu::Adapter>> = RefCell::new(HashMap::new());
    // bug-20260610 v18: TextureView / Sampler / Buffer registries.
    // createBindGroup re-acquires resource handles every frame; the
    // wasm-bindgen pointer-cast path proved unreliable (handles end up
    // zeroed by some upstream consumer). Registries make resolution
    // identifier-based, mirroring shader / layout / BGL / device.
    static TEXTURE_VIEW_REGISTRY: RefCell<HashMap<u32, wgpu::TextureView>> = RefCell::new(HashMap::new());
    static SAMPLER_REGISTRY: RefCell<HashMap<u32, wgpu::Sampler>> = RefCell::new(HashMap::new());
    static BUFFER_REGISTRY: RefCell<HashMap<u32, wgpu::Buffer>> = RefCell::new(HashMap::new());
    static NEXT_TOKEN: RefCell<u32> = const { RefCell::new(1) };
    // bug-20260622 R5 WS2: last-uncaptured-error slot. The
    // `on_uncaptured_error` global callback (registered at request_device,
    // mirroring register_lost_callback's Closure paradigm at l.934) writes the
    // wgpu::Error Debug string here instead of letting wgpu panic. submit()
    // reads-and-clears it synchronously after self.inner.submit() so the TS
    // shim (queue.ts) can fan the failure out through onError as a structured
    // RhiError. wasm32 is single-threaded so a thread_local RefCell is safe;
    // the slot is device/instance-global (one wgpu module = one device on the
    // WebGL2 fallback path), matching the error-sink's process-global shape.
    static LAST_UNCAPTURED_ERROR: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Store the latest uncaptured wgpu error message (called from the
/// `on_uncaptured_error` global callback). Overwrites any prior un-consumed
/// value — submit() consumes per call, so the slot holds at most the most
/// recent submit-period failure.
fn store_uncaptured_error(message: String) {
    LAST_UNCAPTURED_ERROR.with(|slot| {
        *slot.borrow_mut() = Some(message);
    });
}

/// Read-and-clear the last uncaptured wgpu error message. Returns `None` when
/// no error was reported since the previous call. submit() calls this right
/// after self.inner.submit() to detect a submit-period validation failure
/// (the error-sink delivery is synchronous on the same call stack for the
/// WebGL2 backend).
fn take_uncaptured_error() -> Option<String> {
    LAST_UNCAPTURED_ERROR.with(|slot| slot.borrow_mut().take())
}

/// Execute one wgpu creation call with an operation-scoped uncaptured-error
/// boundary. wgpu reports some validation failures through the device sink
/// while still returning a handle; clearing before the call prevents a stale
/// error from being attributed to this operation, and taking immediately
/// after the call prevents an invalid handle from escaping this boundary.
fn create_with_uncaptured_error<T>(create: impl FnOnce() -> T) -> Result<T, JsValue> {
    let _ = take_uncaptured_error();
    let value = create();
    if let Some(message) = take_uncaptured_error() {
        return Err(JsValue::from_str(&format!(
            "[rhi-code:webgpu-runtime-error] {message}"
        )));
    }
    Ok(value)
}

fn alloc_token() -> u32 {
    NEXT_TOKEN.with(|t| {
        let mut t = t.borrow_mut();
        let n = *t;
        *t += 1;
        n
    })
}

fn register_shader(token: u32, sm: wgpu::ShaderModule) {
    SHADER_REGISTRY.with(|r| {
        r.borrow_mut().insert(token, sm);
    });
}

fn register_layout(token: u32, pl: wgpu::PipelineLayout) {
    LAYOUT_REGISTRY.with(|r| {
        r.borrow_mut().insert(token, pl);
    });
}

fn lookup_shader(token: u32) -> Option<wgpu::ShaderModule> {
    SHADER_REGISTRY.with(|r| r.borrow().get(&token).cloned())
}

fn lookup_layout(token: u32) -> Option<wgpu::PipelineLayout> {
    LAYOUT_REGISTRY.with(|r| r.borrow().get(&token).cloned())
}

fn register_bgl(token: u32, bgl: wgpu::BindGroupLayout) {
    BGL_REGISTRY.with(|r| {
        r.borrow_mut().insert(token, bgl);
    });
}

fn lookup_bgl(token: u32) -> Option<wgpu::BindGroupLayout> {
    BGL_REGISTRY.with(|r| r.borrow().get(&token).cloned())
}

fn register_device(token: u32, device: wgpu::Device, queue: wgpu::Queue) {
    DEVICE_REGISTRY.with(|r| {
        r.borrow_mut().insert(token, (device, queue));
    });
}

fn lookup_device(token: u32) -> Option<(wgpu::Device, wgpu::Queue)> {
    DEVICE_REGISTRY.with(|r| r.borrow().get(&token).cloned())
}

fn register_device_adapter(token: u32, adapter: wgpu::Adapter) {
    DEVICE_ADAPTER_REGISTRY.with(|r| {
        r.borrow_mut().insert(token, adapter);
    });
}

fn lookup_device_adapter(token: u32) -> Option<wgpu::Adapter> {
    DEVICE_ADAPTER_REGISTRY.with(|r| r.borrow().get(&token).cloned())
}

fn register_texture_view(token: u32, tv: wgpu::TextureView) {
    TEXTURE_VIEW_REGISTRY.with(|r| {
        r.borrow_mut().insert(token, tv);
    });
}

fn lookup_texture_view(token: u32) -> Option<wgpu::TextureView> {
    TEXTURE_VIEW_REGISTRY.with(|r| r.borrow().get(&token).cloned())
}

fn register_sampler(token: u32, s: wgpu::Sampler) {
    SAMPLER_REGISTRY.with(|r| {
        r.borrow_mut().insert(token, s);
    });
}

fn lookup_sampler(token: u32) -> Option<wgpu::Sampler> {
    SAMPLER_REGISTRY.with(|r| r.borrow().get(&token).cloned())
}

fn register_buffer(token: u32, b: wgpu::Buffer) {
    BUFFER_REGISTRY.with(|r| {
        r.borrow_mut().insert(token, b);
    });
}

fn lookup_buffer(token: u32) -> Option<wgpu::Buffer> {
    BUFFER_REGISTRY.with(|r| r.borrow().get(&token).cloned())
}

// bug-20260610: zero-sized owner of a `WebDisplayHandle` for the wasm GL
// backend's `InstanceDescriptor.display`. wgpu 30 GL on web requires the
// instance to carry a display handle (see RhiWgpuInstance::create comment).
#[derive(Debug)]
struct WebDisplay;

impl wgpu::rwh::HasDisplayHandle for WebDisplay {
    fn display_handle(&self) -> Result<wgpu::rwh::DisplayHandle<'_>, wgpu::rwh::HandleError> {
        Ok(wgpu::rwh::DisplayHandle::web())
    }
}

// ============================================================================
// 14 opaque handle structs (R-06 pattern 1: type declaration)
// ============================================================================
//
// Each handle is a thin wrapper around the corresponding wgpu Rust type. The
// `#[wasm_bindgen]` attribute makes the struct opaque to JS — the JS side
// holds a numeric handle ID and goes through the methods exposed below to
// touch the underlying GPU resource (charter proposition 4 + AGENTS.md
// "opaque handle" iron law).
//
// Naming: each Rust struct prefixed `RhiWgpu` to avoid collisions with the
// wgpu Rust API names + the forgeax TS RHI handle names (which are
// PascalCase brand types like `Buffer` / `Texture`). The JS-side bindings
// expose these as `RhiWgpuBuffer` etc., wrapped by the TS shim into the
// forgeax RHI handle opaque branding.

#[wasm_bindgen]
pub struct RhiWgpuInstance {
    inner: wgpu::Instance,
}

#[wasm_bindgen]
pub struct RhiWgpuAdapter {
    inner: wgpu::Adapter,
}

#[wasm_bindgen]
pub struct RhiWgpuDevice {
    inner: wgpu::Device,
    queue: wgpu::Queue,
    queue_completion: std::rc::Rc<RefCell<js_sys::Promise>>,
    token: u32,
    surface_view_formats: bool,
}

#[wasm_bindgen]
pub struct RhiWgpuQueue {
    inner: wgpu::Queue,
    device: wgpu::Device,
    completion: std::rc::Rc<RefCell<js_sys::Promise>>,
}

#[wasm_bindgen]
pub struct RhiWgpuBuffer {
    inner: wgpu::Buffer,
    device: wgpu::Device,
    token: u32,
    mapping: std::rc::Rc<RefCell<BufferMapping>>,
}

enum BufferMapping {
    Unmapped,
    Pending(std::rc::Rc<()>),
    Mapped {
        writable: bool,
        range: std::ops::Range<u64>,
        views: Vec<(std::ops::Range<u64>, js_sys::ArrayBuffer)>,
    },
}

#[wasm_bindgen]
impl RhiWgpuBuffer {
    #[wasm_bindgen(getter, js_name = forgeaxToken)]
    pub fn forgeax_token(&self) -> u32 {
        self.token
    }
}

#[wasm_bindgen]
pub struct RhiWgpuTexture {
    inner: wgpu::Texture,
}

#[wasm_bindgen]
pub struct RhiWgpuTextureView {
    inner: wgpu::TextureView,
    token: u32,
}

impl Drop for RhiWgpuTextureView {
    fn drop(&mut self) {
        TEXTURE_VIEW_REGISTRY.with(|registry| { registry.borrow_mut().remove(&self.token); });
    }
}

#[wasm_bindgen]
impl RhiWgpuTextureView {
    #[wasm_bindgen(getter, js_name = forgeaxToken)]
    pub fn forgeax_token(&self) -> u32 {
        self.token
    }

    // bug-20260612: minify-safe class brand. `constructor.name` gets rewritten
    // to a single letter by vite production builds, so the previous shim
    // dispatch (`if ctor_name == "RhiWgpuTextureView"`) silently broke.
    // wasm-bindgen-attached getters keep their `js_name` verbatim through
    // minify because the binding is generated by the wasm shim, not by JS
    // class declarations.
    #[wasm_bindgen(getter, js_name = forgeaxResourceKind)]
    pub fn forgeax_resource_kind(&self) -> String {
        "textureView".to_string()
    }
}

#[wasm_bindgen]
pub struct RhiWgpuSampler {
    inner: wgpu::Sampler,
    token: u32,
}

impl Drop for RhiWgpuSampler {
    fn drop(&mut self) {
        SAMPLER_REGISTRY.with(|registry| { registry.borrow_mut().remove(&self.token); });
    }
}

#[wasm_bindgen]
impl RhiWgpuSampler {
    #[wasm_bindgen(getter, js_name = forgeaxToken)]
    pub fn forgeax_token(&self) -> u32 {
        self.token
    }

    // bug-20260612: see RhiWgpuTextureView::forgeax_resource_kind.
    #[wasm_bindgen(getter, js_name = forgeaxResourceKind)]
    pub fn forgeax_resource_kind(&self) -> String {
        "sampler".to_string()
    }
}

#[wasm_bindgen]
pub struct RhiWgpuBindGroup {
    inner: wgpu::BindGroup,
}

#[wasm_bindgen]
pub struct RhiWgpuBindGroupLayout {
    inner: wgpu::BindGroupLayout,
    token: u32,
}

impl Drop for RhiWgpuBindGroupLayout {
    fn drop(&mut self) {
        BGL_REGISTRY.with(|registry| { registry.borrow_mut().remove(&self.token); });
    }
}

#[wasm_bindgen]
impl RhiWgpuBindGroupLayout {
    #[wasm_bindgen(getter, js_name = forgeaxToken)]
    pub fn forgeax_token(&self) -> u32 {
        self.token
    }
}

#[wasm_bindgen]
pub struct RhiWgpuPipelineLayout {
    inner: wgpu::PipelineLayout,
    token: u32,
}

#[wasm_bindgen]
impl RhiWgpuPipelineLayout {
    #[wasm_bindgen(getter, js_name = forgeaxToken)]
    pub fn forgeax_token(&self) -> u32 {
        self.token
    }
}

#[wasm_bindgen]
pub struct RhiWgpuRenderPipeline {
    inner: wgpu::RenderPipeline,
}

#[wasm_bindgen]
pub struct RhiWgpuComputePipeline {
    inner: wgpu::ComputePipeline,
}

#[wasm_bindgen]
pub struct RhiWgpuShaderModule {
    inner: wgpu::ShaderModule,
    token: u32,
}

#[wasm_bindgen]
impl RhiWgpuShaderModule {
    #[wasm_bindgen(getter, js_name = forgeaxToken)]
    pub fn forgeax_token(&self) -> u32 {
        self.token
    }
}

#[wasm_bindgen]
pub struct RhiWgpuCommandEncoder {
    inner: Option<wgpu::CommandEncoder>,
}

#[wasm_bindgen]
pub struct RhiWgpuCommandBuffer {
    inner: Option<wgpu::CommandBuffer>,
}

#[wasm_bindgen]
pub struct RhiWgpuRenderBundleEncoder {
    device: wgpu::Device,
    desc: BundleDescriptor,
    commands: Option<Vec<BundleCommand>>,
}

#[wasm_bindgen]
pub struct RhiWgpuRenderPass {
    inner: Option<wgpu::RenderPass<'static>>,
}

#[wasm_bindgen]
pub struct RhiWgpuComputePass {
    inner: Option<wgpu::ComputePass<'static>>,
}

#[wasm_bindgen]
pub struct RhiWgpuQuerySet {
    inner: wgpu::QuerySet,
}

#[wasm_bindgen]
pub struct RhiWgpuSurface {
    inner: wgpu::Surface<'static>,
    identity: u32,
    configuration: RefCell<Option<(SurfaceConfigurationFacts, wgpu::Queue)>>,
}

#[wasm_bindgen]
pub struct RhiWgpuSurfaceTexture {
    inner: Option<wgpu::SurfaceTexture>,
    surface_identity: u32,
    queue: wgpu::Queue,
}

// ============================================================================
// Mirror descriptor structs (w3) — serde-wasm-bindgen bridge.
// ============================================================================
// Each mirror struct maps JS camelCase fields to Rust snake_case via serde.
// wgpu types with serde support (TextureFormat, AddressMode, etc.) are used
// directly since the "serde" feature is enabled on the wgpu dependency.
// Labels: String -> Option<&'static str> via Box::leak.

fn leak_str(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

/// bug-20260610 Gap 14 helper: read the `__wbg_ptr` field off a JS-side
/// wasm-bindgen handle WITHOUT consuming it. wasm-bindgen exposes the raw
/// u32 as an own property; we cast it back to `*const T` to access the
/// underlying Rust struct, then borrow its inner field.
///
/// SAFETY contract: the caller must ensure the JS handle still owns a live
/// pointer (i.e. has not been `__destroy_into_raw`'d). The returned
/// reference's lifetime is bounded by the caller-chosen lifetime; in this
/// crate we use `'static` because the underlying `RhiWgpu*` instance is
/// kept alive by the JS side for at least the duration of the
/// `createRenderPipeline` call.
#[allow(dead_code)]
unsafe fn read_wbg_ptr<T>(js: &JsValue) -> Option<&'static T> {
    let n = js_sys::Reflect::get(js, &JsValue::from_str("__wbg_ptr")).ok()?
        .as_f64()? as u32;
    if n == 0 { return None; }
    Some(unsafe { &*(n as usize as *const T) })
}

#[allow(dead_code)]
unsafe fn shader_module_borrow(js: &JsValue) -> Option<&'static wgpu::ShaderModule> {
    unsafe { read_wbg_ptr::<RhiWgpuShaderModule>(js) }.map(|h| &h.inner)
}

#[allow(dead_code)]
unsafe fn pipeline_layout_borrow(js: &JsValue) -> Option<&'static wgpu::PipelineLayout> {
    unsafe { read_wbg_ptr::<RhiWgpuPipelineLayout>(js) }.map(|h| &h.inner)
}

fn query_set_borrow(js: &JsValue, what: &str) -> Result<&'static wgpu::QuerySet, JsValue> {
    unsafe { read_wbg_ptr::<RhiWgpuQuerySet>(js) }
        .map(|h| &h.inner)
        .ok_or_else(|| JsValue::from_str(&format!("{what} is not a live RhiWgpuQuerySet handle")))
}

/// bug-20260610 v9 side-channel: read the `forgeaxToken` getter off a
/// wasm-bindgen handle. Returns the u32 token previously assigned in
/// create_shader_module / create_pipeline_layout. The wasm-bindgen-generated
/// getter calls back into wasm to read the field — that round-trip is fine
/// for a one-shot read at pipeline-build time.
fn read_token(js: &JsValue, what: &str) -> Result<u32, JsValue> {
    js_sys::Reflect::get(js, &JsValue::from_str("forgeaxToken"))
        .map_err(|_| JsValue::from_str(&format!("{what} missing forgeaxToken")))
        .and_then(|v| {
            v.as_f64()
                .ok_or_else(|| JsValue::from_str(&format!("{what} forgeaxToken not a number")))
        })
        .map(|n| n as u32)
}

/// Resolve a shader-module token to a `'static` reference into a leaked
/// Box<wgpu::ShaderModule>. The leaked clone holds an Arc to the same
/// underlying CoreShaderModule kept alive in SHADER_REGISTRY, so the wgpu_core
/// storage entry stays valid for the wasm module's lifetime.
fn resolve_shader_token(token: u32) -> Result<&'static wgpu::ShaderModule, JsValue> {
    let module = lookup_shader(token).ok_or_else(|| {
        JsValue::from_str(&format!(
            "[wgpu-wasm v9] shader module token {token} not in registry"
        ))
    })?;
    Ok(Box::leak(Box::new(module)))
}

fn resolve_layout_token(token: u32) -> Result<&'static wgpu::PipelineLayout, JsValue> {
    let layout = lookup_layout(token).ok_or_else(|| {
        JsValue::from_str(&format!(
            "[wgpu-wasm v9] pipeline layout token {token} not in registry"
        ))
    })?;
    Ok(Box::leak(Box::new(layout)))
}

// ============================================================================
// Mirror enum types — kebab-case serde bridges for wgpu enums
// ============================================================================
// These Js-prefixed enums mirror wgpu types that either use PascalCase serde by
// default or have struct variants incompatible with flat kebab-case strings.
// They accept WebGPU-spec-compliant kebab-case strings from JS and convert to
// native wgpu enum values via into_wgpu().

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum BufferBindingTypeJs {
    Uniform,
    Storage,
    ReadOnlyStorage,
}
impl BufferBindingTypeJs {
    fn into_wgpu(&self) -> wgpu::BufferBindingType {
        match self {
            BufferBindingTypeJs::Uniform => wgpu::BufferBindingType::Uniform,
            BufferBindingTypeJs::Storage => wgpu::BufferBindingType::Storage { read_only: false },
            BufferBindingTypeJs::ReadOnlyStorage => wgpu::BufferBindingType::Storage { read_only: true },
        }
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum TextureSampleTypeJs {
    Float,
    UnfilterableFloat,
    Depth,
    Sint,
    Uint,
}
impl TextureSampleTypeJs {
    fn into_wgpu(&self) -> wgpu::TextureSampleType {
        match self {
            TextureSampleTypeJs::Float => wgpu::TextureSampleType::Float { filterable: true },
            TextureSampleTypeJs::UnfilterableFloat => wgpu::TextureSampleType::Float { filterable: false },
            TextureSampleTypeJs::Depth => wgpu::TextureSampleType::Depth,
            TextureSampleTypeJs::Sint => wgpu::TextureSampleType::Sint,
            TextureSampleTypeJs::Uint => wgpu::TextureSampleType::Uint,
        }
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum SamplerBorderColorJs {
    TransparentBlack,
    OpaqueBlack,
    OpaqueWhite,
}
impl SamplerBorderColorJs {
    fn into_wgpu(&self) -> wgpu::SamplerBorderColor {
        match self {
            SamplerBorderColorJs::TransparentBlack => wgpu::SamplerBorderColor::TransparentBlack,
            SamplerBorderColorJs::OpaqueBlack => wgpu::SamplerBorderColor::OpaqueBlack,
            SamplerBorderColorJs::OpaqueWhite => wgpu::SamplerBorderColor::OpaqueWhite,
        }
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum PresentModeJs {
    Fifo,
    FifoRelaxed,
    Immediate,
    Mailbox,
    AutoVsync,
    AutoNoVsync,
}
impl PresentModeJs {
    fn into_wgpu(&self) -> wgpu::PresentMode {
        match self {
            PresentModeJs::Fifo => wgpu::PresentMode::Fifo,
            PresentModeJs::FifoRelaxed => wgpu::PresentMode::FifoRelaxed,
            PresentModeJs::Immediate => wgpu::PresentMode::Immediate,
            PresentModeJs::Mailbox => wgpu::PresentMode::Mailbox,
            PresentModeJs::AutoVsync => wgpu::PresentMode::AutoVsync,
            PresentModeJs::AutoNoVsync => wgpu::PresentMode::AutoNoVsync,
        }
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum QueryTypeJs {
    Occlusion,
    Timestamp,
}
impl QueryTypeJs {
    fn into_wgpu(&self) -> wgpu::QueryType {
        match self {
            QueryTypeJs::Occlusion => wgpu::QueryType::Occlusion,
            QueryTypeJs::Timestamp => wgpu::QueryType::Timestamp,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShaderModuleDescriptorJs {
    code: String,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Extent3dJs {
    width: u32,
    height: u32,
    #[serde(default = "one")]
    depth_or_array_layers: u32,
}
const fn one() -> u32 { 1 }
impl Extent3dJs {
    fn into_wgpu(&self) -> wgpu::Extent3d {
        wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: self.depth_or_array_layers }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureDescriptorJs {
    #[serde(default)]
    label: Option<String>,
    size: Extent3dJs,
    #[serde(default = "one")]
    mip_level_count: u32,
    #[serde(default = "one")]
    sample_count: u32,
    dimension: Option<wgpu::TextureDimension>,
    format: wgpu::TextureFormat,
    usage: u32,
    #[serde(default)]
    view_formats: Vec<wgpu::TextureFormat>,
    // WebGPU compatibility-mode field. wgpu 30's native TextureDescriptor
    // has no equivalent, but the standard path carries the actual binding
    // dimension through TextureViewDescriptor, so parsing this field is
    // sufficient. Keep it in the JS mirror to reject malformed values rather
    // than silently accepting an unknown enum member.
    #[serde(default)]
    texture_binding_view_dimension: Option<wgpu::TextureViewDimension>,
}
impl TextureDescriptorJs {
    fn into_wgpu(&self) -> wgpu::TextureDescriptor<'static> {
        let vf: &'static [wgpu::TextureFormat] = if self.view_formats.is_empty() {
            &[]
        } else {
            Box::leak(self.view_formats.clone().into_boxed_slice())
        };
        wgpu::TextureDescriptor {
            label: self.label.as_ref().map(|s| leak_str(s.clone())),
            size: self.size.into_wgpu(),
            mip_level_count: self.mip_level_count,
            sample_count: self.sample_count,
            dimension: self.dimension.unwrap_or(wgpu::TextureDimension::D2),
            format: self.format,
            usage: wgpu::TextureUsages::from_bits_truncate(self.usage),
            view_formats: vf,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SamplerDescriptorJs {
    #[serde(default)]
    label: Option<String>,
    #[serde(default, rename = "addressModeU")]
    address_mode_u: Option<wgpu::AddressMode>,
    #[serde(default, rename = "addressModeV")]
    address_mode_v: Option<wgpu::AddressMode>,
    #[serde(default, rename = "addressModeW")]
    address_mode_w: Option<wgpu::AddressMode>,
    #[serde(default)]
    mag_filter: Option<wgpu::FilterMode>,
    #[serde(default)]
    min_filter: Option<wgpu::FilterMode>,
    #[serde(default)]
    mipmap_filter: Option<wgpu::MipmapFilterMode>,
    #[serde(default)]
    lod_min_clamp: Option<f32>,
    #[serde(default)]
    lod_max_clamp: Option<f32>,
    #[serde(default)]
    compare: Option<wgpu::CompareFunction>,
    #[serde(default)]
    max_anisotropy: Option<u16>,
    #[serde(default)]
    border_color: Option<SamplerBorderColorJs>,
}
impl SamplerDescriptorJs {
    fn into_wgpu(&self) -> wgpu::SamplerDescriptor<'_> {
        wgpu::SamplerDescriptor {
            label: self.label.as_deref(),
            address_mode_u: self.address_mode_u.unwrap_or(wgpu::AddressMode::ClampToEdge),
            address_mode_v: self.address_mode_v.unwrap_or(wgpu::AddressMode::ClampToEdge),
            address_mode_w: self.address_mode_w.unwrap_or(wgpu::AddressMode::ClampToEdge),
            mag_filter: self.mag_filter.unwrap_or(wgpu::FilterMode::Nearest),
            min_filter: self.min_filter.unwrap_or(wgpu::FilterMode::Nearest),
            mipmap_filter: self.mipmap_filter.unwrap_or(wgpu::MipmapFilterMode::Nearest),
            lod_min_clamp: self.lod_min_clamp.unwrap_or(0.0),
            lod_max_clamp: self.lod_max_clamp.unwrap_or(32.0),
            compare: self.compare,
            anisotropy_clamp: self.max_anisotropy.unwrap_or(1),
            border_color: self.border_color.as_ref().map(|bc| bc.into_wgpu()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindGroupLayoutDescriptorJs {
    #[serde(default)]
    label: Option<String>,
    entries: Vec<BindGroupLayoutEntryJs>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindGroupLayoutEntryJs {
    binding: u32,
    visibility: u32,
    #[serde(default)]
    buffer: Option<BufferBindingLayoutJs>,
    #[serde(default)]
    sampler: Option<SamplerBindingLayoutJs>,
    #[serde(default)]
    texture: Option<TextureBindingLayoutJs>,
    #[serde(default, rename = "storageTexture")]
    storage_texture: Option<StorageTextureBindingLayoutJs>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BufferBindingLayoutJs {
    #[serde(default, rename = "type")]
    ty: Option<BufferBindingTypeJs>,
    #[serde(default)]
    has_dynamic_offset: bool,
    #[serde(default)]
    min_binding_size: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SamplerBindingLayoutJs {
    #[serde(default, rename = "type")]
    ty: Option<wgpu::SamplerBindingType>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureBindingLayoutJs {
    #[serde(default)]
    sample_type: Option<TextureSampleTypeJs>,
    #[serde(default, rename = "viewDimension")]
    view_dimension: Option<wgpu::TextureViewDimension>,
    #[serde(default)]
    multisampled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageTextureBindingLayoutJs {
    #[serde(default)]
    access: Option<wgpu::StorageTextureAccess>,
    format: wgpu::TextureFormat,
    #[serde(default, rename = "viewDimension")]
    view_dimension: Option<wgpu::TextureViewDimension>,
}
impl BindGroupLayoutEntryJs {
    fn into_wgpu(&self) -> wgpu::BindGroupLayoutEntry {
        let ty = if let Some(ref buf) = self.buffer {
            wgpu::BindingType::Buffer {
                ty: buf.ty.as_ref().map_or(wgpu::BufferBindingType::Uniform, |t| t.into_wgpu()),
                has_dynamic_offset: buf.has_dynamic_offset,
                min_binding_size: buf.min_binding_size.and_then(core::num::NonZeroU64::new),
            }
        } else if let Some(ref s) = self.sampler {
            wgpu::BindingType::Sampler(s.ty.unwrap_or(wgpu::SamplerBindingType::Filtering))
        } else if let Some(ref t) = self.texture {
            wgpu::BindingType::Texture {
                sample_type: t.sample_type.as_ref().map_or(wgpu::TextureSampleType::Float { filterable: true }, |st| st.into_wgpu()),
                view_dimension: t.view_dimension.unwrap_or(wgpu::TextureViewDimension::D2),
                multisampled: t.multisampled,
            }
        } else if let Some(ref st) = self.storage_texture {
            wgpu::BindingType::StorageTexture {
                access: st.access.unwrap_or(wgpu::StorageTextureAccess::WriteOnly),
                format: st.format,
                view_dimension: st.view_dimension.unwrap_or(wgpu::TextureViewDimension::D2),
            }
        } else {
            wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            }
        };
        wgpu::BindGroupLayoutEntry {
            binding: self.binding,
            visibility: wgpu::ShaderStages::from_bits_truncate(self.visibility),
            ty,
            count: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipelineLayoutDescriptorJs {
    #[serde(default)]
    label: Option<String>,
    #[serde(default = "one_u32")]
    pipeline_push_constant_size: u32,
    #[serde(default)]
    immediate_size: u32,
}
const fn one_u32() -> u32 { 1 }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BufferDescriptorJs {
    #[serde(default)]
    label: Option<String>,
    size: u64,
    usage: u32,
    #[serde(default)]
    mapped_at_creation: bool,
}
impl BufferDescriptorJs {
    fn into_wgpu(&self) -> wgpu::BufferDescriptor<'static> {
        wgpu::BufferDescriptor {
            label: self.label.as_ref().map(|s| leak_str(s.clone())),
            size: self.size,
            usage: wgpu::BufferUsages::from_bits_truncate(self.usage),
            mapped_at_creation: self.mapped_at_creation,
        }
    }
}

// ============================================================================
// RhiWgpuInstance — wgpu::Instance bootstrap (R-03 graceful fallback)
// ============================================================================

#[wasm_bindgen]
impl RhiWgpuInstance {
    #[wasm_bindgen(js_name = create)]
    pub async fn create() -> Result<RhiWgpuInstance, JsValue> {
        // bug-20260610: wgpu 30's safe `create_surface(SurfaceTarget::Canvas)`
        // path hard-codes `raw_display_handle: None` at the call site (see
        // wgpu-30 src/api/instance.rs SurfaceTarget::Canvas branch). The
        // wgpu_core dispatch then needs the *Instance*-level display to be
        // present, otherwise it returns CreateSurfaceError::MissingDisplayHandle
        // ("No DisplayHandle is available to create this surface with"). For
        // web targets we hand the instance a zero-sized WebDisplayHandle so
        // the GL backend can resolve canvas surfaces without falling back to
        // the unsafe path.
        //
        // bug-20260610 v5: ONLY enable GL backend (drop BROWSER_WEBGPU). We
        // are the wasm GL fallback by definition — `@forgeax/engine-rhi-webgpu`
        // owns the navigator.gpu path. Mixing both backends caused
        // wgpu::Instance to hand out adapters/devices/shaders that internally
        // mixed the `Core` (= GL via wgpu_core) and `WebGpu` (= navigator.gpu
        // via the web backend) Dispatch variants, panicking later in
        // `as_core()` (`DispatchShaderModule is not core`) when the device
        // path was Core but a shader module had been minted on the WebGpu
        // side. With only GL enabled, every Dispatch handle uniformly
        // resolves to Core, and the panic is structurally impossible.
        let desc = wgpu::InstanceDescriptor {
            backends: Backends::GL,
            flags: wgpu::InstanceFlags::default(),
            backend_options: wgpu::BackendOptions::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            display: Some(Box::new(WebDisplay)),
        };
        let inner = wgpu::Instance::new(desc);
        Ok(RhiWgpuInstance { inner })
    }

    #[wasm_bindgen(js_name = requestAdapter)]
    pub async fn request_adapter(&self) -> JsValue {
        match self
            .inner
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
        {
            Ok(adapter) => RhiWgpuAdapter { inner: adapter }.into(),
            Err(_) => JsValue::NULL,
        }
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = requestAdapterWithCanvas)]
    pub async fn request_adapter_with_canvas(&self, canvas: web_sys::HtmlCanvasElement) -> JsValue {
        // Create a temporary surface for compatible_surface query (D-9).
        // The surface is discarded after adapter enumeration.
        //
        // bug-20260610 diagnostic: prior form returned plain JsValue::NULL on
        // both failure points (create_surface, request_adapter). The TS shim
        // could not distinguish "GL surface creation failed (canvas binding
        // problem)" from "no GL adapter found (wgpu instance configured
        // without GL backend)". Return descriptive strings so the TS layer
        // surfaces the real cause through `RhiError.hint`.
        let surface = match self.inner.create_surface(
            wgpu::SurfaceTarget::Canvas(canvas.clone()),
        ) {
            Ok(s) => s,
            Err(e) => return JsValue::from_str(&format!(
                "wgpu Instance::create_surface(SurfaceTarget::Canvas) failed: {e}"
            )),
        };
        let opts = wgpu::RequestAdapterOptions {
            compatible_surface: Some(&surface),
            ..Default::default()
        };
        match self.inner.request_adapter(&opts).await {
            Ok(adapter) => RhiWgpuAdapter { inner: adapter }.into(),
            Err(e) => JsValue::from_str(&format!(
                "wgpu Instance::request_adapter (with compatible_surface) failed: {e:?}"
            )),
        }
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(js_name = createSurface, catch)]
    pub fn create_surface(&self, canvas: web_sys::HtmlCanvasElement) -> Result<RhiWgpuSurface, JsValue> {
        match self.inner.create_surface(wgpu::SurfaceTarget::Canvas(canvas)) {
            Ok(s) => Ok(RhiWgpuSurface {
                inner: s,
                identity: alloc_token(),
                configuration: RefCell::new(None),
            }),
            Err(e) => Err(JsValue::from_str(&format!("createSurface failed: {e}"))),
        }
    }
}

fn feature_names(features: wgpu::Features) -> js_sys::Set {
    let result = js_sys::Set::new(&JsValue::UNDEFINED);
    for (name, _) in features.iter_names() {
        result.add(&JsValue::from_str(&name.to_ascii_lowercase().replace('_', "-")));
    }
    result
}

fn parse_requested_features(names: &[String]) -> Result<wgpu::Features, String> {
    names.iter().try_fold(wgpu::Features::empty(), |features, name| {
        let native = name.replace('-', "_").to_ascii_uppercase();
        wgpu::Features::from_name(&native)
            .map(|feature| features | feature)
            .ok_or_else(|| name.clone())
    })
}

// ============================================================================
// RhiWgpuAdapter
// ============================================================================

#[wasm_bindgen]
impl RhiWgpuAdapter {
    #[wasm_bindgen(getter)]
    pub fn features(&self) -> js_sys::Set {
        feature_names(self.inner.features())
    }

    #[wasm_bindgen(js_name = requestDevice, catch)]
    pub async fn request_device(&self, options: JsValue) -> Result<RhiWgpuDevice, JsValue> {
        #[derive(Default, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Request {
            #[serde(default)]
            required_features: Vec<String>,
        }
        let request: Request = if options.is_undefined() || options.is_null() {
            Request::default()
        } else {
            serde_wasm_bindgen::from_value(options)?
        };
        let required_features = parse_requested_features(&request.required_features)
            .map_err(|name| JsValue::from_str(&format!("unsupported feature: {name}")))?;
        let desc = wgpu::DeviceDescriptor {
            label: None,
            required_features,
            // Keep downlevel resource requirements, but admit presentation
            // extents from the real adapter (e.g. DPR3 2532×1170 canvases).
            required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                .using_resolution(self.inner.limits()),
            experimental_features: wgpu::ExperimentalFeatures::default(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        };
        let (device, queue) = self
            .inner
            .request_device(&desc)
            .await
            .map_err(|e| JsValue::from_str(&format!("wgpu requestDevice failed: {e}")))?;
        // bug-20260610 v17 side-channel: stash the wgpu::Device in the
        // thread-local registry so surface.configure(desc) can resolve it
        // via `desc.device.forgeaxToken` rather than the unsafe pointer-cast
        // path (which panicked with "Device[Id(0,0)] is no longer alive" on
        // the WebGL2 fallback path).
        let token = alloc_token();
        register_device(token, device.clone(), queue.clone());
        register_device_adapter(token, self.inner.clone());
        // bug-20260622 R5 WS2: register the on_uncaptured_error global callback
        // so submit-period wgpu validation errors land in a JS-visible slot
        // instead of being dropped by the error-sink (which silently swallowed
        // them, leaving the GPU wedged). The handler captures nothing — it only
        // writes the Error's Debug string into the thread_local slot — so it
        // satisfies the `Fn(Error) + Send + Sync + 'static` bound without a
        // non-Send JS closure. submit() reads-and-clears the slot synchronously.
        // Debug format begins with the variant name ("Validation { .. }" /
        // "OutOfMemory { .. }" / "Internal { .. }"), which classify_uncaptured_error
        // (l.1776, M3) matches via starts_with("Validation").
        device.on_uncaptured_error(std::sync::Arc::new(|error: wgpu::Error| {
            store_uncaptured_error(format!("{error:?}"));
        }));
        let surface_view_formats = self
            .inner
            .get_downlevel_capabilities()
            .flags
            .contains(wgpu::DownlevelFlags::SURFACE_VIEW_FORMATS);
        Ok(RhiWgpuDevice {
            inner: device, queue, token, surface_view_formats,
            queue_completion: std::rc::Rc::new(RefCell::new(js_sys::Promise::resolve(&JsValue::UNDEFINED))),
        })
    }
}

#[wasm_bindgen]
impl RhiWgpuDevice {
    #[wasm_bindgen(getter)]
    pub fn features(&self) -> js_sys::Set {
        feature_names(self.inner.features())
    }

    #[wasm_bindgen(getter, js_name = forgeaxToken)]
    pub fn forgeax_token(&self) -> u32 {
        self.token
    }

    /// Expose the concrete downlevel surface-view capability to the thin
    /// TypeScript adapter. This is an internal capability fact, not a public
    /// RhiCaps field; render routing consumes it as the dual-view/raw-only
    /// surface profile input.
    #[wasm_bindgen(getter, js_name = surfaceViewFormats)]
    pub fn surface_view_formats(&self) -> bool {
        self.surface_view_formats
    }
}

// ============================================================================
// RhiWgpuDevice — main surface AI users drive through `rhi.requestAdapter()
// -> adapter.requestDevice()` then call createBuffer / createTexture / ...
// ============================================================================

#[wasm_bindgen]
impl RhiWgpuDevice {
    #[wasm_bindgen(js_name = registerLostCallback)]
    pub fn register_lost_callback(&self, js_callback: js_sys::Function) {
        let closure: Closure<dyn FnMut(String, String)> =
            Closure::wrap(Box::new(move |reason: String, message: String| {
                let _ = js_callback.call2(
                    &JsValue::NULL,
                    &JsValue::from_str(&reason),
                    &JsValue::from_str(&message),
                );
            }));
        closure.forget();
    }

    #[wasm_bindgen(js_name = createTexture, catch)]
    pub fn create_texture(&self, desc_js: JsValue) -> Result<RhiWgpuTexture, JsValue> {
        let desc: TextureDescriptorJs = serde_wasm_bindgen::from_value(desc_js)?;
        let td = desc.into_wgpu();
        let texture = self.inner.create_texture(&td);
        Ok(RhiWgpuTexture { inner: texture })
    }

    #[wasm_bindgen(js_name = createSampler, catch)]
    pub fn create_sampler(&self, desc_js: JsValue) -> Result<RhiWgpuSampler, JsValue> {
        let desc: SamplerDescriptorJs = serde_wasm_bindgen::from_value(desc_js)?;
        let sd = desc.into_wgpu();
        let sampler = create_with_uncaptured_error(|| self.inner.create_sampler(&sd))?;
        let token = alloc_token();
        register_sampler(token, sampler.clone());
        Ok(RhiWgpuSampler { inner: sampler, token })
    }

    #[wasm_bindgen(js_name = createBindGroupLayout, catch)]
    pub fn create_bind_group_layout(&self, desc_js: JsValue) -> Result<RhiWgpuBindGroupLayout, JsValue> {
        let desc: BindGroupLayoutDescriptorJs = serde_wasm_bindgen::from_value(desc_js)?;
        let entries: Vec<_> = desc.entries.iter().map(BindGroupLayoutEntryJs::into_wgpu).collect();
        let descriptor = wgpu::BindGroupLayoutDescriptor {
            label: desc.label.as_deref(), entries: &entries,
        };
        let bgl = create_with_uncaptured_error(|| self.inner.create_bind_group_layout(&descriptor))?;
        // bug-20260610 v16 side-channel: stash a clone keyed by token so
        // create_pipeline_layout can resolve the BGL via the registry rather
        // than `try_from_js_value` which consumes the JS pointer (and breaks
        // when the same BGL appears in two pipeline layouts, e.g. mipmap-pl
        // built once per format).
        let token = alloc_token();
        register_bgl(token, bgl.clone());
        Ok(RhiWgpuBindGroupLayout { inner: bgl, token })
    }

    /// bug-20260610: take ONE descriptor whose `bindGroupLayouts` is an Array
    /// of `RhiWgpuBindGroupLayout` handles, mirroring the WebGPU spec
    /// (`GPUPipelineLayoutDescriptor.bindGroupLayouts`). The legacy 2-arg form
    /// (descriptor + array) was wired through the TS shim's generic `wrap()`
    /// helper which calls with **one** arg, so the BGL array always arrived
    /// `undefined` and wgpu built a 0-slot layout that later failed validation
    /// when bound to a 4-slot pipeline.
    #[wasm_bindgen(js_name = createPipelineLayout, catch)]
    pub fn create_pipeline_layout(
        &self,
        desc_js: JsValue,
    ) -> Result<RhiWgpuPipelineLayout, JsValue> {
        let desc: PipelineLayoutDescriptorJs = serde_wasm_bindgen::from_value(desc_js.clone())?;
        // Pull the bindGroupLayouts Array off the same descriptor object via
        // js_sys::Reflect — serde-skipping the field on the strongly-typed
        // PipelineLayoutDescriptorJs deserializer keeps the wasm handles raw
        // (serde_wasm_bindgen would try to re-serialize them as plain objects
        // and lose the wasm-bindgen pointer).
        let bgl_array_val = js_sys::Reflect::get(
            &desc_js,
            &JsValue::from_str("bindGroupLayouts"),
        )
        .map_err(|_| JsValue::from_str("createPipelineLayout: descriptor missing bindGroupLayouts"))?;
        let bind_group_layouts = js_sys::Array::from(&bgl_array_val);
        // bug-20260610 v16: resolve each BGL via its `forgeaxToken` getter
        // so the JS handle stays untouched. The previous `try_from_js_value`
        // path consumed the pointer on first read, silently producing 0-slot
        // layouts when the same BGL appeared in two pipeline-layout
        // descriptors (mipmap-pl per format reproduced this).
        let mut bgls: Vec<Option<&wgpu::BindGroupLayout>> = Vec::new();
        for i in 0..bind_group_layouts.length() {
            let v = bind_group_layouts.get(i);
            if v.is_undefined() || v.is_null() {
                bgls.push(None);
                continue;
            }
            let token = read_token(&v, &format!("bindGroupLayouts[{i}]"))?;
            let bgl = lookup_bgl(token).ok_or_else(|| {
                JsValue::from_str(&format!(
                    "[wgpu-wasm v16] BGL token {token} not in registry"
                ))
            })?;
            let leaked: &'static wgpu::BindGroupLayout = Box::leak(Box::new(bgl));
            bgls.push(Some(leaked));
        }
        let bgl_slice: &[Option<&wgpu::BindGroupLayout>] = Box::leak(bgls.into_boxed_slice());
        let wgpu_desc = wgpu::PipelineLayoutDescriptor {
            label: desc.label.as_ref().map(|s| leak_str(s.clone())),
            bind_group_layouts: bgl_slice,
            immediate_size: desc.immediate_size,
        };
        let pl = self.inner.create_pipeline_layout(&wgpu_desc);
        // bug-20260610 v9 side-channel: stash a clone in the thread-local
        // registry so create_render_pipeline can resolve the layout via a
        // stable token rather than a JS pointer-cast (which proved
        // unreliable across the createShaderModule → createRenderPipeline
        // boundary on WebGL2).
        let token = alloc_token();
        register_layout(token, pl.clone());
        Ok(RhiWgpuPipelineLayout { inner: pl, token })
    }

    // w4: createBindGroup, createRenderPipeline, createComputePipeline

    /// Descriptor resources are borrowed through their live tokens. Temporary
    /// native clones live only through create_bind_group; wgpu retains its own.
    #[wasm_bindgen(js_name = createBindGroup, catch)]
    pub fn create_bind_group(
        &self,
        desc_js: JsValue,
    ) -> Result<RhiWgpuBindGroup, JsValue> {
        enum Resource {
            Buffer(wgpu::Buffer, u64, Option<core::num::NonZeroU64>),
            Sampler(wgpu::Sampler),
            TextureView(wgpu::TextureView),
        }
        let label = js_sys::Reflect::get(&desc_js, &JsValue::from_str("label"))
            .ok().and_then(|v| v.as_string());
        let layout_js = js_sys::Reflect::get(&desc_js, &JsValue::from_str("layout"))
            .map_err(|_| JsValue::from_str("createBindGroup: descriptor missing layout"))?;
        let layout_token = read_token(&layout_js, "createBindGroup.layout")?;
        let layout = lookup_bgl(layout_token).ok_or_else(|| {
            JsValue::from_str(&format!("createBindGroup: BGL token {layout_token} not in registry"))
        })?;
        let entries_js = js_sys::Reflect::get(&desc_js, &JsValue::from_str("entries"))
            .map_err(|_| JsValue::from_str("createBindGroup: descriptor missing entries"))?;
        let entries_arr = js_sys::Array::from(&entries_js);
        let mut resources = Vec::with_capacity(entries_arr.length() as usize);
        for i in 0..entries_arr.length() {
            let entry_js = entries_arr.get(i);
            let binding = js_sys::Reflect::get(&entry_js, &JsValue::from_str("binding"))
                .ok().and_then(|v| v.as_f64()).unwrap_or(0.0) as u32;
            let resource_js = js_sys::Reflect::get(&entry_js, &JsValue::from_str("resource"))
                .map_err(|_| JsValue::from_str("entry missing resource"))?;
            let buffer_field = js_sys::Reflect::get(&resource_js, &JsValue::from_str("buffer"))
                .ok().unwrap_or(JsValue::UNDEFINED);
            let resource = if !buffer_field.is_undefined() && !buffer_field.is_null() {
                let token = read_token(&buffer_field, "createBindGroup.entry.buffer")?;
                let buffer = lookup_buffer(token).ok_or_else(|| {
                    JsValue::from_str(&format!("createBindGroup: buffer token {token} not in registry"))
                })?;
                let offset = js_sys::Reflect::get(&resource_js, &JsValue::from_str("offset"))
                    .ok().and_then(|v| v.as_f64()).unwrap_or(0.0) as u64;
                let size = js_sys::Reflect::get(&resource_js, &JsValue::from_str("size"))
                    .ok().and_then(|v| v.as_f64()).and_then(|s| core::num::NonZeroU64::new(s as u64));
                Resource::Buffer(buffer, offset, size)
            } else {
                // Explicit generated brand getters remain stable under minification.
                let kind = js_sys::Reflect::get(&resource_js, &JsValue::from_str("forgeaxResourceKind"))
                    .ok().and_then(|v| v.as_string()).unwrap_or_default();
                match kind.as_str() {
                    "sampler" => {
                        let token = read_token(&resource_js, "createBindGroup.entry.sampler")?;
                        Resource::Sampler(lookup_sampler(token).ok_or_else(|| {
                            JsValue::from_str(&format!("createBindGroup: sampler token {token} not in registry"))
                        })?)
                    }
                    "textureView" => {
                        let token = read_token(&resource_js, "createBindGroup.entry.textureView")?;
                        Resource::TextureView(lookup_texture_view(token).ok_or_else(|| {
                            JsValue::from_str(&format!("createBindGroup: textureView token {token} not in registry"))
                        })?)
                    }
                    _ => return Err(JsValue::from_str(&format!(
                        "createBindGroup: unrecognised resource (forgeaxResourceKind='{kind}'; expected 'sampler', 'textureView', or {{ buffer, offset?, size? }})"
                    ))),
                }
            };
            resources.push((binding, resource));
        }
        let entries: Vec<_> = resources.iter().map(|(binding, resource)| {
            let resource = match resource {
                Resource::Buffer(buffer, offset, size) => wgpu::BindingResource::Buffer(
                    wgpu::BufferBinding { buffer, offset: *offset, size: *size }
                ),
                Resource::Sampler(sampler) => wgpu::BindingResource::Sampler(sampler),
                Resource::TextureView(view) => wgpu::BindingResource::TextureView(view),
            };
            wgpu::BindGroupEntry { binding: *binding, resource }
        }).collect();
        let descriptor = wgpu::BindGroupDescriptor {
            label: label.as_deref(), layout: &layout, entries: &entries,
        };
        let inner = create_with_uncaptured_error(|| self.inner.create_bind_group(&descriptor))?;
        Ok(RhiWgpuBindGroup { inner })
    }

    /// bug-20260610 Gap 14: refactored to spec-aligned single-descriptor form.
    /// The earlier `(desc, vertex_module, fragment_module, layout)` form
    /// required the TS shim to extract handles + pass them as separate args
    /// — but the shim's generic `wrap()` helper only sends 1 arg, so the
    /// other three arrived as `undefined` and `_assertClass` blew up before
    /// the body ran. Reflect the handles off the descriptor so the call
    /// shape matches the WebGPU spec
    /// (`device.createRenderPipeline({layout, vertex:{module,...}, fragment:{module,...}, ...})`).
    #[wasm_bindgen(js_name = createRenderPipeline, catch)]
    pub fn create_render_pipeline(
        &self,
        desc_js: JsValue,
    ) -> Result<RhiWgpuRenderPipeline, JsValue> {
        let vertex_js = js_sys::Reflect::get(&desc_js, &JsValue::from_str("vertex"))
            .map_err(|_| JsValue::from_str("missing vertex"))?;
        let vertex_module_js = js_sys::Reflect::get(&vertex_js, &JsValue::from_str("module"))
            .map_err(|_| JsValue::from_str("missing vertex.module"))?;
        // bug-20260610 v9 side-channel resolution: read the `forgeaxToken`
        // getter off the JS handle (wasm-bindgen-generated property that
        // round-trips through wasm to read the token field) and look up the
        // wgpu::ShaderModule in the global registry. The handle itself is
        // never dereferenced via __wbg_ptr — the registry holds the canonical
        // Arc-clone, leaked into a `'static` reference so the wgpu::VertexState
        // can borrow it without lifetime issues.
        let leaked_vertex: &'static wgpu::ShaderModule = {
            let token = read_token(&vertex_module_js, "vertex.module")?;
            resolve_shader_token(token)?
        };
        let entry_point = js_sys::Reflect::get(&vertex_js, &JsValue::from_str("entryPoint"))
            .ok().and_then(|v| v.as_string()).unwrap_or_else(|| "main".to_string());

        let buffers_js = js_sys::Reflect::get(&vertex_js, &JsValue::from_str("buffers"))
            .ok().unwrap_or(JsValue::UNDEFINED);
        let vbs = parse_vertex_buffers(&buffers_js)?;
        let vbs: &[Option<wgpu::VertexBufferLayout<'static>>] = Box::leak(vbs.into_boxed_slice());
        let vertex_constants = parse_pipeline_constants(&vertex_js, "vertex.constants")?;

        let ep_leaked: Box<Option<&'static str>> = Box::new(if entry_point.is_empty() || entry_point == "main" { None } else { Some(leak_str(entry_point)) });
        let vertex = wgpu::VertexState {
            module: leaked_vertex,
            entry_point: *ep_leaked,
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: vertex_constants,
                ..Default::default()
            },
            buffers: vbs,
        };

        // bug-20260610 v9 side-channel resolution for fragment.module — same
        // pattern as vertex.module above. Fragment is optional in the WebGPU
        // spec; missing / null gives None.
        let frag_ref: Option<&'static wgpu::ShaderModule> = {
            let frag_js = js_sys::Reflect::get(&desc_js, &JsValue::from_str("fragment"))
                .ok().unwrap_or(JsValue::UNDEFINED);
            if frag_js.is_undefined() || frag_js.is_null() {
                None
            } else {
                let m_js = js_sys::Reflect::get(&frag_js, &JsValue::from_str("module"))
                    .ok().unwrap_or(JsValue::UNDEFINED);
                if m_js.is_undefined() || m_js.is_null() {
                    None
                } else {
                    let token = read_token(&m_js, "fragment.module")?;
                    Some(resolve_shader_token(token)?)
                }
            }
        };
        // F3-c: parse fragment in-place via `if let` rather than a `.map()`
        // closure, so a malformed target can `?`-propagate as Err out of the
        // whole function (the closure could not early-return; it previously
        // had to panic). Missing / null fragment keeps the None branch (AC-02
        // vertex-only equivalence).
        let fragment = if let Some(frag_mod) = frag_ref {
            let frag_js = js_sys::Reflect::get(&desc_js, &JsValue::from_str("fragment"))
                .ok().unwrap_or(JsValue::UNDEFINED);
            let targets_js = js_sys::Reflect::get(&frag_js, &JsValue::from_str("targets"))
                .ok().unwrap_or(JsValue::UNDEFINED);
            let ep = js_sys::Reflect::get(&frag_js, &JsValue::from_str("entryPoint"))
                .ok().and_then(|v| v.as_string()).unwrap_or_else(|| "main".to_string());

            let targets = parse_color_targets(&targets_js)?;
            let targets: &[Option<wgpu::ColorTargetState>] = Box::leak(targets.into_boxed_slice());
            let fragment_constants = parse_pipeline_constants(&frag_js, "fragment.constants")?;
            Some(wgpu::FragmentState {
                module: frag_mod,
                entry_point: if ep.is_empty() || ep == "main" { None } else { Some(leak_str(ep)) },
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: fragment_constants,
                    ..Default::default()
                },
                targets,
            })
        } else {
            None
        };

        let primitive = if let Ok(p_js) = js_sys::Reflect::get(&desc_js, &JsValue::from_str("primitive")) {
            if p_js.is_undefined() { wgpu::PrimitiveState::default() } else {
                match serde_wasm_bindgen::from_value::<PrimitiveStateJs>(p_js) {
                    Ok(v) => v.into_wgpu(),
                    Err(e) => {
                        return Err(JsValue::from_str(&format!("[wgpu-wasm] failed to parse primitive: {e}")));
                    }
                }
            }
        } else { wgpu::PrimitiveState::default() };

        let depth_stencil = if let Ok(ds_js) = js_sys::Reflect::get(&desc_js, &JsValue::from_str("depthStencil")) {
            if ds_js.is_undefined() || ds_js.is_null() { None } else {
                match serde_wasm_bindgen::from_value::<DepthStencilStateJs>(ds_js) {
                    Ok(v) => Some(v.into_wgpu()),
                    Err(e) => {
                        return Err(JsValue::from_str(&format!("[wgpu-wasm] failed to parse depthStencil: {e}")));
                    }
                }
            }
        } else { None };

        let multisample = if let Ok(ms_js) = js_sys::Reflect::get(&desc_js, &JsValue::from_str("multisample")) {
            if ms_js.is_undefined() || ms_js.is_null() { wgpu::MultisampleState::default() } else {
                match serde_wasm_bindgen::from_value::<MultisampleStateJs>(ms_js) {
                    Ok(v) => v.into_wgpu(),
                    Err(e) => {
                        return Err(JsValue::from_str(&format!("[wgpu-wasm] failed to parse multisample: {e}")));
                    }
                }
            }
        } else { wgpu::MultisampleState::default() };

        // bug-20260610 v9 side-channel resolution for pipeline layout — same
        // token registry pattern.
        let layout_ref: Option<&'static wgpu::PipelineLayout> = {
            let layout_js = js_sys::Reflect::get(&desc_js, &JsValue::from_str("layout"))
                .ok().unwrap_or(JsValue::UNDEFINED);
            if layout_js.is_undefined() || layout_js.is_null() {
                None
            } else {
                let token = read_token(&layout_js, "layout")?;
                Some(resolve_layout_token(token)?)
            }
        };

        let label = js_sys::Reflect::get(&desc_js, &JsValue::from_str("label"))
            .ok().and_then(|v| v.as_string());

        let wgpu_desc = wgpu::RenderPipelineDescriptor {
            label: label.map(|s| leak_str(s)),
            layout: layout_ref,
            vertex,
            primitive,
            depth_stencil,
            multisample,
            fragment,
            multiview_mask: None,
            cache: None,
        };
        let pipeline = create_with_uncaptured_error(|| {
            self.inner.create_render_pipeline(&wgpu_desc)
        })?;
        Ok(RhiWgpuRenderPipeline { inner: pipeline })
    }

    #[wasm_bindgen(js_name = createComputePipeline, catch)]
    pub fn create_compute_pipeline(
        &self,
        desc_js: JsValue,
        module: &RhiWgpuShaderModule,
        layout: Option<RhiWgpuPipelineLayout>,
    ) -> Result<RhiWgpuComputePipeline, JsValue> {
        let entry_point = js_sys::Reflect::get(&desc_js, &JsValue::from_str("entryPoint"))
            .ok().and_then(|v| v.as_string()).unwrap_or_else(|| "main".to_string());
        let label = js_sys::Reflect::get(&desc_js, &JsValue::from_str("label"))
            .ok().and_then(|v| v.as_string());

        let layout_ref = layout.map(|pl| {
            let leaked: &'static RhiWgpuPipelineLayout = Box::leak(Box::new(pl));
            &leaked.inner
        });

        let cp_ep: Option<&str> = if entry_point.is_empty() || entry_point == "main" { None } else { Some(leak_str(entry_point)) };
        let wgpu_desc = wgpu::ComputePipelineDescriptor {
            label: label.map(|s| leak_str(s)),
            layout: layout_ref,
            module: &module.inner,
            entry_point: cp_ep,
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        };
        let cp = self.inner.create_compute_pipeline(&wgpu_desc);
        Ok(RhiWgpuComputePipeline { inner: cp })
    }

    // w5: createShaderModule, createCommandEncoder, createQuerySet, createRenderBundleEncoder

    #[wasm_bindgen(js_name = createShaderModule, catch)]
    pub fn create_shader_module(&self, desc_js: JsValue) -> Result<RhiWgpuShaderModule, JsValue> {
        let desc: ShaderModuleDescriptorJs = serde_wasm_bindgen::from_value(desc_js)?;
        use std::borrow::Cow;
        let wgpu_desc = wgpu::ShaderModuleDescriptor {
            label: desc.label.as_deref(),
            source: wgpu::ShaderSource::Wgsl(Cow::Owned(desc.code)),
        };
        let sm = self.inner.create_shader_module(wgpu_desc);
        // bug-20260610 v9 side-channel registry: stash an Arc-clone in a
        // global registry keyed by a monotonic token. The JS handle exposes
        // `forgeaxToken` and threads it through pipeline descriptors so
        // create_render_pipeline can resolve the wgpu::ShaderModule via the
        // registry rather than by reading raw __wbg_ptr fields. Two reasons:
        //   1. The registry guarantees the underlying wgpu_core storage
        //      entry stays alive for the lifetime of the wasm module
        //      (refcount never drops to 0).
        //   2. Resolution by integer key avoids any concern about the JS
        //      handle being finalized / destroyed / re-wrapped between
        //      createShaderModule and createRenderPipeline. The `__wbg_ptr`
        //      pointer-cast workaround in v8 still hit
        //      `ShaderModule[Id(0,0)] is no longer alive` on WebGL2, despite
        //      a clone-and-leak — the side-channel removes that whole class
        //      of failure mode.
        let token = alloc_token();
        register_shader(token, sm.clone());
        Ok(RhiWgpuShaderModule { inner: sm, token })
    }

    #[wasm_bindgen(js_name = createCommandEncoder, catch)]
    pub fn create_command_encoder(&self, desc_js: JsValue) -> Result<RhiWgpuCommandEncoder, JsValue> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct EncDesc { #[serde(default)] label: Option<String> }
        let desc: EncDesc = serde_wasm_bindgen::from_value(desc_js)?;
        let enc_desc = wgpu::CommandEncoderDescriptor { label: desc.label.as_deref() };
        let enc = self.inner.create_command_encoder(&enc_desc);
        Ok(RhiWgpuCommandEncoder { inner: Some(enc) })
    }

    #[wasm_bindgen(js_name = createQuerySet, catch)]
    pub fn create_query_set(&self, desc_js: JsValue) -> Result<RhiWgpuQuerySet, JsValue> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct QsDesc { #[serde(default)] label: Option<String>, #[serde(rename = "type")] ty: QueryTypeJs, count: u32 }
        let desc: QsDesc = serde_wasm_bindgen::from_value(desc_js)?;
        let qs_desc = wgpu::QuerySetDescriptor { label: desc.label.as_ref().map(|s| leak_str(s.clone())), ty: desc.ty.into_wgpu(), count: desc.count };
        let qs = self.inner.create_query_set(&qs_desc);
        Ok(RhiWgpuQuerySet { inner: qs })
    }

    #[wasm_bindgen(js_name = createRenderBundleEncoder, catch)]
    pub fn create_render_bundle_encoder(&self, desc_js: JsValue) -> Result<RhiWgpuRenderBundleEncoder, JsValue> {
        let desc = serde_wasm_bindgen::from_value(desc_js)?;
        Ok(RhiWgpuRenderBundleEncoder { device: self.inner.clone(), desc, commands: Some(Vec::new()) })
    }

    // w2: serde-based createBuffer (single JsValue descriptor param, D-2)

    #[wasm_bindgen(js_name = createBuffer, catch)]
    pub fn create_buffer_serde(&self, desc_js: JsValue) -> Result<RhiWgpuBuffer, JsValue> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct BufDesc { #[serde(default)] label: Option<String>, size: u64, usage: u32, #[serde(default)] mapped_at_creation: bool }
        let desc: BufDesc = serde_wasm_bindgen::from_value(desc_js)?;
        let wgpu_desc = wgpu::BufferDescriptor {
            label: desc.label.as_ref().map(|s| leak_str(s.clone())),
            size: desc.size,
            usage: wgpu::BufferUsages::from_bits_truncate(desc.usage),
            mapped_at_creation: desc.mapped_at_creation,
        };
        let buffer = create_with_uncaptured_error(|| self.inner.create_buffer(&wgpu_desc))?;
        let token = alloc_token();
        register_buffer(token, buffer.clone());
        let mapping = if desc.mapped_at_creation {
            BufferMapping::Mapped {
                writable: true,
                range: 0..desc.size,
                views: Vec::new(),
            }
        } else {
            BufferMapping::Unmapped
        };
        Ok(RhiWgpuBuffer {
            inner: buffer,
            device: self.inner.clone(),
            token,
            mapping: std::rc::Rc::new(RefCell::new(mapping)),
        })
    }

    // w7: queue getter
    #[wasm_bindgen(getter, js_name = queue)]
    pub fn queue(&self) -> RhiWgpuQueue {
        RhiWgpuQueue {
            inner: self.queue.clone(),
            device: self.inner.clone(),
            completion: self.queue_completion.clone(),
        }
    }

    /// bug-20260610: surface `wgpu::Limits` to JS as a flat object whose keys
    /// match the WebGPU spec / `GPUSupportedLimits` JS naming (camelCase).
    /// The TS shim (`packages/rhi-wgpu/src/device.ts`) reads
    /// `raw.limits.maxStorageBuffersPerShaderStage` etc. directly into
    /// `RhiCaps.storageBuffer`. Without this getter the engine sees `{}` and
    /// every limit-gated branch falls through the "WebGPU spec default"
    /// happy path — which on the WebGL2 backend explodes inside
    /// `Device::create_bind_group_layout` with
    /// `Too many bindings of type StorageBuffers in Stage FRAGMENT, limit is 0`.
    ///
    /// u64 fields are coerced to f64 (JS number) — engine consumers compare
    /// against `STORAGE_BUFFER_MIN_REQUIRED` etc. which are <= 2^53, well
    /// within JS number precision; downlevel limits never approach the
    /// 2^53 boundary so the cast is lossless.
    #[wasm_bindgen(getter, js_name = limits)]
    pub fn limits(&self) -> js_sys::Object {
        let limits = self.inner.limits();
        let obj = js_sys::Object::new();
        let set = |k: &str, v: f64| {
            // Reflect::set is fallible only when the target is sealed/frozen;
            // a fresh Object never is, so this never errors in practice.
            let _ = js_sys::Reflect::set(
                &obj,
                &JsValue::from_str(k),
                &JsValue::from_f64(v),
            );
        };
        set("maxTextureDimension1D", f64::from(limits.max_texture_dimension_1d));
        set("maxTextureDimension2D", f64::from(limits.max_texture_dimension_2d));
        set("maxTextureDimension3D", f64::from(limits.max_texture_dimension_3d));
        set("maxTextureArrayLayers", f64::from(limits.max_texture_array_layers));
        set("maxBindGroups", f64::from(limits.max_bind_groups));
        set("maxBindGroupsPerPipelineLayout", f64::from(limits.max_bind_groups));
        set("maxBindingsPerBindGroup", f64::from(limits.max_bindings_per_bind_group));
        set(
            "maxDynamicUniformBuffersPerPipelineLayout",
            f64::from(limits.max_dynamic_uniform_buffers_per_pipeline_layout),
        );
        set(
            "maxDynamicStorageBuffersPerPipelineLayout",
            f64::from(limits.max_dynamic_storage_buffers_per_pipeline_layout),
        );
        set(
            "maxSampledTexturesPerShaderStage",
            f64::from(limits.max_sampled_textures_per_shader_stage),
        );
        set("maxSamplersPerShaderStage", f64::from(limits.max_samplers_per_shader_stage));
        set(
            "maxStorageBuffersPerShaderStage",
            f64::from(limits.max_storage_buffers_per_shader_stage),
        );
        set(
            "maxStorageTexturesPerShaderStage",
            f64::from(limits.max_storage_textures_per_shader_stage),
        );
        set(
            "maxUniformBuffersPerShaderStage",
            f64::from(limits.max_uniform_buffers_per_shader_stage),
        );
        set("maxUniformBufferBindingSize", limits.max_uniform_buffer_binding_size as f64);
        set("maxStorageBufferBindingSize", limits.max_storage_buffer_binding_size as f64);
        set("maxVertexBuffers", f64::from(limits.max_vertex_buffers));
        set("maxBufferSize", limits.max_buffer_size as f64);
        set("maxVertexAttributes", f64::from(limits.max_vertex_attributes));
        set(
            "maxVertexBufferArrayStride",
            f64::from(limits.max_vertex_buffer_array_stride),
        );
        set(
            "maxInterStageShaderVariables",
            f64::from(limits.max_inter_stage_shader_variables),
        );
        set(
            "minUniformBufferOffsetAlignment",
            f64::from(limits.min_uniform_buffer_offset_alignment),
        );
        set(
            "minStorageBufferOffsetAlignment",
            f64::from(limits.min_storage_buffer_offset_alignment),
        );
        set("maxColorAttachments", f64::from(limits.max_color_attachments));
        set(
            "maxColorAttachmentBytesPerSample",
            f64::from(limits.max_color_attachment_bytes_per_sample),
        );
        set(
            "maxComputeWorkgroupStorageSize",
            f64::from(limits.max_compute_workgroup_storage_size),
        );
        set(
            "maxComputeInvocationsPerWorkgroup",
            f64::from(limits.max_compute_invocations_per_workgroup),
        );
        set("maxComputeWorkgroupSizeX", f64::from(limits.max_compute_workgroup_size_x));
        set("maxComputeWorkgroupSizeY", f64::from(limits.max_compute_workgroup_size_y));
        set("maxComputeWorkgroupSizeZ", f64::from(limits.max_compute_workgroup_size_z));
        set(
            "maxComputeWorkgroupsPerDimension",
            f64::from(limits.max_compute_workgroups_per_dimension),
        );
        obj
    }

    /// bug-20260610 Gap 10: device-side texture-view creation. The TS shim
    /// (`packages/rhi-wgpu/src/device.ts`) prefers
    /// `device.createTextureView(tex, desc)` over `tex.createView(desc)`
    /// because some wasm bindings expose `createView` only at the device
    /// level. Mirror the spec descriptor surface (label / format / dimension /
    /// aspect / mip / array slice).
    #[wasm_bindgen(js_name = createTextureView, catch)]
    pub fn create_texture_view(
        &self,
        texture: &RhiWgpuTexture,
        desc_js: JsValue,
    ) -> Result<RhiWgpuTextureView, JsValue> {
        create_texture_view_from_descriptor(&texture.inner, &desc_js)
    }
}

fn create_texture_view_from_descriptor(
    texture: &wgpu::Texture,
    desc_js: &JsValue,
) -> Result<RhiWgpuTextureView, JsValue> {
    let label = js_sys::Reflect::get(desc_js, &JsValue::from_str("label"))
        .ok().and_then(|v| v.as_string());
    let descriptor = parse_texture_view_descriptor(desc_js, label.as_deref())?;
    let inner = create_with_uncaptured_error(|| texture.create_view(&descriptor))?;
    let token = alloc_token();
    register_texture_view(token, inner.clone());
    Ok(RhiWgpuTextureView { inner, token })
}

/// bug-20260610 Gap 10 helper — parse the optional/spec-shaped
/// `GPUTextureViewDescriptor` into a `wgpu::TextureViewDescriptor`.
/// Used by both `device.createTextureView(tex, desc)` and
/// `texture.createView(desc)` paths so the two surfaces stay byte-for-byte
/// equivalent (charter proposition 5 consistent abstraction).
fn parse_texture_view_descriptor<'a>(
    desc_js: &JsValue,
    label: Option<&'a str>,
) -> Result<wgpu::TextureViewDescriptor<'a>, JsValue> {
    if desc_js.is_undefined() || desc_js.is_null() {
        return Ok(wgpu::TextureViewDescriptor::default());
    }
    let format: Option<wgpu::TextureFormat> =
        parse_texture_view_enum(desc_js, "format")?;
    let dimension: Option<wgpu::TextureViewDimension> =
        parse_texture_view_enum(desc_js, "dimension")?;
    let usage: Option<u32> =
        js_sys::Reflect::get(desc_js, &JsValue::from_str("usage"))
        .ok().and_then(|v| v.as_f64()).map(|n| n as u32);
    let aspect = parse_texture_view_aspect(desc_js)?;
    let base_mip_level = js_sys::Reflect::get(desc_js, &JsValue::from_str("baseMipLevel"))
        .ok().and_then(|v| v.as_f64()).unwrap_or(0.0) as u32;
    let mip_level_count = js_sys::Reflect::get(desc_js, &JsValue::from_str("mipLevelCount"))
        .ok().and_then(|v| v.as_f64()).map(|n| n as u32);
    let base_array_layer = js_sys::Reflect::get(desc_js, &JsValue::from_str("baseArrayLayer"))
        .ok().and_then(|v| v.as_f64()).unwrap_or(0.0) as u32;
    let array_layer_count = js_sys::Reflect::get(desc_js, &JsValue::from_str("arrayLayerCount"))
        .ok().and_then(|v| v.as_f64()).map(|n| n as u32);
    Ok(wgpu::TextureViewDescriptor {
        label,
        format,
        dimension,
        usage: usage.map(wgpu::TextureUsages::from_bits_truncate),
        aspect,
        base_mip_level,
        mip_level_count,
        base_array_layer,
        array_layer_count,
    })
}

fn parse_texture_view_enum<T>(desc_js: &JsValue, field: &str) -> Result<Option<T>, JsValue>
where
    T: for<'de> serde::Deserialize<'de>,
{
    let value = js_sys::Reflect::get(desc_js, &JsValue::from_str(field)).map_err(|error| {
        texture_view_parse_error(field, &format!("could not read descriptor field: {error:?}"))
    })?;
    if value.is_undefined() || value.is_null() {
        return Ok(None);
    }
    serde_wasm_bindgen::from_value(value)
        .map(Some)
        .map_err(|error| texture_view_parse_error(field, &error.to_string()))
}

fn parse_texture_view_aspect(desc_js: &JsValue) -> Result<wgpu::TextureAspect, JsValue> {
    let value = js_sys::Reflect::get(desc_js, &JsValue::from_str("aspect")).map_err(|error| {
        texture_view_parse_error("aspect", &format!("could not read descriptor field: {error:?}"))
    })?;
    if value.is_undefined() || value.is_null() {
        return Ok(wgpu::TextureAspect::All);
    }
    match value.as_string().as_deref() {
        Some("all") => Ok(wgpu::TextureAspect::All),
        Some("stencil-only") => Ok(wgpu::TextureAspect::StencilOnly),
        Some("depth-only") => Ok(wgpu::TextureAspect::DepthOnly),
        Some(other) => Err(texture_view_parse_error(
            "aspect",
            &format!("unknown value '{other}' (expected 'all' | 'stencil-only' | 'depth-only')"),
        )),
        None => Err(texture_view_parse_error(
            "aspect",
            "expected a string enum value",
        )),
    }
}

fn texture_view_parse_error(field: &str, detail: &str) -> JsValue {
    JsValue::from_str(&format!(
        "[wgpu-wasm] failed to parse textureView descriptor.{field}: {detail}"
    ))
}

// ============================================================================
// create_render_pipeline descriptor parse helpers (F3-a/b/c/d).
//
// Extracted as free functions (mirroring parse_texture_view_descriptor above)
// so the malformed-descriptor parse boundary is reachable from wasm-bindgen
// tests without a real wgpu::Device -- spike-w3 proved `wasm-pack test --node`
// cannot obtain a wgpu adapter, so a device-bound test of create_render_pipeline
// is impossible. These helpers are the single source the method and the tests
// both drive. Every failure path returns Err with the stable prefix
// `[wgpu-wasm] failed to parse` (D-1 contract; the TS wrap() classifier keys on
// it) + the offending field path + element index. No panic, no new struct.
// ============================================================================

fn parse_vertex_buffers(
    buffers_js: &JsValue,
) -> Result<Vec<Option<wgpu::VertexBufferLayout<'static>>>, JsValue> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VbDesc {
        array_stride: u64,
        #[serde(default)]
        step_mode: Option<wgpu::VertexStepMode>,
        attributes: Vec<VAttrDesc>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VAttrDesc {
        format: wgpu::VertexFormat,
        offset: u64,
        shader_location: u32,
    }

    let mut vbs: Vec<Option<wgpu::VertexBufferLayout<'static>>> = Vec::new();
    if buffers_js.is_array() {
        let arr: js_sys::Array = buffers_js.clone().dyn_into().map_err(|_| {
            JsValue::from_str("[wgpu-wasm] failed to parse vertex.buffers: not an array")
        })?;
        for i in 0..arr.length() {
            let vb_js = arr.get(i);
            let vb: VbDesc = serde_wasm_bindgen::from_value(vb_js).map_err(|e| {
                JsValue::from_str(&format!("[wgpu-wasm] failed to parse vertex.buffers[{i}]: {e}"))
            })?;
            let attrs: Vec<wgpu::VertexAttribute> = vb
                .attributes
                .into_iter()
                .map(|a| wgpu::VertexAttribute {
                    format: a.format,
                    offset: a.offset,
                    shader_location: a.shader_location,
                })
                .collect();
            let attrs: &'static [wgpu::VertexAttribute] = Box::leak(attrs.into_boxed_slice());
            vbs.push(Some(wgpu::VertexBufferLayout {
                array_stride: vb.array_stride,
                step_mode: vb.step_mode.unwrap_or(wgpu::VertexStepMode::Vertex),
                attributes: attrs,
            }));
        }
    }
    Ok(vbs)
}

fn parse_color_targets(
    targets_js: &JsValue,
) -> Result<Vec<Option<wgpu::ColorTargetState>>, JsValue> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CtDesc {
        format: wgpu::TextureFormat,
        #[serde(default)]
        blend: Option<BlendStateJs>,
        #[serde(default)]
        write_mask: Option<u32>,
    }

    let mut targets: Vec<Option<wgpu::ColorTargetState>> = Vec::new();
    if targets_js.is_array() {
        let arr: js_sys::Array = targets_js.clone().dyn_into().map_err(|_| {
            JsValue::from_str("[wgpu-wasm] failed to parse fragment.targets: not an array")
        })?;
        for i in 0..arr.length() {
            let t = arr.get(i);
            if t.is_null() || t.is_undefined() {
                targets.push(None);
                continue;
            }
            let ct: CtDesc = serde_wasm_bindgen::from_value(t).map_err(|e| {
                JsValue::from_str(&format!(
                    "[wgpu-wasm] failed to parse fragment.targets[{i}]: {e}"
                ))
            })?;
            targets.push(Some(wgpu::ColorTargetState {
                format: ct.format,
                blend: ct.blend.map(|b| b.into_wgpu()),
                write_mask: wgpu::ColorWrites::from_bits_truncate(ct.write_mask.unwrap_or(0xF)),
            }));
        }
    }
    Ok(targets)
}

fn parse_pipeline_constants(
    stage_js: &JsValue,
    field: &str,
) -> Result<&'static [(&'static str, f64)], JsValue> {
    let constants_js = js_sys::Reflect::get(stage_js, &JsValue::from_str("constants"))
        .map_err(|e| JsValue::from_str(&format!("[wgpu-wasm] failed to parse {field}: {e:?}")))?;
    if constants_js.is_undefined() || constants_js.is_null() {
        return Ok(&[]);
    }

    let constants: HashMap<String, f64> = serde_wasm_bindgen::from_value(constants_js)
        .map_err(|e| JsValue::from_str(&format!("[wgpu-wasm] failed to parse {field}: {e}")))?;
    let constants = constants
        .into_iter()
        .map(|(name, value)| (leak_str(name), value))
        .collect::<Vec<_>>();
    Ok(Box::leak(constants.into_boxed_slice()))
}

// ============================================================================
// classify_uncaptured_error — free helper: wgpu error string -> stable category
//
// M4 will register an on_uncaptured_error global callback (mirroring
// register_lost_callback at l.934: Closure::wrap -> device.on_uncaptured_error).
// The callback formats the wgpu::Error as its Debug representation (which
// includes the variant discriminant), then passes the string to the TS shim.
//
// This helper does the pure-string classification so the logic is testable
// with wasm-pack test --node (node cannot construct a wgpu adapter, same
// constraint as the parse_vertex_buffers / parse_color_targets helpers).
//
// Classification rules (SSOT: plan-strategy D-4):
//   Validation { ... }  -> QueueSubmitFailed  (recoverable: fix command, next frame)
//   OutOfMemory { ... } -> WebgpuRuntimeError
//   Internal { ... }    -> WebgpuRuntimeError
//   empty / malformed   -> WebgpuRuntimeError  (safe fallback; never panic)
//
// Panic policy: this function never panics. Unknown/malformed input is
// classified as WebgpuRuntimeError so the caller always gets a valid
// category to feed into the RhiErrorCode closed union (requirements AC-04).
// ============================================================================

/// Classification of an uncaptured wgpu error received via on_uncaptured_error.
///
/// Maps to the error codes in the closed RhiErrorCode union
/// (packages/rhi/src/errors.ts): QueueSubmitFailed -> 'queue-submit-failed',
/// WebgpuRuntimeError -> 'webgpu-runtime-error'. No new union members are
/// added (plan-strategy D-4, requirements AC-05/AC-08).
#[derive(Debug, PartialEq, Eq)]
enum UncapturedErrorClass {
    /// Submit-period GPU validation error. Maps to RhiErrorCode 'queue-submit-failed'.
    /// Recoverable: fix the bad command data, submit next frame.
    QueueSubmitFailed,
    /// Backend runtime error (out-of-memory, internal failure, or unrecognised).
    /// Maps to RhiErrorCode 'webgpu-runtime-error'.
    WebgpuRuntimeError,
}

/// Classify an uncaptured wgpu error string into a stable category.
///
/// Input is the `Debug` representation of `wgpu::Error` as formatted by the
/// `on_uncaptured_error` callback (see module-level doc above). This function
/// is pure — no device, no adapter, no wasm-bindgen — so it is testable via
/// `wasm-pack test --node`.
fn classify_uncaptured_error(message: &str) -> UncapturedErrorClass {
    if message.starts_with("Validation") {
        UncapturedErrorClass::QueueSubmitFailed
    } else {
        UncapturedErrorClass::WebgpuRuntimeError
    }
}

// ============================================================================
// RhiWgpuTexture — createView (Gap 10) + destroy + spec dimensions
// ============================================================================
#[wasm_bindgen]
impl RhiWgpuTexture {
    #[wasm_bindgen(js_name = createView, catch)]
    pub fn create_view(&self, desc_js: JsValue) -> Result<RhiWgpuTextureView, JsValue> {
        create_texture_view_from_descriptor(&self.inner, &desc_js)
    }

    #[wasm_bindgen(js_name = destroy)]
    pub fn destroy(&self) {
        self.inner.destroy();
    }

    /// bug-20260610: spec-aligned getters so the engine can read swap-chain
    /// texture dimensions. Without these, `currentTexture.width` reads
    /// `undefined`, the runtime computes `targetW = (undefined | 0) === 0`,
    /// and `Device::create_texture` for the depth attachment trips
    /// `Dimension X is zero`.
    #[wasm_bindgen(getter, js_name = width)]
    pub fn width(&self) -> u32 {
        self.inner.width()
    }

    #[wasm_bindgen(getter, js_name = height)]
    pub fn height(&self) -> u32 {
        self.inner.height()
    }

    #[wasm_bindgen(getter, js_name = depthOrArrayLayers)]
    pub fn depth_or_array_layers(&self) -> u32 {
        self.inner.depth_or_array_layers()
    }
}

// ============================================================================
// RhiWgpuBuffer — mapAsync / getMappedRange / unmap / destroy (Gap 11)
// ============================================================================
#[wasm_bindgen]
impl RhiWgpuBuffer {
    #[wasm_bindgen(getter, js_name = mapState)]
    pub fn map_state(&self) -> String {
        match &*self.mapping.borrow() {
            BufferMapping::Unmapped => "unmapped",
            BufferMapping::Pending(_) => "pending",
            BufferMapping::Mapped { .. } => "mapped",
        }.into()
    }

    /// Start the native mapping before returning its Promise, so unmap can
    /// cancel a pending request. Its identity cannot retire a newer mapping.
    #[wasm_bindgen(js_name = mapAsync)]
    pub fn map_async(&self, mode: u32, offset: Option<u64>, size: Option<u64>) -> js_sys::Promise {
        let off = offset.unwrap_or(0);
        let end = size.map_or(Some(self.inner.size()), |size| off.checked_add(size));
        let usage = match mode {
            1 => wgpu::BufferUsages::MAP_READ,
            2 => wgpu::BufferUsages::MAP_WRITE,
            _ => return js_sys::Promise::reject(&JsValue::from_str("Buffer mapAsync mode must be READ or WRITE")),
        };
        let Some(end) = end.filter(|end| {
            off.is_multiple_of(8) && *end > off && (*end - off).is_multiple_of(4)
                && *end <= self.inner.size()
        }) else {
            return js_sys::Promise::reject(&JsValue::from_str("Buffer mapAsync range is outside the buffer or misaligned"));
        };
        if !self.inner.usage().contains(usage) {
            return js_sys::Promise::reject(&JsValue::from_str("Buffer mapAsync mode is not enabled by its usage"));
        }
        if !matches!(&*self.mapping.borrow(), BufferMapping::Unmapped) {
            return js_sys::Promise::reject(&JsValue::from_str("Buffer mapAsync requires an unmapped buffer"));
        }
        let request = std::rc::Rc::new(());
        *self.mapping.borrow_mut() = BufferMapping::Pending(request.clone());
        let result = std::sync::Arc::new(std::sync::Mutex::new((None, None::<std::task::Waker>)));
        let completion = result.clone();
        self.inner.slice(off..end).map_async(
            if mode == 2 { wgpu::MapMode::Write } else { wgpu::MapMode::Read },
            move |mapped| {
                let wake = {
                    let mut completion = completion.lock().unwrap();
                    completion.0 = Some(mapped);
                    completion.1.take()
                };
                // Mapping callbacks precede work-done callbacks in wgpu. Wake
                // the Promise now instead of waiting for a separate poll timer.
                if let Some(wake) = wake { wake.wake(); }
            },
        );
        let buffer = self.inner.clone();
        let device = self.device.clone();
        let mapping = self.mapping.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let completed = async {
                loop {
                    if !matches!(&*mapping.borrow(), BufferMapping::Pending(current) if std::rc::Rc::ptr_eq(current, &request)) {
                        return Err(JsValue::from_str("Buffer mapAsync was cancelled"));
                    }
                    device.poll(wgpu::PollType::Poll).map_err(|e| JsValue::from_str(&format!("Buffer mapAsync poll failed: {e}")))?;
                    if let Some(mapped) = result.lock().unwrap().0.take() {
                        return mapped.map_err(|e| JsValue::from_str(&format!("Buffer mapAsync failed: {e}")));
                    }
                    let timer = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("setTimeout"))?.dyn_into::<js_sys::Function>()?;
                    let delay = js_sys::Promise::new(&mut |resolve, reject| {
                        if let Err(error) = timer.call2(&js_sys::global(), &resolve, &JsValue::from_f64(1.0)) {
                            let _ = reject.call1(&JsValue::UNDEFINED, &error);
                        }
                    });
                    let mut delay = wasm_bindgen_futures::JsFuture::from(delay);
                    std::future::poll_fn(|cx| {
                        let mut completion = result.lock().unwrap();
                        if completion.0.is_some() {
                            return std::task::Poll::Ready(Ok(()));
                        }
                        completion.1 = Some(cx.waker().clone());
                        drop(completion);
                        std::future::Future::poll(std::pin::Pin::new(&mut delay), cx)
                            .map(|value| value.map(|_| ()))
                    }).await?;
                }
            }.await;
            if !matches!(&*mapping.borrow(), BufferMapping::Pending(current) if std::rc::Rc::ptr_eq(current, &request)) {
                return Err(JsValue::from_str("Buffer mapAsync was cancelled"));
            }
            match completed {
                Ok(()) => {
                    *mapping.borrow_mut() = BufferMapping::Mapped {
                        writable: mode == 2,
                        range: off..end,
                        views: Vec::new(),
                    };
                    Ok(JsValue::UNDEFINED)
                }
                Err(error) => {
                    *mapping.borrow_mut() = BufferMapping::Unmapped;
                    // Reset wgpu's range tracking even when native mapping
                    // failed, and keep cleanup errors out of the next submit.
                    let cause = take_uncaptured_error();
                    let cleanup = create_with_uncaptured_error(|| buffer.unmap());
                    Err(JsValue::from_str(&format!(
                        "{error:?}; native cause: {cause:?}; mapping cleanup: {cleanup:?}"
                    )))
                }
            }
        })
    }

    /// JS owns copies only for this mapping lease. Writable copies are
    /// committed before native unmap; READ edits are deliberately discarded.
    #[wasm_bindgen(js_name = getMappedRange, catch)]
    pub fn get_mapped_range(
        &self,
        offset: Option<u64>,
        size: Option<u64>,
    ) -> Result<js_sys::ArrayBuffer, JsValue> {
        let off = offset.unwrap_or(0);
        let end = size.map_or(Some(self.inner.size()), |size| off.checked_add(size));
        let mut mapping = self.mapping.borrow_mut();
        let BufferMapping::Mapped { range, views, .. } = &mut *mapping else {
            return Err(JsValue::from_str("Buffer getMappedRange requires a mapped buffer"));
        };
        let Some(end) = end.filter(|end| {
            off.is_multiple_of(8) && *end >= off && (*end - off).is_multiple_of(4)
                && off >= range.start && *end <= range.end
        }) else {
            return Err(JsValue::from_str("Buffer getMappedRange range is outside the mapping or misaligned"));
        };
        if views.iter().any(|(range, _)| off < range.end && range.start < end) {
            return Err(JsValue::from_str("Buffer getMappedRange overlaps an existing range"));
        }
        let length = u32::try_from(end - off)
            .map_err(|_| JsValue::from_str("Buffer getMappedRange exceeds the WASM address space"))?;
        let array = js_sys::Uint8Array::new_with_length(length);
        if end > off {
            let view = self.inner.get_mapped_range(off..end)
                .map_err(|error| JsValue::from_str(&format!("Buffer getMappedRange failed: {error}")))?;
            array.copy_from(&view);
        }
        let bytes = array.buffer();
        views.push((off..end, bytes.clone()));
        Ok(bytes)
    }

    #[wasm_bindgen(js_name = unmap)]
    pub fn unmap(&self) -> Result<(), JsValue> {
        self.release_mapping(true)
    }

    #[wasm_bindgen(js_name = destroy)]
    pub fn destroy(&self) -> Result<(), JsValue> {
        let released = self.release_mapping(false);
        self.inner.destroy();
        released
    }
}

impl RhiWgpuBuffer {
    fn release_mapping(&self, commit: bool) -> Result<(), JsValue> {
        let mapping = std::mem::replace(&mut *self.mapping.borrow_mut(), BufferMapping::Unmapped);
        if matches!(mapping, BufferMapping::Unmapped) {
            return Ok(());
        }
        let mut result = Ok(());
        if let BufferMapping::Mapped { writable, views, .. } = mapping {
            for (range, bytes) in views {
                if commit && writable && !range.is_empty() {
                    if u64::from(bytes.byte_length()) != range.end - range.start {
                        result = Err(JsValue::from_str("Buffer mapped range was detached before unmap"));
                    } else {
                        let data = js_sys::Uint8Array::new(&bytes).to_vec();
                        match self.inner.get_mapped_range_mut(range) {
                            Ok(mut view) => view.copy_from_slice(&data),
                            Err(error) => result = Err(JsValue::from_str(&format!("Buffer unmap commit failed: {error}"))),
                        }
                    }
                }
                if let Err(error) = detach_mapped_buffer(&bytes) {
                    result = Err(error);
                }
            }
        }
        self.inner.unmap();
        result
    }
}

/// Restricted JS hosts may lack both transfer primitives. Their retired copy
/// remains inert: it no longer has any path back into the native buffer.
fn detach_mapped_buffer(bytes: &js_sys::ArrayBuffer) -> Result<(), JsValue> {
    if bytes.byte_length() == 0 {
        return Ok(());
    }
    let transfer = js_sys::Reflect::get(bytes, &JsValue::from_str("transfer"))?;
    if let Some(transfer) = transfer.dyn_ref::<js_sys::Function>() {
        transfer.call1(bytes, &JsValue::from_f64(0.0))?;
    } else {
        let global = js_sys::global();
        let clone = js_sys::Reflect::get(&global, &JsValue::from_str("structuredClone"))?;
        if let Some(clone) = clone.dyn_ref::<js_sys::Function>() {
            let options = js_sys::Object::new();
            let transfers = js_sys::Array::new();
            transfers.push(bytes);
            js_sys::Reflect::set(&options, &JsValue::from_str("transfer"), &transfers)?;
            clone.call2(&global, bytes, &options)?;
        }
    }
    Ok(())
}

/// Short-lived completion observation, explicitly released by the JS driver.
#[wasm_bindgen]
pub struct RhiWgpuCompletionRequest {
    device: wgpu::Device,
    completed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[wasm_bindgen]
impl RhiWgpuCompletionRequest {
    pub fn poll(&self) -> Result<bool, JsValue> {
        #[cfg(target_arch = "wasm32")]
        {
            let device = unsafe { self.device.as_hal::<wgpu::hal::api::Gles>() }
                .ok_or_else(|| JsValue::from_str("Queue completion requires its WebGL2 device"))?;
            if device.context().webgl2_context.is_context_lost() {
                return Err(JsValue::from_str("WebGL context lost before queue completion"));
            }
        }
        self.device.poll(wgpu::PollType::Poll)
            .map_err(|error| JsValue::from_str(&format!("Queue completion poll failed: {error}")))?;
        Ok(self.completed.load(std::sync::atomic::Ordering::Acquire))
    }
}

// ============================================================================
// RhiWgpuQueue — submit + writeBuffer (w6)
// ============================================================================

#[wasm_bindgen]
impl RhiWgpuQueue {
    /// The private JS driver owns scheduling and catches native throws/traps.
    /// Only the native callback is allowed to report completion.
    #[wasm_bindgen(js_name = onSubmittedWorkDone)]
    pub fn on_submitted_work_done(&self, driver: &js_sys::Function) -> Result<js_sys::Promise, JsValue> {
        let queue = self.inner.clone();
        let device = self.device.clone();
        let start = Closure::once_into_js(move || -> RhiWgpuCompletionRequest {
            let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let callback = completed.clone();
            queue.on_submitted_work_done(move || {
                callback.store(true, std::sync::atomic::Ordering::Release);
            });
            RhiWgpuCompletionRequest { device, completed }
        });
        let previous = self.completion.borrow().clone();
        let result = driver.call2(&JsValue::UNDEFINED, &start, &previous)?
            .dyn_into::<js_sys::Promise>()?;
        *self.completion.borrow_mut() = result.clone();
        Ok(result)
    }

    // bug-20260622 R5 WS2: submit now returns Result so a submit-period wgpu
    // validation error (delivered to the on_uncaptured_error slot, NOT a Rust
    // panic — see ws2-mechanism-investigation.md) surfaces to the TS shim as a
    // catchable Err instead of being silently swallowed by the error-sink. The
    // Err string carries a stable `[rhi-code:<code>]` prefix that queue.ts
    // parses to route into the matching RhiError factory (queue-submit-failed
    // vs webgpu-runtime-error). classify_uncaptured_error (M3) is the single
    // classification SSOT — TS only routes by the prefix, never re-classifies.
    // The queue instance stays alive after an Err (AC-06): the next submit()
    // call finds the slot cleared and proceeds normally.
    #[wasm_bindgen(js_name = submit, catch)]
    pub fn submit(&self, buffers: js_sys::Array) -> Result<(), JsValue> {
        let mut cmd_bufs = Vec::with_capacity(buffers.length() as usize);
        for i in 0..buffers.length() {
            // wasm-bindgen transfers the JS wrapper's pointer to this owned value.
            // Dropping the emptied wrapper releases its allocation; no static borrow
            // is needed because Queue::submit takes ownership of the command buffer.
            let mut command: RhiWgpuCommandBuffer =
                wasm_bindgen::convert::TryFromJsValue::try_from_js_value(buffers.get(i))
                    .map_err(|_| JsValue::from_str(&format!(
                        "[rhi-code:queue-submit-failed] submit requires an unsubmitted CommandBuffer at index {i}"
                    )))?;
            let command = command.inner.take().ok_or_else(|| JsValue::from_str(
                "[rhi-code:queue-submit-failed] CommandBuffer was already submitted"
            ))?;
            cmd_bufs.push(command);
        }
        self.inner.submit(cmd_bufs);
        // The error-sink delivery is synchronous on the WebGL2 backend, so any
        // submit-period validation error is already in the slot by now.
        if let Some(message) = take_uncaptured_error() {
            let code = match classify_uncaptured_error(&message) {
                UncapturedErrorClass::QueueSubmitFailed => "queue-submit-failed",
                UncapturedErrorClass::WebgpuRuntimeError => "webgpu-runtime-error",
            };
            return Err(JsValue::from_str(&format!("[rhi-code:{code}] {message}")));
        }
        Ok(())
    }

    /// bug-20260610: explicit `js_name = writeBuffer` because wasm-bindgen's
    /// default snake_case export (`write_buffer`) does not match the WebGPU
    /// spec / TS shim's `queue.writeBuffer(...)` call site.
    ///
    /// TS shim signature: `writeBuffer(buffer, bufferOffset, data, dataOffset?, size?)`.
    /// dataOffset / size are optional in the spec — we honour them by slicing
    /// the input bytes before forwarding to wgpu.
    #[wasm_bindgen(js_name = writeBuffer)]
    pub fn write_buffer(
        &self,
        buffer: &RhiWgpuBuffer,
        buffer_offset: u64,
        data: &[u8],
        data_offset: Option<u64>,
        size: Option<u64>,
    ) {
        let data_offset = data_offset.unwrap_or(0) as usize;
        let end = match size {
            Some(s) => data_offset + s as usize,
            None => data.len(),
        };
        // Defensive clamp — wgpu would also bounds-check, but a clean Rust
        // slice keeps the panic site closer to the wasm boundary so Safari
        // surfaces a useful message rather than a generic "memory access".
        let slice_end = end.min(data.len());
        let slice_start = data_offset.min(slice_end);
        self.inner.write_buffer(&buffer.inner, buffer_offset, &data[slice_start..slice_end]);
    }

    /// bug-20260610 Gap 9: `queue.writeTexture(...)` flat-args form.
    ///
    /// The texture handle MUST come in as a `&RhiWgpuTexture` (borrowed) —
    /// `try_from_js_value` would consume the JS-side `__wbg_ptr` (zeroes it),
    /// breaking the very common writeTexture-then-createView pattern that
    /// the engine uses on every fallback texture in `buildReadyWebGPU`.
    ///
    /// Layout / origin / size are passed as flat numeric args rather than
    /// JsValue to keep the wasm boundary cheap and free of additional
    /// Reflect lookups. The TS shim flattens
    /// `writeTexture(destination, data, dataLayout, size)` →
    /// `writeTexture(destination.texture, mipLevel, originX, originY,
    /// originZ, aspect, data, layoutOffset, bytesPerRow, rowsPerImage,
    /// sizeWidth, sizeHeight, sizeDepth)`.
    #[wasm_bindgen(js_name = writeTexture)]
    #[allow(clippy::too_many_arguments)]
    pub fn write_texture(
        &self,
        texture: &RhiWgpuTexture,
        mip_level: u32,
        origin_x: u32,
        origin_y: u32,
        origin_z: u32,
        aspect: u8,
        data: &[u8],
        layout_offset: u64,
        bytes_per_row: Option<u32>,
        rows_per_image: Option<u32>,
        size_width: u32,
        size_height: u32,
        size_depth: u32,
    ) {
        let dest = wgpu::TexelCopyTextureInfo {
            texture: &texture.inner,
            mip_level,
            origin: wgpu::Origin3d { x: origin_x, y: origin_y, z: origin_z },
            aspect: aspect_from_u8(aspect),
        };
        let layout = wgpu::TexelCopyBufferLayout {
            offset: layout_offset,
            bytes_per_row,
            rows_per_image,
        };
        let size = wgpu::Extent3d {
            width: size_width,
            height: size_height,
            depth_or_array_layers: size_depth,
        };
        self.inner.write_texture(dest, data, layout, size);
    }

    /// `queue.copyExternalImageToTexture(...)` flat-args form, mirroring
    /// writeTexture: the texture is borrowed so its JS pointer survives.
    /// WebGL2 has no `texture_external`, so video and canvas sources reach
    /// sampled textures only through this copy.
    #[wasm_bindgen(js_name = copyExternalImageToTexture, catch)]
    #[allow(clippy::too_many_arguments)]
    pub fn copy_external_image_to_texture(
        &self,
        source: JsValue,
        source_origin_x: u32,
        source_origin_y: u32,
        flip_y: bool,
        texture: &RhiWgpuTexture,
        mip_level: u32,
        origin_x: u32,
        origin_y: u32,
        origin_z: u32,
        aspect: u8,
        display_p3: bool,
        premultiplied_alpha: bool,
        size_width: u32,
        size_height: u32,
        size_depth: u32,
    ) -> Result<(), JsValue> {
        use wasm_bindgen::JsCast;
        let source = if source.is_instance_of::<web_sys::HtmlVideoElement>() {
            wgpu::ExternalImageSource::HTMLVideoElement(source.unchecked_into())
        } else if source.is_instance_of::<web_sys::HtmlCanvasElement>() {
            wgpu::ExternalImageSource::HTMLCanvasElement(source.unchecked_into())
        } else if source.is_instance_of::<web_sys::OffscreenCanvas>() {
            wgpu::ExternalImageSource::OffscreenCanvas(source.unchecked_into())
        } else if source.is_instance_of::<web_sys::ImageBitmap>() {
            wgpu::ExternalImageSource::ImageBitmap(source.unchecked_into())
        } else if source.is_instance_of::<web_sys::HtmlImageElement>() {
            wgpu::ExternalImageSource::HTMLImageElement(source.unchecked_into())
        } else if source.is_instance_of::<web_sys::ImageData>() {
            wgpu::ExternalImageSource::ImageData(source.unchecked_into())
        } else {
            return Err(JsValue::from_str(
                "copyExternalImageToTexture: unsupported source (expected video, canvas, OffscreenCanvas, ImageBitmap, image or ImageData)",
            ));
        };
        let source = wgpu::CopyExternalImageSourceInfo {
            source,
            origin: wgpu::Origin2d {
                x: source_origin_x,
                y: source_origin_y,
            },
            flip_y,
        };
        let dest = wgpu::CopyExternalImageDestInfo {
            texture: &texture.inner,
            mip_level,
            origin: wgpu::Origin3d {
                x: origin_x,
                y: origin_y,
                z: origin_z,
            },
            aspect: aspect_from_u8(aspect),
            color_space: if display_p3 {
                wgpu::PredefinedColorSpace::DisplayP3
            } else {
                wgpu::PredefinedColorSpace::Srgb
            },
            premultiplied_alpha,
        };
        let size = wgpu::Extent3d {
            width: size_width,
            height: size_height,
            depth_or_array_layers: size_depth,
        };
        self.inner
            .copy_external_image_to_texture(&source, dest, size);
        Ok(())
    }
}

/// bug-20260610 helper: aspect-string discriminator packed into a u8 so the
/// wasm boundary stays primitive. 0 = all (default), 1 = stencil-only,
/// 2 = depth-only.
fn aspect_from_u8(n: u8) -> wgpu::TextureAspect {
    match n {
        1 => wgpu::TextureAspect::StencilOnly,
        2 => wgpu::TextureAspect::DepthOnly,
        _ => wgpu::TextureAspect::All,
    }
}

// ============================================================================
// RhiWgpuCommandEncoder — beginRenderPass + finish (w10)
// ============================================================================

#[wasm_bindgen]
impl RhiWgpuCommandEncoder {
    #[wasm_bindgen(js_name = beginComputePass, catch)]
    pub fn begin_compute_pass(&mut self, desc_js: JsValue) -> Result<RhiWgpuComputePass, JsValue> {
        let label = if desc_js.is_undefined() || desc_js.is_null() {
            None
        } else {
            js_sys::Reflect::get(&desc_js, &JsValue::from_str("label"))
                .ok()
                .and_then(|value| value.as_string())
                .map(leak_str)
        };
        let timestamp_writes: Option<wgpu::ComputePassTimestampWrites<'static>> =
            match js_sys::Reflect::get(&desc_js, &JsValue::from_str("timestampWrites")) {
                Ok(js) if !js.is_null() && !js.is_undefined() => {
                    let query_set = js_sys::Reflect::get(
                        &js,
                        &JsValue::from_str("querySet"),
                    )
                    .map_err(|_| JsValue::from_str("timestampWrites missing querySet"))?;
                    let beginning = js_sys::Reflect::get(
                        &js,
                        &JsValue::from_str("beginningOfPassWriteIndex"),
                    )
                    .ok()
                    .and_then(|value| value.as_f64())
                    .map(|value| value as u32);
                    let end = js_sys::Reflect::get(
                        &js,
                        &JsValue::from_str("endOfPassWriteIndex"),
                    )
                    .ok()
                    .and_then(|value| value.as_f64())
                    .map(|value| value as u32);
                    Some(wgpu::ComputePassTimestampWrites {
                        query_set: query_set_borrow(
                            &query_set,
                            "beginComputePass.timestampWrites.querySet",
                        )?,
                        beginning_of_pass_write_index: beginning,
                        end_of_pass_write_index: end,
                    })
                }
                _ => None,
            };
        let desc = wgpu::ComputePassDescriptor {
            label,
            timestamp_writes,
        };
        let encoder = self.inner.as_mut().expect("CommandEncoder already consumed");
        let pass = encoder.begin_compute_pass(&desc);
        // SAFETY: the pass is dropped by end() before the encoder can be finished,
        // matching the existing render-pass lifetime bridge above.
        let pass_static: wgpu::ComputePass<'static> = unsafe { core::mem::transmute(pass) };
        Ok(RhiWgpuComputePass { inner: Some(pass_static) })
    }

    #[wasm_bindgen(js_name = beginRenderPass, catch)]
    pub fn begin_render_pass(&mut self, desc_js: JsValue) -> Result<RhiWgpuRenderPass, JsValue> {
        let mut desc: RenderPassDescriptorJs = serde_wasm_bindgen::from_value(desc_js.clone())?;
        let colors: js_sys::Array = js_sys::Reflect::get(&desc_js, &JsValue::from_str("colorAttachments"))
            .map_err(|_| JsValue::from_str("missing colorAttachments"))?
            .dyn_into().map_err(|_| JsValue::from_str("colorAttachments is not an array"))?;
        for (index, attachment) in desc.color_attachments.iter_mut().enumerate() {
            let entry = colors.get(index as u32);
            let view_js = js_sys::Reflect::get(&entry, &JsValue::from_str("view"))
                .map_err(|_| JsValue::from_str("colorAttachment missing view"))?;
            let token = read_token(&view_js, "beginRenderPass.colorAttachment.view")?;
            attachment.view = Some(lookup_texture_view(token).ok_or_else(|| {
                JsValue::from_str(&format!("[wgpu-wasm v18] textureView token {token} not in registry"))
            })?);
            if let Ok(resolve_js) = js_sys::Reflect::get(&entry, &JsValue::from_str("resolveTarget")) {
                if !resolve_js.is_null() && !resolve_js.is_undefined() {
                    let token = read_token(&resolve_js, "beginRenderPass.colorAttachment.resolveTarget")?;
                    attachment.resolve_target = Some(lookup_texture_view(token).ok_or_else(|| {
                        JsValue::from_str(&format!("[wgpu-wasm v18] resolveTarget token {token} not in registry"))
                    })?);
                }
            }
        }
        if let Some(attachment) = desc.depth_stencil_attachment.as_mut() {
            let depth_js = js_sys::Reflect::get(&desc_js, &JsValue::from_str("depthStencilAttachment"))
                .map_err(|_| JsValue::from_str("missing depthStencilAttachment"))?;
            let view_js = js_sys::Reflect::get(&depth_js, &JsValue::from_str("view"))
                .map_err(|_| JsValue::from_str("depthStencilAttachment missing view"))?;
            let token = read_token(&view_js, "beginRenderPass.depthStencilAttachment.view")?;
            attachment.view = Some(lookup_texture_view(token).ok_or_else(|| {
                JsValue::from_str(&format!("[wgpu-wasm v18] depthStencil view token {token} not in registry"))
            })?);
        }

        // The descriptor owns these temporary clones only for begin_render_pass.
        // wgpu records its own resource references; neither the attachment array
        // nor a leaked TextureView is needed after that call returns.
        let color_attachments: Vec<_> = desc.color_attachments.iter().map(|attachment| {
            Some(wgpu::RenderPassColorAttachment {
                view: attachment.view.as_ref().expect("resolved color view"),
                depth_slice: attachment.depth_slice,
                resolve_target: attachment.resolve_target.as_ref(),
                ops: wgpu::Operations {
                    load: match attachment.load_op.as_ref().unwrap_or(&LoadOpStrJs::Load) {
                        LoadOpStrJs::Load => wgpu::LoadOp::Load,
                        LoadOpStrJs::Clear => wgpu::LoadOp::Clear(attachment.clear_value.unwrap_or(wgpu::Color::BLACK)),
                    },
                    store: attachment.store_op.unwrap_or(wgpu::StoreOp::Store),
                },
            })
        }).collect();
        let depth_stencil = desc.depth_stencil_attachment.as_ref().map(|attachment| {
            wgpu::RenderPassDepthStencilAttachment {
                view: attachment.view.as_ref().expect("resolved depth view"),
                depth_ops: if attachment.depth_read_only { None } else {
                    attachment.depth_load_op.as_ref().map(|op| wgpu::Operations {
                        load: match op {
                            LoadOpStrJs::Load => wgpu::LoadOp::Load,
                            LoadOpStrJs::Clear => wgpu::LoadOp::Clear(attachment.depth_clear_value.unwrap_or(1.0)),
                        },
                        store: attachment.depth_store_op.unwrap_or(wgpu::StoreOp::Store),
                    })
                },
                stencil_ops: if attachment.stencil_read_only { None } else {
                    attachment.stencil_load_op.as_ref().map(|op| wgpu::Operations {
                        load: match op {
                            LoadOpStrJs::Load => wgpu::LoadOp::Load,
                            LoadOpStrJs::Clear => wgpu::LoadOp::Clear(attachment.stencil_clear_value.unwrap_or(0)),
                        },
                        store: attachment.stencil_store_op.unwrap_or(wgpu::StoreOp::Store),
                    })
                },
            }
        });

        let occlusion_query_set = match js_sys::Reflect::get(
            &desc_js,
            &JsValue::from_str("occlusionQuerySet"),
        ) {
            Ok(js) if !js.is_null() && !js.is_undefined() => Some(query_set_borrow(
                &js,
                "beginRenderPass.occlusionQuerySet",
            )?),
            _ => None,
        };
        let timestamp_writes: Option<wgpu::RenderPassTimestampWrites<'static>> =
            match js_sys::Reflect::get(&desc_js, &JsValue::from_str("timestampWrites")) {
                Ok(js) if !js.is_null() && !js.is_undefined() => {
                    let query_set = js_sys::Reflect::get(
                        &js,
                        &JsValue::from_str("querySet"),
                    )
                    .map_err(|_| JsValue::from_str("timestampWrites missing querySet"))?;
                    let beginning = js_sys::Reflect::get(
                        &js,
                        &JsValue::from_str("beginningOfPassWriteIndex"),
                    )
                    .ok()
                    .and_then(|v| v.as_f64())
                    .map(|v| v as u32);
                    let end = js_sys::Reflect::get(
                        &js,
                        &JsValue::from_str("endOfPassWriteIndex"),
                    )
                    .ok()
                    .and_then(|v| v.as_f64())
                    .map(|v| v as u32);
                    Some(wgpu::RenderPassTimestampWrites {
                        query_set: query_set_borrow(
                            &query_set,
                            "beginRenderPass.timestampWrites.querySet",
                        )?,
                        beginning_of_pass_write_index: beginning,
                        end_of_pass_write_index: end,
                    })
                }
                _ => None,
            };

        let rp_desc = wgpu::RenderPassDescriptor {
            label: desc.label.as_deref(),
            color_attachments: &color_attachments,
            depth_stencil_attachment: depth_stencil,
            occlusion_query_set,
            timestamp_writes,
            multiview_mask: None,
        };

        let encoder = self.inner.as_mut().expect("CommandEncoder already consumed");
        // wgpu's explicit lifetime bridge retains its runtime encoder lock.
        let pass = encoder.begin_render_pass(&rp_desc).forget_lifetime();
        Ok(RhiWgpuRenderPass { inner: Some(pass) })
    }

    #[wasm_bindgen(js_name = finish)]
    pub fn finish_encoder(&mut self) -> RhiWgpuCommandBuffer {
        let enc = self.inner.take().expect("CommandEncoder already finished");
        RhiWgpuCommandBuffer { inner: Some(enc.finish()) }
    }

    /// bug-20260610 Gap 12: copyBufferToBuffer per WebGPU spec
    /// `(source, sourceOffset, destination, destinationOffset, size)`.
    #[wasm_bindgen(js_name = copyBufferToBuffer)]
    pub fn copy_buffer_to_buffer(
        &mut self,
        source: &RhiWgpuBuffer,
        source_offset: u64,
        destination: &RhiWgpuBuffer,
        destination_offset: u64,
        size: u64,
    ) {
        if let Some(enc) = self.inner.as_mut() {
            enc.copy_buffer_to_buffer(
                &source.inner, source_offset,
                &destination.inner, destination_offset,
                size,
            );
        }
    }

    /// bug-20260610 Gap 12: copyBufferToTexture flat-args form (handles via
    /// borrowed `&T` so wasm pointers survive across the call — see writeTexture
    /// note about `try_from_js_value` consuming pointers).
    #[wasm_bindgen(js_name = copyBufferToTexture)]
    #[allow(clippy::too_many_arguments)]
    pub fn copy_buffer_to_texture(
        &mut self,
        source_buffer: &RhiWgpuBuffer,
        source_offset: u64,
        source_bytes_per_row: Option<u32>,
        source_rows_per_image: Option<u32>,
        dest_texture: &RhiWgpuTexture,
        dest_mip_level: u32,
        dest_origin_x: u32,
        dest_origin_y: u32,
        dest_origin_z: u32,
        dest_aspect: u8,
        size_width: u32,
        size_height: u32,
        size_depth: u32,
    ) {
        let src = wgpu::TexelCopyBufferInfo {
            buffer: &source_buffer.inner,
            layout: wgpu::TexelCopyBufferLayout {
                offset: source_offset,
                bytes_per_row: source_bytes_per_row,
                rows_per_image: source_rows_per_image,
            },
        };
        let dst = wgpu::TexelCopyTextureInfo {
            texture: &dest_texture.inner,
            mip_level: dest_mip_level,
            origin: wgpu::Origin3d { x: dest_origin_x, y: dest_origin_y, z: dest_origin_z },
            aspect: aspect_from_u8(dest_aspect),
        };
        let size = wgpu::Extent3d {
            width: size_width,
            height: size_height,
            depth_or_array_layers: size_depth,
        };
        if let Some(enc) = self.inner.as_mut() {
            enc.copy_buffer_to_texture(src, dst, size);
        }
    }

    /// bug-20260610 Gap 12: copyTextureToBuffer flat-args form.
    #[wasm_bindgen(js_name = copyTextureToBuffer)]
    #[allow(clippy::too_many_arguments)]
    pub fn copy_texture_to_buffer(
        &mut self,
        source_texture: &RhiWgpuTexture,
        source_mip_level: u32,
        source_origin_x: u32,
        source_origin_y: u32,
        source_origin_z: u32,
        source_aspect: u8,
        dest_buffer: &RhiWgpuBuffer,
        dest_offset: u64,
        dest_bytes_per_row: Option<u32>,
        dest_rows_per_image: Option<u32>,
        size_width: u32,
        size_height: u32,
        size_depth: u32,
    ) {
        let src = wgpu::TexelCopyTextureInfo {
            texture: &source_texture.inner,
            mip_level: source_mip_level,
            origin: wgpu::Origin3d { x: source_origin_x, y: source_origin_y, z: source_origin_z },
            aspect: aspect_from_u8(source_aspect),
        };
        let dst = wgpu::TexelCopyBufferInfo {
            buffer: &dest_buffer.inner,
            layout: wgpu::TexelCopyBufferLayout {
                offset: dest_offset,
                bytes_per_row: dest_bytes_per_row,
                rows_per_image: dest_rows_per_image,
            },
        };
        let size = wgpu::Extent3d {
            width: size_width,
            height: size_height,
            depth_or_array_layers: size_depth,
        };
        if let Some(enc) = self.inner.as_mut() {
            enc.copy_texture_to_buffer(src, dst, size);
        }
    }

    /// bug-20260610 Gap 12: copyTextureToTexture flat-args form.
    #[wasm_bindgen(js_name = copyTextureToTexture)]
    #[allow(clippy::too_many_arguments)]
    pub fn copy_texture_to_texture(
        &mut self,
        source_texture: &RhiWgpuTexture,
        source_mip_level: u32,
        source_origin_x: u32,
        source_origin_y: u32,
        source_origin_z: u32,
        source_aspect: u8,
        dest_texture: &RhiWgpuTexture,
        dest_mip_level: u32,
        dest_origin_x: u32,
        dest_origin_y: u32,
        dest_origin_z: u32,
        dest_aspect: u8,
        size_width: u32,
        size_height: u32,
        size_depth: u32,
    ) {
        let src = wgpu::TexelCopyTextureInfo {
            texture: &source_texture.inner,
            mip_level: source_mip_level,
            origin: wgpu::Origin3d { x: source_origin_x, y: source_origin_y, z: source_origin_z },
            aspect: aspect_from_u8(source_aspect),
        };
        let dst = wgpu::TexelCopyTextureInfo {
            texture: &dest_texture.inner,
            mip_level: dest_mip_level,
            origin: wgpu::Origin3d { x: dest_origin_x, y: dest_origin_y, z: dest_origin_z },
            aspect: aspect_from_u8(dest_aspect),
        };
        let size = wgpu::Extent3d {
            width: size_width,
            height: size_height,
            depth_or_array_layers: size_depth,
        };
        if let Some(enc) = self.inner.as_mut() {
            enc.copy_texture_to_texture(src, dst, size);
        }
    }

    /// bug-20260610 Gap 12: clearBuffer.
    #[wasm_bindgen(js_name = clearBuffer)]
    pub fn clear_buffer(&mut self, buffer: &RhiWgpuBuffer, offset: Option<u64>, size: Option<u64>) {
        if let Some(enc) = self.inner.as_mut() {
            enc.clear_buffer(&buffer.inner, offset.unwrap_or(0), size);
        }
    }

    #[wasm_bindgen(js_name = resolveQuerySet)]
    pub fn resolve_query_set(
        &mut self,
        query_set: &RhiWgpuQuerySet,
        first_query: u32,
        query_count: u32,
        destination: &RhiWgpuBuffer,
        destination_offset: f64,
    ) {
        if let Some(enc) = self.inner.as_mut() {
            enc.resolve_query_set(
                &query_set.inner,
                first_query..first_query + query_count,
                &destination.inner,
                destination_offset as u64,
            );
        }
    }

    #[wasm_bindgen(js_name = pushDebugGroup)]
    pub fn push_debug_group(&mut self, label: String) {
        if let Some(enc) = self.inner.as_mut() {
            enc.push_debug_group(&label);
        }
    }

    #[wasm_bindgen(js_name = popDebugGroup)]
    pub fn pop_debug_group(&mut self) {
        if let Some(enc) = self.inner.as_mut() {
            enc.pop_debug_group();
        }
    }

    #[wasm_bindgen(js_name = insertDebugMarker)]
    pub fn insert_debug_marker(&mut self, label: String) {
        if let Some(enc) = self.inner.as_mut() {
            enc.insert_debug_marker(&label);
        }
    }
}

#[wasm_bindgen]
impl RhiWgpuComputePass {
    #[wasm_bindgen(js_name = setPipeline)]
    pub fn set_pipeline(&mut self, pipeline: &RhiWgpuComputePipeline) {
        if let Some(pass) = self.inner.as_mut() {
            pass.set_pipeline(&pipeline.inner);
        }
    }

    #[wasm_bindgen(js_name = setBindGroup)]
    pub fn set_bind_group(
        &mut self,
        index: u32,
        bind_group: &RhiWgpuBindGroup,
        dynamic_offsets: JsValue,
    ) {
        if let Some(pass) = self.inner.as_mut() {
            let offsets = if dynamic_offsets.is_undefined() || dynamic_offsets.is_null() {
                Vec::new()
            } else if let Ok(array) = dynamic_offsets.dyn_into::<js_sys::Array>() {
                (0..array.length())
                    .map(|i| array.get(i).as_f64().unwrap_or(0.0) as u32)
                    .collect()
            } else {
                Vec::new()
            };
            pass.set_bind_group(index, &bind_group.inner, &offsets);
        }
    }

    #[wasm_bindgen(js_name = dispatchWorkgroups)]
    pub fn dispatch_workgroups(&mut self, x: u32, y: Option<u32>, z: Option<u32>) {
        if let Some(pass) = self.inner.as_mut() {
            pass.dispatch_workgroups(x, y.unwrap_or(1), z.unwrap_or(1));
        }
    }

    #[wasm_bindgen(js_name = dispatchWorkgroupsIndirect)]
    pub fn dispatch_workgroups_indirect(&mut self, buffer: &RhiWgpuBuffer, offset: u64) {
        if let Some(pass) = self.inner.as_mut() {
            pass.dispatch_workgroups_indirect(&buffer.inner, offset);
        }
    }

    #[wasm_bindgen(js_name = end)]
    pub fn end(&mut self) {
        let _pass = self.inner.take();
    }
}

// bug-20260610 Gap 12: the earlier `parse_texel_copy_*` JsValue helpers were
// removed because `try_from_js_value` consumes the JS-side `__wbg_ptr`,
// breaking the writeTexture-then-createView pattern. Each method now takes
// the wasm handle as `&T` and a flat numeric arg list — see
// `aspect_from_u8` above for the shared aspect discriminator.

// Bundle recording retains native resource clones until finish, avoiding
// leaked descriptors or borrowed resources with fabricated static lifetimes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleDescriptor {
    #[serde(default)] label: Option<String>,
    color_formats: Vec<Option<wgpu::TextureFormat>>,
    #[serde(default)] depth_stencil_format: Option<wgpu::TextureFormat>,
    #[serde(default = "one_u32")] sample_count: u32,
    #[serde(default)] depth_read_only: bool,
    #[serde(default)] stencil_read_only: bool,
}

enum BundleCommand {
    Pipeline(wgpu::RenderPipeline),
    Vertex(u32, wgpu::Buffer, u64, Option<u64>),
    Index(wgpu::Buffer, wgpu::IndexFormat, u64, Option<u64>),
    Bind(u32, wgpu::BindGroup, Vec<u32>),
    Draw(u32, u32, u32, u32),
    DrawIndexed(u32, u32, u32, i32, u32),
    Indirect(wgpu::Buffer, u64, bool),
    Push(String), Pop, Marker(String),
}

thread_local! {
    static BUNDLE_REGISTRY: RefCell<HashMap<u32, wgpu::RenderBundle>> = RefCell::new(HashMap::new());
}

#[wasm_bindgen]
pub struct RhiWgpuRenderBundle { token: u32 }

#[wasm_bindgen]
impl RhiWgpuRenderBundle {
    #[wasm_bindgen(getter, js_name = forgeaxToken)]
    pub fn forgeax_token(&self) -> u32 { self.token }
}

impl Drop for RhiWgpuRenderBundle {
    fn drop(&mut self) { BUNDLE_REGISTRY.with(|r| r.borrow_mut().remove(&self.token)); }
}

impl RhiWgpuRenderBundleEncoder {
    fn record(&mut self, command: BundleCommand) -> Result<(), JsValue> {
        self.commands.as_mut().ok_or_else(|| JsValue::from_str("render bundle encoder already finished"))?.push(command);
        Ok(())
    }
}

#[wasm_bindgen]
impl RhiWgpuRenderBundleEncoder {
    #[wasm_bindgen(js_name = setPipeline)]
    pub fn set_pipeline(&mut self, pipeline: &RhiWgpuRenderPipeline) -> Result<(), JsValue> {
        self.record(BundleCommand::Pipeline(pipeline.inner.clone()))
    }
    #[wasm_bindgen(js_name = setVertexBuffer)]
    pub fn set_vertex_buffer(&mut self, slot: u32, buffer: &RhiWgpuBuffer, offset: Option<u64>, size: Option<u64>) -> Result<(), JsValue> {
        self.record(BundleCommand::Vertex(slot, buffer.inner.clone(), offset.unwrap_or(0), size))
    }
    #[wasm_bindgen(js_name = setIndexBuffer)]
    pub fn set_index_buffer(&mut self, buffer: &RhiWgpuBuffer, format: String, offset: Option<u64>, size: Option<u64>) -> Result<(), JsValue> {
        let format = match format.as_str() { "uint16" => wgpu::IndexFormat::Uint16, "uint32" => wgpu::IndexFormat::Uint32, _ => return Err(JsValue::from_str("invalid index format")) };
        self.record(BundleCommand::Index(buffer.inner.clone(), format, offset.unwrap_or(0), size))
    }
    #[wasm_bindgen(js_name = setBindGroup)]
    pub fn set_bind_group(&mut self, index: u32, group: &RhiWgpuBindGroup, offsets: JsValue, start: Option<u32>, length: Option<u32>) -> Result<(), JsValue> {
        let offsets: Vec<u32> = if offsets.is_undefined() { Vec::new() } else { serde_wasm_bindgen::from_value(offsets)? };
        let start = start.unwrap_or(0) as usize;
        let end = start.checked_add(length.map(|v| v as usize).unwrap_or(offsets.len().saturating_sub(start))).ok_or_else(|| JsValue::from_str("invalid dynamic offsets range"))?;
        let selected = offsets.get(start..end).ok_or_else(|| JsValue::from_str("invalid dynamic offsets range"))?.to_vec();
        self.record(BundleCommand::Bind(index, group.inner.clone(), selected))
    }
    #[wasm_bindgen(js_name = draw)]
    pub fn draw(&mut self, count: u32, instances: Option<u32>, first: Option<u32>, first_instance: Option<u32>) -> Result<(), JsValue> {
        self.record(BundleCommand::Draw(count, instances.unwrap_or(1), first.unwrap_or(0), first_instance.unwrap_or(0)))
    }
    #[wasm_bindgen(js_name = drawIndexed)]
    pub fn draw_indexed(&mut self, count: u32, instances: Option<u32>, first: Option<u32>, base: Option<i32>, first_instance: Option<u32>) -> Result<(), JsValue> {
        self.record(BundleCommand::DrawIndexed(count, instances.unwrap_or(1), first.unwrap_or(0), base.unwrap_or(0), first_instance.unwrap_or(0)))
    }
    #[wasm_bindgen(js_name = drawIndirect)]
    pub fn draw_indirect(&mut self, buffer: &RhiWgpuBuffer, offset: u64) -> Result<(), JsValue> { self.record(BundleCommand::Indirect(buffer.inner.clone(), offset, false)) }
    #[wasm_bindgen(js_name = drawIndexedIndirect)]
    pub fn draw_indexed_indirect(&mut self, buffer: &RhiWgpuBuffer, offset: u64) -> Result<(), JsValue> { self.record(BundleCommand::Indirect(buffer.inner.clone(), offset, true)) }
    #[wasm_bindgen(js_name = pushDebugGroup)]
    pub fn push_debug_group(&mut self, label: String) -> Result<(), JsValue> { self.record(BundleCommand::Push(label)) }
    #[wasm_bindgen(js_name = popDebugGroup)]
    pub fn pop_debug_group(&mut self) -> Result<(), JsValue> { self.record(BundleCommand::Pop) }
    #[wasm_bindgen(js_name = insertDebugMarker)]
    pub fn insert_debug_marker(&mut self, label: String) -> Result<(), JsValue> { self.record(BundleCommand::Marker(label)) }
    #[wasm_bindgen(js_name = finish)]
    pub fn finish(&mut self, desc: JsValue) -> Result<RhiWgpuRenderBundle, JsValue> {
        let commands = self.commands.take().ok_or_else(|| JsValue::from_str("render bundle encoder already finished"))?;
        let mut encoder = self.device.create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
            label: self.desc.label.as_deref(), color_formats: &self.desc.color_formats,
            depth_stencil: self.desc.depth_stencil_format.map(|format| wgpu::RenderBundleDepthStencil { format, depth_read_only: self.desc.depth_read_only, stencil_read_only: self.desc.stencil_read_only }),
            sample_count: self.desc.sample_count, multiview: None,
        });
        let mut debug_depth = 0u32;
        for command in &commands {
            match command {
                BundleCommand::Pipeline(p) => encoder.set_pipeline(p),
                BundleCommand::Vertex(slot, b, offset, size) => encoder.set_vertex_buffer(*slot, b.slice(*offset..size.map(|s| offset + s).unwrap_or(b.size()))),
                BundleCommand::Index(b, format, offset, size) => encoder.set_index_buffer(b.slice(*offset..size.map(|s| offset + s).unwrap_or(b.size())), *format),
                BundleCommand::Bind(index, group, offsets) => encoder.set_bind_group(*index, group, offsets),
                BundleCommand::Draw(count, instances, first, first_instance) => encoder.draw(*first..first + count, *first_instance..first_instance + instances),
                BundleCommand::DrawIndexed(count, instances, first, base, first_instance) => encoder.draw_indexed(*first..first + count, *base, *first_instance..first_instance + instances),
                BundleCommand::Indirect(b, offset, false) => encoder.draw_indirect(b, *offset),
                BundleCommand::Indirect(b, offset, true) => encoder.draw_indexed_indirect(b, *offset),
                // wgpu 30 has no bundle debug marker API; preserve balanced scope validation.
                BundleCommand::Push(_label) => debug_depth += 1,
                BundleCommand::Pop => debug_depth = debug_depth.checked_sub(1).ok_or_else(|| JsValue::from_str("unbalanced bundle debug group"))?,
                BundleCommand::Marker(_label) => {},
            }
        }
        if debug_depth != 0 { return Err(JsValue::from_str("unclosed bundle debug group")); }
        let label = if desc.is_undefined() { None } else { js_sys::Reflect::get(&desc, &JsValue::from_str("label"))?.as_string() };
        let bundle = encoder.finish(&wgpu::RenderBundleDescriptor { label: label.as_deref() });
        let token = alloc_token();
        BUNDLE_REGISTRY.with(|r| r.borrow_mut().insert(token, bundle));
        Ok(RhiWgpuRenderBundle { token })
    }
}

// ============================================================================
// RhiWgpuRenderPass — setPipeline / setVertexBuffer / draw / drawIndexed / end (w10)
// ============================================================================

#[wasm_bindgen]
impl RhiWgpuRenderPass {
    #[wasm_bindgen(js_name = executeBundles)]
    pub fn execute_bundles(&mut self, bundles: js_sys::Array) -> Result<(), JsValue> {
        let mut native = Vec::with_capacity(bundles.length() as usize);
        for value in bundles.iter() {
            let token = js_sys::Reflect::get(&value, &JsValue::from_str("forgeaxToken"))?.as_f64().ok_or_else(|| JsValue::from_str("expected a render bundle handle"))? as u32;
            let bundle = BUNDLE_REGISTRY.with(|r| r.borrow().get(&token).cloned()).ok_or_else(|| JsValue::from_str("render bundle handle is no longer live"))?;
            native.push(bundle);
        }
        let pass = self.inner.as_mut().ok_or_else(|| JsValue::from_str("render pass already ended"))?;
        pass.execute_bundles(native.iter());
        Ok(())
    }

    #[wasm_bindgen(js_name = setPipeline)]
    pub fn set_pipeline(&mut self, pipeline: &RhiWgpuRenderPipeline) {
        if let Some(ref mut rp) = self.inner {
            rp.set_pipeline(&pipeline.inner);
        }
    }

    #[wasm_bindgen(js_name = setVertexBuffer)]
    pub fn set_vertex_buffer(&mut self, slot: u32, buffer: &RhiWgpuBuffer, offset: u64, _size: Option<u64>) {
        if let Some(ref mut rp) = self.inner {
            rp.set_vertex_buffer(slot, buffer.inner.slice(offset..));
        }
    }

    #[wasm_bindgen(js_name = draw)]
    pub fn draw(&mut self, vertex_count: u32, instance_count: Option<u32>, first_vertex: u32, first_instance: u32) {
        if let Some(ref mut rp) = self.inner {
            let instances = match instance_count {
                Some(n) => first_instance..first_instance + n,
                None => first_instance..first_instance + 1,
            };
            rp.draw(first_vertex..first_vertex + vertex_count, instances);
        }
    }

    #[wasm_bindgen(js_name = drawIndexed)]
    pub fn draw_indexed(&mut self, index_count: u32, instance_count: Option<u32>, first_index: u32, base_vertex: i32, first_instance: u32) {
        if let Some(ref mut rp) = self.inner {
            let instances = match instance_count {
                Some(n) => first_instance..first_instance + n,
                None => first_instance..first_instance + 1,
            };
            rp.draw_indexed(first_index..first_index + index_count, base_vertex, instances);
        }
    }

    #[wasm_bindgen(js_name = beginOcclusionQuery)]
    pub fn begin_occlusion_query(&mut self, query_index: u32) {
        if let Some(rp) = self.inner.as_mut() {
            rp.begin_occlusion_query(query_index);
        }
    }

    #[wasm_bindgen(js_name = endOcclusionQuery)]
    pub fn end_occlusion_query(&mut self) {
        if let Some(rp) = self.inner.as_mut() {
            rp.end_occlusion_query();
        }
    }

    #[wasm_bindgen(js_name = end)]
    pub fn end(&mut self) {
        let _rp = self.inner.take();
        // wgpu::RenderPass is dropped here — end-of-pass recording complete
    }

    /// bug-20260610 Gap 13: setIndexBuffer per WebGPU spec
    /// `(buffer, format, offset?, size?)`. Format is `'uint16' | 'uint32'`.
    #[wasm_bindgen(js_name = setIndexBuffer)]
    pub fn set_index_buffer(
        &mut self,
        buffer: &RhiWgpuBuffer,
        format: String,
        offset: Option<u64>,
        size: Option<u64>,
    ) {
        if let Some(rp) = self.inner.as_mut() {
            let fmt = match format.as_str() {
                "uint16" => wgpu::IndexFormat::Uint16,
                _ => wgpu::IndexFormat::Uint32,
            };
            let off = offset.unwrap_or(0);
            let total = buffer.inner.size();
            let end = match size { Some(s) => off + s, None => total };
            rp.set_index_buffer(buffer.inner.slice(off..end), fmt);
        }
    }

    /// bug-20260610 Gap 13: setBindGroup variadic spec form. Supports
    /// `(index, bindGroup)` and `(index, bindGroup, dynamicOffsets)` and the
    /// 3-form `(index, bindGroup, dynamicOffsetsData, start, length)`.
    /// Defensive: dynamic offsets default to empty when `dyn_offsets_js` is
    /// undefined / null.
    #[wasm_bindgen(js_name = setBindGroup)]
    pub fn set_bind_group(
        &mut self,
        index: u32,
        bind_group: &RhiWgpuBindGroup,
        dyn_offsets_js: JsValue,
        start: Option<u32>,
        length: Option<u32>,
    ) {
        if let Some(rp) = self.inner.as_mut() {
            let offsets: Vec<u32> = if dyn_offsets_js.is_undefined() || dyn_offsets_js.is_null() {
                Vec::new()
            } else if let Ok(arr) = dyn_offsets_js.clone().dyn_into::<js_sys::Array>() {
                let raw: Vec<u32> = (0..arr.length())
                    .map(|i| arr.get(i).as_f64().unwrap_or(0.0) as u32)
                    .collect();
                let s = start.unwrap_or(0) as usize;
                let len = length.map(|l| l as usize).unwrap_or(raw.len().saturating_sub(s));
                let end = (s + len).min(raw.len());
                raw[s.min(end)..end].to_vec()
            } else if let Ok(u32arr) = dyn_offsets_js.dyn_into::<js_sys::Uint32Array>() {
                let mut v = vec![0u32; u32arr.length() as usize];
                u32arr.copy_to(&mut v);
                let s = start.unwrap_or(0) as usize;
                let len = length.map(|l| l as usize).unwrap_or(v.len().saturating_sub(s));
                let end = (s + len).min(v.len());
                v[s.min(end)..end].to_vec()
            } else {
                Vec::new()
            };
            rp.set_bind_group(index, &bind_group.inner, &offsets);
        }
    }

    #[wasm_bindgen(js_name = setViewport)]
    pub fn set_viewport(
        &mut self,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        min_depth: f32,
        max_depth: f32,
    ) {
        if let Some(rp) = self.inner.as_mut() {
            rp.set_viewport(x, y, width, height, min_depth, max_depth);
        }
    }

    #[wasm_bindgen(js_name = setScissorRect)]
    pub fn set_scissor_rect(&mut self, x: u32, y: u32, w: u32, h: u32) {
        if let Some(rp) = self.inner.as_mut() {
            rp.set_scissor_rect(x, y, w, h);
        }
    }

    #[wasm_bindgen(js_name = setBlendConstant)]
    pub fn set_blend_constant(&mut self, color_js: JsValue) {
        if let Some(rp) = self.inner.as_mut() {
            let color: wgpu::Color = serde_wasm_bindgen::from_value(color_js)
                .unwrap_or(wgpu::Color::BLACK);
            rp.set_blend_constant(color);
        }
    }

    #[wasm_bindgen(js_name = setStencilReference)]
    pub fn set_stencil_reference(&mut self, reference: u32) {
        if let Some(rp) = self.inner.as_mut() {
            rp.set_stencil_reference(reference);
        }
    }

    #[wasm_bindgen(js_name = drawIndirect)]
    pub fn draw_indirect(&mut self, indirect_buffer: &RhiWgpuBuffer, indirect_offset: u64) {
        if let Some(rp) = self.inner.as_mut() {
            rp.draw_indirect(&indirect_buffer.inner, indirect_offset);
        }
    }

    #[wasm_bindgen(js_name = drawIndexedIndirect)]
    pub fn draw_indexed_indirect(&mut self, indirect_buffer: &RhiWgpuBuffer, indirect_offset: u64) {
        if let Some(rp) = self.inner.as_mut() {
            rp.draw_indexed_indirect(&indirect_buffer.inner, indirect_offset);
        }
    }

    #[wasm_bindgen(js_name = pushDebugGroup)]
    pub fn push_debug_group(&mut self, label: String) {
        if let Some(rp) = self.inner.as_mut() {
            rp.push_debug_group(&label);
        }
    }

    #[wasm_bindgen(js_name = popDebugGroup)]
    pub fn pop_debug_group(&mut self) {
        if let Some(rp) = self.inner.as_mut() {
            rp.pop_debug_group();
        }
    }

    #[wasm_bindgen(js_name = insertDebugMarker)]
    pub fn insert_debug_marker(&mut self, label: String) {
        if let Some(rp) = self.inner.as_mut() {
            rp.insert_debug_marker(&label);
        }
    }
}

// ============================================================================
// Surface configuration mirror structs + RhiWgpuSurface impl (w11)
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceConfigurationJs {
    /// Resolved to wgpu::Device reference at call site via RhiWgpuDevice
    #[serde(skip)]
    device: (),
    usage: u32,
    format: wgpu::TextureFormat,
    #[serde(default = "one_u32")]
    width: u32,
    #[serde(default = "one_u32")]
    height: u32,
    #[serde(default = "surface_default_present_mode")]
    present_mode: PresentModeJs,
    #[serde(default)]
    desired_maximum_frame_latency: Option<u32>,
    #[serde(default)]
    alpha_mode: Option<wgpu::CompositeAlphaMode>,
    #[serde(default)]
    view_formats: Vec<wgpu::TextureFormat>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceConfigurationFacts {
    format: String,
    usage: u32,
    width: u32,
    height: u32,
    alpha_mode: String,
    present_mode: String,
}

impl SurfaceConfigurationFacts {
    fn from_requested(desc: &SurfaceConfigurationJs) -> Self {
        Self {
            format: format!("{:?}", desc.format),
            usage: desc.usage,
            width: desc.width,
            height: desc.height,
            alpha_mode: format!("{:?}", desc.alpha_mode.unwrap_or(wgpu::CompositeAlphaMode::Auto)),
            present_mode: format!("{:?}", desc.present_mode),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfacePresentationProofFacts {
    descriptor: bool,
    acquisition: bool,
    validation: bool,
    surface_identity: String,
    requested: SurfaceConfigurationFacts,
    validated: SurfaceConfigurationFacts,
}

fn serialize_surface_presentation_proof(
    configuration: &SurfaceConfigurationFacts,
    acquisition: bool,
    validation: bool,
    surface_identity: String,
) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&SurfacePresentationProofFacts {
        descriptor: true,
        acquisition,
        validation,
        surface_identity,
        requested: configuration.clone(),
        validated: configuration.clone(),
    })
    .map_err(|error| JsValue::from_str(&format!("surface probe serialization failed: {error}")))
}

const fn surface_default_present_mode() -> PresentModeJs {
    PresentModeJs::Fifo
}

fn ensure_surface_configured(configured: bool) -> Result<(), JsValue> {
    if configured {
        Ok(())
    } else {
        Err(JsValue::from_str(
            "getCurrentTexture: surface is not configured",
        ))
    }
}

fn surface_configure_error(
    reason: &str,
    desc: &SurfaceConfigurationJs,
    capabilities: Option<&wgpu::SurfaceCapabilities>,
    device_token: u32,
    surface_identity: u32,
    detail: Option<&str>,
) -> JsValue {
    let supported_usage = capabilities.map(|value| value.usages.bits()).unwrap_or(0);
    let supported_formats = capabilities
        .map(|value| value.formats.iter().map(|format| format!("{format:?}")).collect::<Vec<_>>())
        .unwrap_or_default();
    let supported_present_modes = capabilities
        .map(|value| value.present_modes.iter().map(|mode| format!("{mode:?}")).collect::<Vec<_>>())
        .unwrap_or_default();
    let supported_alpha_modes = capabilities
        .map(|value| value.alpha_modes.iter().map(|mode| format!("{mode:?}")).collect::<Vec<_>>())
        .unwrap_or_default();
    JsValue::from_str(
        &serde_json::json!({
            "code": "surface-configure-failed",
            "reason": reason,
            "detail": detail,
            "requested": {
                "usage": desc.usage,
                "format": format!("{:?}", desc.format),
                "width": desc.width,
                "height": desc.height,
                "alphaMode": format!("{:?}", desc.alpha_mode),
                "presentMode": format!("{:?}", desc.present_mode),
            },
            "supported": {
                "usage": supported_usage,
                "formats": supported_formats,
                "presentModes": supported_present_modes,
                "alphaModes": supported_alpha_modes,
            },
            "deviceToken": device_token,
            "surfaceIdentity": surface_identity,
        })
        .to_string(),
    )
}

fn surface_usage_supported(supported: wgpu::TextureUsages, requested: u32) -> bool {
    wgpu::TextureUsages::from_bits(requested).is_some_and(|requested| supported.contains(requested))
}

#[wasm_bindgen]
impl RhiWgpuSurface {
    /// bug-20260610: spec-aligned single-descriptor `configure(desc)` form.
    /// WebGPU's GPUCanvasContext.configure takes ONE argument (the config
    /// object carries `.device`); the legacy two-arg `(device, desc)` form
    /// failed silently when called through the rhi-wgpu shim's polymorphic
    /// `rawContext.configure(mirrored)` path — the mirrored config object
    /// hit the wasm-bindgen `_assertClass(device, RhiWgpuDevice)` guard,
    /// the throw was caught by the shim, but the surface stayed
    /// unconfigured, so the next `getCurrentTexture()` panicked with
    /// "Surface is not configured for presentation". Reflect the device
    /// handle off the descriptor's `device` field via __wbg_ptr (the
    /// auto-wbg path that wasm-bindgen would use for `&RhiWgpuDevice`)
    /// without consuming it — same pattern as createRenderPipeline's
    /// vertex.module / fragment.module / layout.
    #[wasm_bindgen(js_name = configure, catch)]
    pub fn configure(&self, desc_js: JsValue) -> Result<(), JsValue> {
        // bug-20260610 v17: resolve the device via `desc.device.forgeaxToken`
        // through the thread-local registry. read_wbg_ptr was returning a
        // pointer whose deref produced wgpu_core "Device[Id(0,0)] is no
        // longer alive" panics — same class of failure we hit with
        // shader / pipeline-layout / BGL handles. The registry holds a
        // Clone of the Device for the wasm module's lifetime.
        let desc: SurfaceConfigurationJs = serde_wasm_bindgen::from_value(desc_js.clone())?;
        let device_js = js_sys::Reflect::get(&desc_js, &JsValue::from_str("device"))
            .map_err(|_| JsValue::from_str("configure: descriptor missing device"))?;
        let token = match read_token(&device_js, "configure.device") {
            Ok(token) => token,
            Err(_) => {
                return Err(surface_configure_error(
                    "missing-device-token",
                    &desc,
                    None,
                    0,
                    self.identity,
                    Some("configure.device.forgeaxToken is absent or invalid"),
                ));
            }
        };
        let (device, queue) = lookup_device(token).ok_or_else(|| {
            surface_configure_error("missing-device-token", &desc, None, token, self.identity, None)
        })?;
        let adapter = lookup_device_adapter(token).ok_or_else(|| {
            surface_configure_error("missing-adapter-token", &desc, None, token, self.identity, None)
        })?;
        let capabilities = self.inner.get_capabilities(&adapter);
        let requested_usage = match wgpu::TextureUsages::from_bits(desc.usage) {
            Some(usage) => usage,
            None => {
                return Err(surface_configure_error(
                    "unsupported-usage",
                    &desc,
                    Some(&capabilities),
                    token,
                    self.identity,
                    Some("configure.usage contains unknown texture usage bits"),
                ));
            }
        };
        if !surface_usage_supported(capabilities.usages, desc.usage) {
            return Err(surface_configure_error(
                "unsupported-usage",
                &desc,
                Some(&capabilities),
                token,
                self.identity,
                None,
            ));
        }
        if !capabilities.formats.contains(&desc.format) {
            return Err(surface_configure_error(
                "unsupported-format",
                &desc,
                Some(&capabilities),
                token,
                self.identity,
                None,
            ));
        }
        let present_mode = desc.present_mode.into_wgpu();
        if !capabilities.present_modes.contains(&present_mode) {
            return Err(surface_configure_error(
                "unsupported-present-mode",
                &desc,
                Some(&capabilities),
                token,
                self.identity,
                None,
            ));
        }
        let alpha_mode = desc.alpha_mode.unwrap_or(wgpu::CompositeAlphaMode::Auto);
        if !capabilities.alpha_modes.contains(&alpha_mode) {
            return Err(surface_configure_error(
                "unsupported-alpha-mode",
                &desc,
                Some(&capabilities),
                token,
                self.identity,
                None,
            ));
        }
        let previous_error = take_uncaptured_error();
        let view_formats: Vec<wgpu::TextureFormat> = desc.view_formats.clone();
        let config = wgpu::SurfaceConfiguration {
            usage: requested_usage,
            format: desc.format,
            width: desc.width,
            height: desc.height,
            present_mode,
            desired_maximum_frame_latency: desc.desired_maximum_frame_latency.unwrap_or(2),
            alpha_mode,
            view_formats,
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        self.inner.configure(&device, &config);
        if let Some(message) = take_uncaptured_error() {
            let detail = match previous_error {
                Some(previous) => format!("previous_uncaptured_error={previous}; configure_error={message}"),
                None => message,
            };
            *self.configuration.borrow_mut() = None;
            return Err(surface_configure_error(
                "validation-error",
                &desc,
                Some(&capabilities),
                token,
                self.identity,
                Some(&detail),
            ));
        }
        if let Some(previous) = previous_error {
            store_uncaptured_error(previous);
        }
        let configuration = SurfaceConfigurationFacts::from_requested(&desc);
        *self.configuration.borrow_mut() = Some((configuration, queue));
        Ok(())
    }

    /// Probe the configured concrete presentation surface. Acquisition and
    /// validation are established by acquiring and presenting one real surface
    /// image; this method does not claim pixel readback.
    #[wasm_bindgen(js_name = probeSurfacePresentation)]
    pub fn probe_surface_presentation(&self) -> Result<JsValue, JsValue> {
        let configuration = self.configuration.borrow().clone();
        if configuration.is_none() {
            return Err(JsValue::from_str(
                &serde_json::json!({
                    "code": "surface-probe-failed",
                    "reason": "surface-not-configured",
                    "surfaceIdentity": format!("wgpu-surface:{}", self.identity),
                })
                .to_string(),
            ));
        }
        let (configuration, queue) = configuration.as_ref().expect("configuration checked above");
        let (acquisition, validation) = match self.inner.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture)
            | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => {
                let previous_error = take_uncaptured_error();
                queue.present(texture);
                let present_error = take_uncaptured_error();
                if let Some(previous) = previous_error {
                    store_uncaptured_error(previous);
                }
                if let Some(detail) = present_error {
                    return Err(JsValue::from_str(
                        &serde_json::json!({
                            "code": "surface-probe-failed",
                            "reason": "device-operation-failed",
                            "detail": detail,
                            "surfaceIdentity": format!("wgpu-surface:{}", self.identity),
                        })
                        .to_string(),
                    ));
                }
                (true, true)
            }
            _ => (false, false),
        };
        serialize_surface_presentation_proof(
            configuration,
            acquisition,
            validation,
            format!("wgpu-surface:{}", self.identity),
        )
    }

    #[wasm_bindgen(js_name = getCurrentTexture, catch)]
    pub fn get_current_texture(&self) -> Result<RhiWgpuSurfaceTexture, JsValue> {
        let configuration = self.configuration.borrow();
        ensure_surface_configured(configuration.is_some())?;
        let queue = &configuration.as_ref().expect("configuration checked above").1;
        match self.inner.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(st) => {
                Ok(RhiWgpuSurfaceTexture { inner: Some(st), surface_identity: self.identity, queue: queue.clone() })
            }
            wgpu::CurrentSurfaceTexture::Suboptimal(st) => {
                Ok(RhiWgpuSurfaceTexture { inner: Some(st), surface_identity: self.identity, queue: queue.clone() })
            }
            wgpu::CurrentSurfaceTexture::Timeout => {
                Err(JsValue::from_str("getCurrentTexture timed out"))
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                Err(JsValue::from_str("getCurrentTexture: surface outdated, reconfigure"))
            }
            wgpu::CurrentSurfaceTexture::Lost => {
                Err(JsValue::from_str("getCurrentTexture: surface lost, recreate"))
            }
            wgpu::CurrentSurfaceTexture::Occluded => {
                Err(JsValue::from_str("getCurrentTexture: surface occluded"))
            }
            _ => Err(JsValue::from_str("getCurrentTexture: unknown error")),
        }
    }
}

#[wasm_bindgen]
impl RhiWgpuSurfaceTexture {
    /// bug-20260610: clone the inner Texture (wgpu::Texture is Arc-Clone)
    /// rather than ptr::read + mem::forget'ing the SurfaceTexture. The
    /// previous shape leaked the SurfaceTexture forever, so wgpu_core
    /// never saw the previous frame's release and panicked
    /// "Surface image is already acquired" on the second
    /// `getCurrentTexture()`. The new shape keeps the SurfaceTexture in
    /// `self.inner` so the JS-side `present()` call (added below) can
    /// release it.
    #[wasm_bindgen(js_name = getTexture)]
    pub fn get_texture(&self) -> RhiWgpuTexture {
        let st = self.inner.as_ref().expect("SurfaceTexture already consumed");
        RhiWgpuTexture { inner: st.texture.clone() }
    }

    /// bug-20260610: spec-shaped `present()` so the runtime per-frame loop
    /// can release the acquired surface image after queue.submit. Without
    /// this the next frame's `getCurrentTexture()` panics inside
    /// wgpu_core::Storage with "Surface image is already acquired".
    /// WebGPU spec auto-presents on next browser frame, but wgpu's GLES /
    /// native backend requires explicit present (mirrors the requestSurface
    /// flow in winit / glutin programs).
    #[wasm_bindgen(js_name = present)]
    pub fn present(&mut self) -> Result<(), JsValue> {
        if let Some(st) = self.inner.take() {
            self.queue.present(st);
            if let Some(message) = take_uncaptured_error() {
                return Err(JsValue::from_str(
                    &serde_json::json!({
                        "code": "surface-present-failed",
                        "reason": "device-operation-failed",
                        "detail": message,
                        "surfaceIdentity": format!("wgpu-surface:{}", self.surface_identity),
                    })
                    .to_string(),
                ));
            }
        }
        Ok(())
    }
}

// ============================================================================
// Mirror structs for RenderPipeline sub-descriptors (w4)
// ============================================================================

/// bug-20260610: WebGPU spec `cullMode` is `'none' | 'front' | 'back'` but
/// wgpu's `Face` is `Front | Back` only — "no culling" is `cull_mode: None`
/// in Rust. Mirror the spec value set as a separate enum and project to
/// `Option<wgpu::Face>` at conversion time so descriptors that pass
/// `cullMode: 'none'` (e.g. tonemap, FXAA, fullscreen post-process passes)
/// don't blow up at deserialization.
#[derive(serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CullModeJs {
    None,
    Front,
    Back,
}
impl CullModeJs {
    fn into_wgpu(self) -> Option<wgpu::Face> {
        match self {
            CullModeJs::None => None,
            CullModeJs::Front => Some(wgpu::Face::Front),
            CullModeJs::Back => Some(wgpu::Face::Back),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrimitiveStateJs {
    #[serde(default)]
    topology: Option<wgpu::PrimitiveTopology>,
    #[serde(default)]
    strip_index_format: Option<wgpu::IndexFormat>,
    #[serde(default)]
    front_face: Option<wgpu::FrontFace>,
    #[serde(default)]
    cull_mode: Option<CullModeJs>,
    #[serde(default)]
    unclipped_depth: Option<bool>,
    #[serde(default)]
    polygon_mode: Option<wgpu::PolygonMode>,
    #[serde(default)]
    conservative: Option<bool>,
}
impl PrimitiveStateJs {
    fn into_wgpu(self) -> wgpu::PrimitiveState {
        wgpu::PrimitiveState {
            topology: self.topology.unwrap_or(wgpu::PrimitiveTopology::TriangleList),
            strip_index_format: self.strip_index_format,
            front_face: self.front_face.unwrap_or(wgpu::FrontFace::Ccw),
            cull_mode: self.cull_mode.and_then(|c| c.into_wgpu()),
            unclipped_depth: self.unclipped_depth.unwrap_or(false),
            polygon_mode: self.polygon_mode.unwrap_or(wgpu::PolygonMode::Fill),
            conservative: self.conservative.unwrap_or(false),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DepthStencilStateJs {
    format: wgpu::TextureFormat,
    #[serde(default)]
    depth_write_enabled: bool,
    #[serde(default)]
    depth_compare: Option<wgpu::CompareFunction>,
    // GPUDepthStencilState keeps the stencil face states and masks at the
    // top level. The RHI descriptor mirrors that WebGPU shape; nesting these
    // fields under `stencil` silently dropped every custom stencil state on
    // the WebGL2/WASM fallback path.
    #[serde(default)]
    stencil_front: Option<StencilFaceStateJs>,
    #[serde(default)]
    stencil_back: Option<StencilFaceStateJs>,
    #[serde(default)]
    stencil_read_mask: Option<u32>,
    #[serde(default)]
    stencil_write_mask: Option<u32>,
    // GPUDepthStencilState keeps depth bias as three top-level fields. The
    // RHI descriptor mirrors that WebGPU shape; nesting them under `bias`
    // silently drops every authored depth-bias value on the WebGL2 fallback.
    #[serde(default)]
    depth_bias: Option<i32>,
    #[serde(default)]
    depth_bias_slope_scale: Option<f32>,
    #[serde(default)]
    depth_bias_clamp: Option<f32>,
}
impl DepthStencilStateJs {
    fn into_wgpu(self) -> wgpu::DepthStencilState {
        wgpu::DepthStencilState {
            format: self.format,
            depth_write_enabled: Some(self.depth_write_enabled),
            depth_compare: self.depth_compare,
            stencil: wgpu::StencilState {
                front: self.stencil_front.map(|f| f.into_wgpu()).unwrap_or_default(),
                back: self.stencil_back.map(|b| b.into_wgpu()).unwrap_or_default(),
                read_mask: self.stencil_read_mask.unwrap_or(u32::MAX),
                write_mask: self.stencil_write_mask.unwrap_or(u32::MAX),
            },
            bias: wgpu::DepthBiasState {
                constant: self.depth_bias.unwrap_or(0),
                slope_scale: self.depth_bias_slope_scale.unwrap_or(0.0),
                clamp: self.depth_bias_clamp.unwrap_or(0.0),
            },
        }
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StencilFaceStateJs {
    #[serde(default)]
    compare: Option<wgpu::CompareFunction>,
    #[serde(default)]
    fail_op: Option<wgpu::StencilOperation>,
    #[serde(default)]
    depth_fail_op: Option<wgpu::StencilOperation>,
    #[serde(default)]
    pass_op: Option<wgpu::StencilOperation>,
}
impl StencilFaceStateJs {
    fn into_wgpu(self) -> wgpu::StencilFaceState {
        wgpu::StencilFaceState {
            compare: self.compare.unwrap_or(wgpu::CompareFunction::Always),
            fail_op: self.fail_op.unwrap_or(wgpu::StencilOperation::Keep),
            depth_fail_op: self.depth_fail_op.unwrap_or(wgpu::StencilOperation::Keep),
            pass_op: self.pass_op.unwrap_or(wgpu::StencilOperation::Keep),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MultisampleStateJs {
    #[serde(default = "one_u32")]
    count: u32,
    #[serde(default)]
    mask: Option<u64>,
    #[serde(default)]
    alpha_to_coverage_enabled: Option<bool>,
}
impl MultisampleStateJs {
    fn into_wgpu(self) -> wgpu::MultisampleState {
        wgpu::MultisampleState {
            count: self.count,
            mask: self.mask.unwrap_or(u64::MAX),
            alpha_to_coverage_enabled: self.alpha_to_coverage_enabled.unwrap_or(false),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlendStateJs {
    color: BlendComponentJs,
    alpha: BlendComponentJs,
}
impl BlendStateJs {
    fn into_wgpu(self) -> wgpu::BlendState {
        wgpu::BlendState {
            color: self.color.into_wgpu(),
            alpha: self.alpha.into_wgpu(),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlendComponentJs {
    #[serde(default)]
    operation: Option<wgpu::BlendOperation>,
    #[serde(default)]
    src_factor: Option<wgpu::BlendFactor>,
    #[serde(default)]
    dst_factor: Option<wgpu::BlendFactor>,
}
impl BlendComponentJs {
    fn into_wgpu(self) -> wgpu::BlendComponent {
        wgpu::BlendComponent {
            operation: self.operation.unwrap_or(wgpu::BlendOperation::Add),
            src_factor: self.src_factor.unwrap_or(wgpu::BlendFactor::One),
            dst_factor: self.dst_factor.unwrap_or(wgpu::BlendFactor::Zero),
        }
    }
}

// ============================================================================
// RenderPass descriptor mirror structs (w10)
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderPassDescriptorJs {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    color_attachments: Vec<RenderPassColorAttachmentJs>,
    #[serde(default)]
    depth_stencil_attachment: Option<RenderPassDepthStencilAttachmentJs>,
}

/// bug-20260610: WebGPU spec ships `loadOp` / `storeOp` as separate kebab-case
/// strings + `clearValue` as a flat `{r,g,b,a}` dict, not a tagged enum
/// payload. The earlier `Option<wgpu::LoadOp<wgpu::Color>>` deserialization
/// blew up with "invalid type: unit value, expected f32 / wgpu::Color"
/// because serde tried to fill the `Clear` variant's payload from the bare
/// string `"clear"`. We mirror the spec shape and reassemble `wgpu::LoadOp`
/// at the call site.
#[derive(Debug, PartialEq, Default)]
enum LoadOpStrJs {
    #[default]
    Load,
    Clear,
}
impl<'de> serde::Deserialize<'de> for LoadOpStrJs {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <String as serde::Deserialize>::deserialize(d)?;
        match s.as_str() {
            "load" => Ok(LoadOpStrJs::Load),
            "clear" => Ok(LoadOpStrJs::Clear),
            other => Err(serde::de::Error::custom(format!("unknown loadOp '{other}' (expected 'load' | 'clear')"))),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderPassColorAttachmentJs {
    /// Borrowed JS handle resolved to an owned temporary clone for pass creation.
    #[serde(skip)]
    view: Option<wgpu::TextureView>,
    #[serde(default)]
    depth_slice: Option<u32>,
    #[serde(skip)]
    resolve_target: Option<wgpu::TextureView>,
    #[serde(default)]
    load_op: Option<LoadOpStrJs>,
    #[serde(default)]
    store_op: Option<wgpu::StoreOp>,
    #[serde(default)]
    clear_value: Option<wgpu::Color>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderPassDepthStencilAttachmentJs {
    #[serde(skip)]
    view: Option<wgpu::TextureView>,
    #[serde(default)]
    depth_load_op: Option<LoadOpStrJs>,
    #[serde(default)]
    depth_store_op: Option<wgpu::StoreOp>,
    #[serde(default)]
    depth_clear_value: Option<f32>,
    #[serde(default)]
    stencil_load_op: Option<LoadOpStrJs>,
    #[serde(default)]
    stencil_store_op: Option<wgpu::StoreOp>,
    #[serde(default)]
    stencil_clear_value: Option<u32>,
    #[serde(default)]
    depth_read_only: bool,
    #[serde(default)]
    stencil_read_only: bool,
}

#[cfg(test)]
mod tests;
