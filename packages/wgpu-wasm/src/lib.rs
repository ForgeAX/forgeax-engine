// packages/wgpu-wasm/src/lib.rs — merged wgpu + naga wasm-bindgen entry point.
//
// This crate is the merged Rust side of @forgeax/engine-wgpu-wasm — it bundles two
// distinct wasm-bindgen surfaces into one wasm artefact:
//
//   - rhi.rs   — wgpu 30 RHI raw bindings (14 opaque handles + 17 descriptor
//                fields + factory entry points + queue / command-encoder
//                operations). Consumed by @forgeax/engine-rhi-wgpu thin shell.
//   - naga.rs  — naga 30 three-phase shader pipeline (parse / validate /
//                emit_reflection) with opaque ParsedModule / ValidatedModule
//                handles. Consumed by @forgeax/engine-naga thin shell.
//   - errors.rs — shared helpers for wasm-bindgen <-> JS error marshalling
//                across both surfaces.
//
// Form invariants (plan-strategy D-P1 / D-P2 + research F-1 / F-2 / F-3):
//
// - One wasm artefact, two TS-side namespaces (charter proposition 5: a
//   single shared bundle reduces double-download cost; both rhi-wgpu and
//   naga share wgpu/naga via Cargo dedup F-2).
// - `console_error_panic_hook` installed on entry (#[wasm_bindgen(start)]):
//   any Rust panic surfaces in the JS console as a structured trace.
// - `pub use rhi::*; pub use naga::*;` re-exports both surface namespaces at
//   the crate root so wasm-bindgen generates a single flat JS module
//   (consumers reach symbols via `wasm.parse(source)` / `wasm.requestAdapter()`
//   etc., regardless of which module file the export lives in).

use wasm_bindgen::prelude::*;

mod compose;
mod errors;
mod naga;
mod rhi;

pub use crate::compose::*;
pub use crate::naga::*;
pub use crate::rhi::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}
