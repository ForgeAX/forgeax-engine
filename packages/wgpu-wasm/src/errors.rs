// packages/wgpu-wasm/src/errors.rs — shared wasm-bindgen <-> JS error helpers.
//
// Populated in w2: extract shared payload-carrying error helpers from the two
// archived legacy wasm-pack crates (rhi-wgpu/crate/src/lib.rs + the naga shim
// lib.rs; both removed in feat-20260511-naga-rhi-wgpu-merge M5) — e.g. a
// to_js_value_with_payload<T: Serialize> generic that both surfaces use to
// throw structured JsError instances with .line_num / .line_pos / .reason
// fields readable by the JS-side wrap layer.
//
// Research F-3 §"shared bottom layer" estimates this dedup saves 10-15% on
// the merged wasm binary by avoiding duplicate monomorphisations across the
// two surfaces.
