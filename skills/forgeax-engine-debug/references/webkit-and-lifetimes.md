# WebKit and GPU lifetime troubleshooting

Use this reference for WebKit surface failures and monotonic GPU-resource growth.

## webkit mesh SSBO ceiling 0

**Signal**: Safari/WKWebView scene is black or loses meshes with mesh-ssbo-ceiling-reached; Chromium/Dawn work.

**Cause**: Channel 3 requests downlevel_webgl2_defaults with max_storage_buffer_binding_size=0. growMeshSsbo treated zero as a real ceiling; render-system-record then skipped the entire frame on capacity failure.

**Check**:

```bash
# Check for deriveStorageBufferCeiling, introduced by R5 M1.
grep -n "deriveStorageBufferCeiling" packages/runtime/src/createRenderer.ts
# Missing helper plus zero-ceiling frame skips identifies the old defect.
```

**Repair** (implemented in R5 M1-M2):

(a) deriveStorageBufferCeiling uses positive maxStorageBufferBindingSize; for zero/undefined, falls back through maxBufferSize, maxUniformBufferBindingSize, then the 128 MiB specification floor.

(b) Capacity failure renders validatedOrdered.slice(0, degradedToSlotCount), discards overflow, and fires mesh-ssbo-capacity-exceeded with requested/capacity/ceiling. It no longer skips the whole frame.

(c) Existing onError subscribers receive the degradation signal without a new API or error-union member.

Owners: runtime/createRenderer.ts deriveStorageBufferCeiling/growMeshSsbo and render-system-record.ts ensureMeshSsboCapacity.

---

## WebKit black output after submit

**Signal**: Channel 3 becomes black after submit; later submissions fail without onError or crash logs. Chromium/Dawn work.

**Cause**: wgpu queue_submit routes errors through an error sink, but no on_uncaptured_error callback forwarded them to JS. This is disconnected error reporting, not a catchable panic. wasm32 panic=abort prevents catch_unwind recovery; asynchronous pop_error_scope would break the synchronous contract.

**Check**:

```bash
# Check rhi.rs for on_uncaptured_error registration, introduced by R5 M4.
grep -n "on_uncaptured_error" packages/wgpu-wasm/src/rhi.rs
# Missing registration leaves submit validation errors invisible to JS.
```

**Repair** (R5 M3-M4):

(a) Register on_uncaptured_error during device initialization using the existing Closure::wrap pattern; write validation/OOM/internal errors into a per-queue thread-local slot.

(b) Rust submit uses wasm_bindgen(catch) and returns Result. After inner.submit, read/clear the slot and return JsValue with stable [rhi-code:<code>] prefix. TS queue.ts routes queue-submit-failed to queueSubmitFailed and other cases to webgpuRuntimeError, reusing existing codes.

(c) Submission validation reaches onError while the instance remains alive; the next frame can submit (AC-06). No new switch cases are needed.

Owners: wgpu-wasm/src/rhi.rs initialization, submit, classify_uncaptured_error; rhi-wgpu/src/queue.ts classifySubmitError.

---

## webkit probe renderer GC finalize

**Signal**: a Channel 3 Playwright probe panics Surface[Id(0,N)] does not exist / Unreachable code and captures black. The same binary's hello-triangle entry works even when copied to another filename; only probe content triggers it.

**Cause**: a finite probe loop returns from main without retaining Renderer. WebKit GC finalizes the wasm-bindgen wrapper and destroys the Rust Surface; later presentation reaches a freed slot. The normal recursive rAF closure retains Renderer.

**Falsifier**: retaining renderer on window after Engine.create eliminates the panic; removing that reference restores it.

**Repair the probe**: retain Renderer for the module lifetime, such as win().__r5Renderer, also usable by E2E reads. Continuous production frame loops already retain it.

**Adjacent probe defects**:
1. A center-pixel-only check misses a valid rendered strip; sample a grid across the canvas.
2. Requesting a second GL adapter without compatibleSurface fails. Use renderer.device to test survival of the same renderer. A bad-submit probe can copy a buffer to itself, destroy it before submit, then submit.

Owners: hello-triangle/src/r5-probe.ts and scripts/dev-verify/verify-webkit-r5-stability.mjs.

---

## Monotonic GPU resource growth

**Signal**: sustained spawn/despawn or scene switching increases buffer/texture/cubemap counts and GPU memory; gpuStore maps never shrink.

**Missing symmetric release families**:

| Family | Leak | Owner | Mechanism |
|:--|:--|:--|:--|
| A | Missing per-handle eviction or unconsumed shared-release evidence | gpu-resource-store.ts and renderer owner effect | SharedRefStore count reaches zero, but the GPU resource remains until its owner consumes release evidence. |
| B | Delete/overwrite instance buffer without destruction | render-system-record.ts shadow/main/sprite caches | JS drops wrappers while GPU buffers remain allocated. |
| C | Old-size transient textures stranded after resize | render-graph/src/graph.ts transientPool | Dimension-bearing keys are never reused after resize. |
| D | Historical handleToId strong-map retention | render-system-record.ts/render-system.ts | Removed by nested WeakMaps keyed by handle objects; GC reclaims dead handles without numeric IDs/string keys. |

**Check**:

```bash
# A: verify public per-handle eviction for all store maps.
grep -n "evictTexture\|evictMesh\|evictCubemap\|releaseUnreferenced" packages/runtime/src/gpu-resource-store.ts

# B: verify buffer.destroy before instanceBuffers.delete.
grep -n "instanceBuffers.delete\|instanceBuffers.set" packages/runtime/src/render-system-record.ts

# C: verify drainTransient on resize.
grep -n "drainTransient\|setSwapChainSize" packages/render-graph/src/graph.ts

# D: confirm removed handleToId symbols stay absent.
grep -n "handleToId\|nextHandleId\|getOrAssignHandleId\|buildBindGroupCacheKey" packages/runtime/src/render-system-record.ts
```

**Repair**: the symmetric-release feature added owner-level primitives across these families.

> [!IMPORTANT]
> B/C/D are automatic Engine behavior, requiring no app wiring. A exposes optional eviction/sweep escape hatches for catalog invalidation or device rebuild; ordinary despawn already triggers owner reconciliation.

| Family | Manual app action? | Engine repair | Primitive |
|:--|:--|:--|:--|
| A | Usually no; optional at invalidation/rebuild boundaries | evictTexture/evictMesh/evictCubemap; renderer reconciles live references, with releaseUnreferenced sweep. | Per-handle eviction and current references |
| B | No | Check isDestroyed, destroy before delete, and destroy cached buffers before overwrite; disposeInstanceBuffers reports errors. | Destroy-before-delete/overwrite |
| C | No | drainTransient when compile sees changed swapchain size; destroy any same-key replacement defensively. | Resize drain and replacement guard |
| D | No | Nested Map<entityKey, WeakMap<handle, BG>> replaces handleToId; handles are their own weak keys. | Weak ownership |

Release failures are reported through errorRegistry while sweeping continues; one failed destruction does not abort the frame. SharedRefStore does not invoke owner disposal callbacks.

API/error contracts: packages/runtime/README.md, GPU-asset layers.

**Related**:
- Long-session demolisher stress can expose the same GPUBuffer leak/OOM families.
- Missing worktree assets/build can prevent ensureResident from populating the store, hiding leaks rather than proving eviction.

Do not call releaseUnreferenced(new Set()) as a demo workaround. The renderer must consume release evidence and evict automatically; app-side manual wiring is not required.

For Linux CI smoke failures reporting `A valid external Instance reference no
longer exists`, compare the smoke's actual Chrome launch with the verified
`browser-launch.json` profile before attributing the failure to the renderer.
Custom Shader/Bloom and the RHI capture verifier now align their software ANGLE
and Vulkan choices. Follow the Engine CI guide's **Browser smoke graphics
selection** section and rerun the complete original aggregate; a probe or a
successful recovery does not replace a failed capture.
