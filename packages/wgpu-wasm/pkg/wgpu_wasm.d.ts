/* tslint:disable */
/* eslint-disable */

/**
 * Handle for the `parse` output. JS holds an opaque struct it cannot inspect; the
 * only legal next move is to feed it into `validate` (plan-strategy §S-1 opaque handle).
 */
export class ParsedModule {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class RhiWgpuAdapter {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    requestDevice(options: any): Promise<RhiWgpuDevice>;
    readonly features: Set<any>;
}

export class RhiWgpuBindGroup {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class RhiWgpuBindGroupLayout {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly forgeaxToken: number;
}

export class RhiWgpuBuffer {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    destroy(): void;
    /**
     * JS owns copies only for this mapping lease. Writable copies are
     * committed before native unmap; READ edits are deliberately discarded.
     */
    getMappedRange(offset?: bigint | null, size?: bigint | null): ArrayBuffer;
    /**
     * Start the native mapping before returning its Promise, so unmap can
     * cancel a pending request. Its identity cannot retire a newer mapping.
     */
    mapAsync(mode: number, offset?: bigint | null, size?: bigint | null): Promise<any>;
    unmap(): void;
    readonly forgeaxToken: number;
    readonly mapState: string;
}

export class RhiWgpuCommandBuffer {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class RhiWgpuCommandEncoder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    beginComputePass(desc_js: any): RhiWgpuComputePass;
    beginRenderPass(desc_js: any): RhiWgpuRenderPass;
    /**
     * bug-20260610 Gap 12: clearBuffer.
     */
    clearBuffer(buffer: RhiWgpuBuffer, offset?: bigint | null, size?: bigint | null): void;
    /**
     * bug-20260610 Gap 12: copyBufferToBuffer per WebGPU spec
     * `(source, sourceOffset, destination, destinationOffset, size)`.
     */
    copyBufferToBuffer(source: RhiWgpuBuffer, source_offset: bigint, destination: RhiWgpuBuffer, destination_offset: bigint, size: bigint): void;
    /**
     * bug-20260610 Gap 12: copyBufferToTexture flat-args form (handles via
     * borrowed `&T` so wasm pointers survive across the call — see writeTexture
     * note about `try_from_js_value` consuming pointers).
     */
    copyBufferToTexture(source_buffer: RhiWgpuBuffer, source_offset: bigint, source_bytes_per_row: number | null | undefined, source_rows_per_image: number | null | undefined, dest_texture: RhiWgpuTexture, dest_mip_level: number, dest_origin_x: number, dest_origin_y: number, dest_origin_z: number, dest_aspect: number, size_width: number, size_height: number, size_depth: number): void;
    /**
     * bug-20260610 Gap 12: copyTextureToBuffer flat-args form.
     */
    copyTextureToBuffer(source_texture: RhiWgpuTexture, source_mip_level: number, source_origin_x: number, source_origin_y: number, source_origin_z: number, source_aspect: number, dest_buffer: RhiWgpuBuffer, dest_offset: bigint, dest_bytes_per_row: number | null | undefined, dest_rows_per_image: number | null | undefined, size_width: number, size_height: number, size_depth: number): void;
    /**
     * bug-20260610 Gap 12: copyTextureToTexture flat-args form.
     */
    copyTextureToTexture(source_texture: RhiWgpuTexture, source_mip_level: number, source_origin_x: number, source_origin_y: number, source_origin_z: number, source_aspect: number, dest_texture: RhiWgpuTexture, dest_mip_level: number, dest_origin_x: number, dest_origin_y: number, dest_origin_z: number, dest_aspect: number, size_width: number, size_height: number, size_depth: number): void;
    finish(): RhiWgpuCommandBuffer;
    insertDebugMarker(label: string): void;
    popDebugGroup(): void;
    pushDebugGroup(label: string): void;
    resolveQuerySet(query_set: RhiWgpuQuerySet, first_query: number, query_count: number, destination: RhiWgpuBuffer, destination_offset: number): void;
}

/**
 * Short-lived completion observation, explicitly released by the JS driver.
 */
export class RhiWgpuCompletionRequest {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    poll(): boolean;
}

export class RhiWgpuComputePass {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    dispatchWorkgroupsIndirect(buffer: RhiWgpuBuffer, offset: bigint): void;
    dispatchWorkgroups(x: number, y?: number | null, z?: number | null): void;
    end(): void;
    setBindGroup(index: number, bind_group: RhiWgpuBindGroup, dynamic_offsets: any): void;
    setPipeline(pipeline: RhiWgpuComputePipeline): void;
}

export class RhiWgpuComputePipeline {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class RhiWgpuDevice {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    createBindGroupLayout(desc_js: any): RhiWgpuBindGroupLayout;
    /**
     * Descriptor resources are borrowed through their live tokens. Temporary
     * native clones live only through create_bind_group; wgpu retains its own.
     */
    createBindGroup(desc_js: any): RhiWgpuBindGroup;
    createBuffer(desc_js: any): RhiWgpuBuffer;
    createCommandEncoder(desc_js: any): RhiWgpuCommandEncoder;
    createComputePipeline(desc_js: any, module: RhiWgpuShaderModule, layout?: RhiWgpuPipelineLayout | null): RhiWgpuComputePipeline;
    /**
     * bug-20260610: take ONE descriptor whose `bindGroupLayouts` is an Array
     * of `RhiWgpuBindGroupLayout` handles, mirroring the WebGPU spec
     * (`GPUPipelineLayoutDescriptor.bindGroupLayouts`). The legacy 2-arg form
     * (descriptor + array) was wired through the TS shim's generic `wrap()`
     * helper which calls with **one** arg, so the BGL array always arrived
     * `undefined` and wgpu built a 0-slot layout that later failed validation
     * when bound to a 4-slot pipeline.
     */
    createPipelineLayout(desc_js: any): RhiWgpuPipelineLayout;
    createQuerySet(desc_js: any): RhiWgpuQuerySet;
    createRenderBundleEncoder(desc_js: any): RhiWgpuRenderBundleEncoder;
    /**
     * bug-20260610 Gap 14: refactored to spec-aligned single-descriptor form.
     * The earlier `(desc, vertex_module, fragment_module, layout)` form
     * required the TS shim to extract handles + pass them as separate args
     * — but the shim's generic `wrap()` helper only sends 1 arg, so the
     * other three arrived as `undefined` and `_assertClass` blew up before
     * the body ran. Reflect the handles off the descriptor so the call
     * shape matches the WebGPU spec
     * (`device.createRenderPipeline({layout, vertex:{module,...}, fragment:{module,...}, ...})`).
     */
    createRenderPipeline(desc_js: any): RhiWgpuRenderPipeline;
    createSampler(desc_js: any): RhiWgpuSampler;
    createShaderModule(desc_js: any): RhiWgpuShaderModule;
    /**
     * bug-20260610 Gap 10: device-side texture-view creation. The TS shim
     * (`packages/rhi-wgpu/src/device.ts`) prefers
     * `device.createTextureView(tex, desc)` over `tex.createView(desc)`
     * because some wasm bindings expose `createView` only at the device
     * level. Mirror the spec descriptor surface (label / format / dimension /
     * aspect / mip / array slice).
     */
    createTextureView(texture: RhiWgpuTexture, desc_js: any): RhiWgpuTextureView;
    createTexture(desc_js: any): RhiWgpuTexture;
    registerLostCallback(js_callback: Function): void;
    readonly features: Set<any>;
    readonly forgeaxToken: number;
    /**
     * bug-20260610: surface `wgpu::Limits` to JS as a flat object whose keys
     * match the WebGPU spec / `GPUSupportedLimits` JS naming (camelCase).
     * The TS shim (`packages/rhi-wgpu/src/device.ts`) reads
     * `raw.limits.maxStorageBuffersPerShaderStage` etc. directly into
     * `RhiCaps.storageBuffer`. Without this getter the engine sees `{}` and
     * every limit-gated branch falls through the "WebGPU spec default"
     * happy path — which on the WebGL2 backend explodes inside
     * `Device::create_bind_group_layout` with
     * `Too many bindings of type StorageBuffers in Stage FRAGMENT, limit is 0`.
     *
     * u64 fields are coerced to f64 (JS number) — engine consumers compare
     * against `STORAGE_BUFFER_MIN_REQUIRED` etc. which are <= 2^53, well
     * within JS number precision; downlevel limits never approach the
     * 2^53 boundary so the cast is lossless.
     */
    readonly limits: object;
    readonly queue: RhiWgpuQueue;
    /**
     * Expose the concrete downlevel surface-view capability to the thin
     * TypeScript adapter. This is an internal capability fact, not a public
     * RhiCaps field; render routing consumes it as the dual-view/raw-only
     * surface profile input.
     */
    readonly surfaceViewFormats: boolean;
}

export class RhiWgpuInstance {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    createSurface(canvas: HTMLCanvasElement): RhiWgpuSurface;
    static create(): Promise<RhiWgpuInstance>;
    requestAdapterWithCanvas(canvas: HTMLCanvasElement): Promise<any>;
    requestAdapter(): Promise<any>;
}

export class RhiWgpuPipelineLayout {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly forgeaxToken: number;
}

export class RhiWgpuQuerySet {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class RhiWgpuQueue {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `queue.copyExternalImageToTexture(...)` flat-args form, mirroring
     * writeTexture: the texture is borrowed so its JS pointer survives.
     * WebGL2 has no `texture_external`, so video and canvas sources reach
     * sampled textures only through this copy.
     */
    copyExternalImageToTexture(source: any, source_origin_x: number, source_origin_y: number, flip_y: boolean, texture: RhiWgpuTexture, mip_level: number, origin_x: number, origin_y: number, origin_z: number, aspect: number, display_p3: boolean, premultiplied_alpha: boolean, size_width: number, size_height: number, size_depth: number): void;
    /**
     * The private JS driver owns scheduling and catches native throws/traps.
     * Only the native callback is allowed to report completion.
     */
    onSubmittedWorkDone(driver: Function): Promise<any>;
    submit(buffers: Array<any>): void;
    /**
     * bug-20260610: explicit `js_name = writeBuffer` because wasm-bindgen's
     * default snake_case export (`write_buffer`) does not match the WebGPU
     * spec / TS shim's `queue.writeBuffer(...)` call site.
     *
     * TS shim signature: `writeBuffer(buffer, bufferOffset, data, dataOffset?, size?)`.
     * dataOffset / size are optional in the spec — we honour them by slicing
     * the input bytes before forwarding to wgpu.
     */
    writeBuffer(buffer: RhiWgpuBuffer, buffer_offset: bigint, data: Uint8Array, data_offset?: bigint | null, size?: bigint | null): void;
    /**
     * bug-20260610 Gap 9: `queue.writeTexture(...)` flat-args form.
     *
     * The texture handle MUST come in as a `&RhiWgpuTexture` (borrowed) —
     * `try_from_js_value` would consume the JS-side `__wbg_ptr` (zeroes it),
     * breaking the very common writeTexture-then-createView pattern that
     * the engine uses on every fallback texture in `buildReadyWebGPU`.
     *
     * Layout / origin / size are passed as flat numeric args rather than
     * JsValue to keep the wasm boundary cheap and free of additional
     * Reflect lookups. The TS shim flattens
     * `writeTexture(destination, data, dataLayout, size)` →
     * `writeTexture(destination.texture, mipLevel, originX, originY,
     * originZ, aspect, data, layoutOffset, bytesPerRow, rowsPerImage,
     * sizeWidth, sizeHeight, sizeDepth)`.
     */
    writeTexture(texture: RhiWgpuTexture, mip_level: number, origin_x: number, origin_y: number, origin_z: number, aspect: number, data: Uint8Array, layout_offset: bigint, bytes_per_row: number | null | undefined, rows_per_image: number | null | undefined, size_width: number, size_height: number, size_depth: number): void;
}

export class RhiWgpuRenderBundle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly forgeaxToken: number;
}

export class RhiWgpuRenderBundleEncoder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    drawIndexedIndirect(buffer: RhiWgpuBuffer, offset: bigint): void;
    drawIndexed(count: number, instances?: number | null, first?: number | null, base?: number | null, first_instance?: number | null): void;
    drawIndirect(buffer: RhiWgpuBuffer, offset: bigint): void;
    draw(count: number, instances?: number | null, first?: number | null, first_instance?: number | null): void;
    finish(desc: any): RhiWgpuRenderBundle;
    insertDebugMarker(label: string): void;
    popDebugGroup(): void;
    pushDebugGroup(label: string): void;
    setBindGroup(index: number, group: RhiWgpuBindGroup, offsets: any, start?: number | null, length?: number | null): void;
    setIndexBuffer(buffer: RhiWgpuBuffer, format: string, offset?: bigint | null, size?: bigint | null): void;
    setPipeline(pipeline: RhiWgpuRenderPipeline): void;
    setVertexBuffer(slot: number, buffer: RhiWgpuBuffer, offset?: bigint | null, size?: bigint | null): void;
}

export class RhiWgpuRenderPass {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    beginOcclusionQuery(query_index: number): void;
    drawIndexedIndirect(indirect_buffer: RhiWgpuBuffer, indirect_offset: bigint): void;
    drawIndexed(index_count: number, instance_count: number | null | undefined, first_index: number, base_vertex: number, first_instance: number): void;
    drawIndirect(indirect_buffer: RhiWgpuBuffer, indirect_offset: bigint): void;
    draw(vertex_count: number, instance_count: number | null | undefined, first_vertex: number, first_instance: number): void;
    endOcclusionQuery(): void;
    end(): void;
    executeBundles(bundles: Array<any>): void;
    insertDebugMarker(label: string): void;
    popDebugGroup(): void;
    pushDebugGroup(label: string): void;
    /**
     * bug-20260610 Gap 13: setBindGroup variadic spec form. Supports
     * `(index, bindGroup)` and `(index, bindGroup, dynamicOffsets)` and the
     * 3-form `(index, bindGroup, dynamicOffsetsData, start, length)`.
     * Defensive: dynamic offsets default to empty when `dyn_offsets_js` is
     * undefined / null.
     */
    setBindGroup(index: number, bind_group: RhiWgpuBindGroup, dyn_offsets_js: any, start?: number | null, length?: number | null): void;
    setBlendConstant(color_js: any): void;
    /**
     * bug-20260610 Gap 13: setIndexBuffer per WebGPU spec
     * `(buffer, format, offset?, size?)`. Format is `'uint16' | 'uint32'`.
     */
    setIndexBuffer(buffer: RhiWgpuBuffer, format: string, offset?: bigint | null, size?: bigint | null): void;
    setPipeline(pipeline: RhiWgpuRenderPipeline): void;
    setScissorRect(x: number, y: number, w: number, h: number): void;
    setStencilReference(reference: number): void;
    setVertexBuffer(slot: number, buffer: RhiWgpuBuffer, offset: bigint, _size?: bigint | null): void;
    setViewport(x: number, y: number, width: number, height: number, min_depth: number, max_depth: number): void;
}

export class RhiWgpuRenderPipeline {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class RhiWgpuSampler {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly forgeaxResourceKind: string;
    readonly forgeaxToken: number;
}

export class RhiWgpuShaderModule {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly forgeaxToken: number;
}

export class RhiWgpuSurface {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * bug-20260610: spec-aligned single-descriptor `configure(desc)` form.
     * WebGPU's GPUCanvasContext.configure takes ONE argument (the config
     * object carries `.device`); the legacy two-arg `(device, desc)` form
     * failed silently when called through the rhi-wgpu shim's polymorphic
     * `rawContext.configure(mirrored)` path — the mirrored config object
     * hit the wasm-bindgen `_assertClass(device, RhiWgpuDevice)` guard,
     * the throw was caught by the shim, but the surface stayed
     * unconfigured, so the next `getCurrentTexture()` panicked with
     * "Surface is not configured for presentation". Reflect the device
     * handle off the descriptor's `device` field via __wbg_ptr (the
     * auto-wbg path that wasm-bindgen would use for `&RhiWgpuDevice`)
     * without consuming it — same pattern as createRenderPipeline's
     * vertex.module / fragment.module / layout.
     */
    configure(desc_js: any): void;
    getCurrentTexture(): RhiWgpuSurfaceTexture;
    /**
     * Probe the configured concrete presentation surface. Acquisition and
     * validation are established by acquiring and presenting one real surface
     * image; this method does not claim pixel readback.
     */
    probeSurfacePresentation(): any;
}

export class RhiWgpuSurfaceTexture {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * bug-20260610: clone the inner Texture (wgpu::Texture is Arc-Clone)
     * rather than ptr::read + mem::forget'ing the SurfaceTexture. The
     * previous shape leaked the SurfaceTexture forever, so wgpu_core
     * never saw the previous frame's release and panicked
     * "Surface image is already acquired" on the second
     * `getCurrentTexture()`. The new shape keeps the SurfaceTexture in
     * `self.inner` so the JS-side `present()` call (added below) can
     * release it.
     */
    getTexture(): RhiWgpuTexture;
    /**
     * bug-20260610: spec-shaped `present()` so the runtime per-frame loop
     * can release the acquired surface image after queue.submit. Without
     * this the next frame's `getCurrentTexture()` panics inside
     * wgpu_core::Storage with "Surface image is already acquired".
     * WebGPU spec auto-presents on next browser frame, but wgpu's GLES /
     * native backend requires explicit present (mirrors the requestSurface
     * flow in winit / glutin programs).
     */
    present(): void;
}

export class RhiWgpuTexture {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    createView(desc_js: any): RhiWgpuTextureView;
    destroy(): void;
    readonly depthOrArrayLayers: number;
    readonly height: number;
    /**
     * bug-20260610: spec-aligned getters so the engine can read swap-chain
     * texture dimensions. Without these, `currentTexture.width` reads
     * `undefined`, the runtime computes `targetW = (undefined | 0) === 0`,
     * and `Device::create_texture` for the depth attachment trips
     * `Dimension X is zero`.
     */
    readonly width: number;
}

export class RhiWgpuTextureView {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly forgeaxResourceKind: string;
    readonly forgeaxToken: number;
}

/**
 * Handle for the `validate` output. Carries both Module and ModuleInfo; passed into
 * `emit_reflection`.
 */
export class ValidatedModule {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

/**
 * Compose a WGSL shader via naga_oil and serialise the composed naga module
 * back to WGSL text (plan-strategy D-01 Rust-side composer).
 */
export function compose_shader(entry_source: string, imports_json: string, defines_json: string): string;

/**
 * `ValidatedModule` + options JSON -> `BindGroupLayoutDescriptor[]` JSON string.
 *
 * `options_json` shape: `{ "dynamicOffsets": [{ "group": u32, "binding": u32 }, ...] }`.
 * The naga IR does not express the dynamic-offset dimension (see research Finding 2
 * footnote), so it is injected via JS-side options.
 */
export function emit_reflection(validated: ValidatedModule, options_json: string): string;

/**
 * WGSL source -> `naga::Module`. On failure throws a `JsError` whose payload carries
 * `message` / `line_num` / `line_pos`.
 */
export function parse(source: string): ParsedModule;

/**
 * Produce portable WGSL for each selected compute entry; never driver binaries.
 */
export function specialize_compute_entries(source: string, entries_json: string): string;

export function start(): void;

/**
 * `naga::Module` -> `ModuleInfo`. On failure throws a `JsError` whose message is the
 * validator's prose diagnostic (no source position is attached).
 */
export function validate(parsed: ParsedModule): ValidatedModule;

/**
 * Validate the selected graphics stages, rather than merely the whole module.
 */
export function validate_render_entries(validated: ValidatedModule, vertex: string, fragment?: string | null, color_formats?: string | null): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_parsedmodule_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpuadapter_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpubindgroup_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpubindgrouplayout_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpubuffer_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpucommandbuffer_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpucommandencoder_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpucompletionrequest_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpucomputepass_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpucomputepipeline_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpudevice_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpuinstance_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpupipelinelayout_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpuqueryset_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpuqueue_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpurenderbundle_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpurenderbundleencoder_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpurenderpass_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpurenderpipeline_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpusampler_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpushadermodule_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpusurface_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgpusurfacetexture_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgputexture_free: (a: number, b: number) => void;
    readonly __wbg_rhiwgputextureview_free: (a: number, b: number) => void;
    readonly __wbg_validatedmodule_free: (a: number, b: number) => void;
    readonly compose_shader: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly emit_reflection: (a: number, b: number, c: number) => [number, number, number, number];
    readonly parse: (a: number, b: number) => [number, number, number];
    readonly rhiwgpuadapter_features: (a: number) => any;
    readonly rhiwgpuadapter_requestDevice: (a: number, b: any) => any;
    readonly rhiwgpubindgrouplayout_forgeaxToken: (a: number) => number;
    readonly rhiwgpubuffer_destroy: (a: number) => [number, number];
    readonly rhiwgpubuffer_forgeaxToken: (a: number) => number;
    readonly rhiwgpubuffer_getMappedRange: (a: number, b: number, c: bigint, d: number, e: bigint) => [number, number, number];
    readonly rhiwgpubuffer_mapAsync: (a: number, b: number, c: number, d: bigint, e: number, f: bigint) => any;
    readonly rhiwgpubuffer_mapState: (a: number) => [number, number];
    readonly rhiwgpubuffer_unmap: (a: number) => [number, number];
    readonly rhiwgpucommandencoder_beginComputePass: (a: number, b: any) => [number, number, number];
    readonly rhiwgpucommandencoder_beginRenderPass: (a: number, b: any) => [number, number, number];
    readonly rhiwgpucommandencoder_clearBuffer: (a: number, b: number, c: number, d: bigint, e: number, f: bigint) => void;
    readonly rhiwgpucommandencoder_copyBufferToBuffer: (a: number, b: number, c: bigint, d: number, e: bigint, f: bigint) => void;
    readonly rhiwgpucommandencoder_copyBufferToTexture: (a: number, b: number, c: bigint, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => void;
    readonly rhiwgpucommandencoder_copyTextureToBuffer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint, j: number, k: number, l: number, m: number, n: number) => void;
    readonly rhiwgpucommandencoder_copyTextureToTexture: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => void;
    readonly rhiwgpucommandencoder_finish: (a: number) => number;
    readonly rhiwgpucommandencoder_insertDebugMarker: (a: number, b: number, c: number) => void;
    readonly rhiwgpucommandencoder_popDebugGroup: (a: number) => void;
    readonly rhiwgpucommandencoder_pushDebugGroup: (a: number, b: number, c: number) => void;
    readonly rhiwgpucommandencoder_resolveQuerySet: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly rhiwgpucompletionrequest_poll: (a: number) => [number, number, number];
    readonly rhiwgpucomputepass_dispatchWorkgroups: (a: number, b: number, c: number, d: number) => void;
    readonly rhiwgpucomputepass_dispatchWorkgroupsIndirect: (a: number, b: number, c: bigint) => void;
    readonly rhiwgpucomputepass_end: (a: number) => void;
    readonly rhiwgpucomputepass_setBindGroup: (a: number, b: number, c: number, d: any) => void;
    readonly rhiwgpucomputepass_setPipeline: (a: number, b: number) => void;
    readonly rhiwgpudevice_createBindGroup: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createBindGroupLayout: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createBuffer: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createCommandEncoder: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createComputePipeline: (a: number, b: any, c: number, d: number) => [number, number, number];
    readonly rhiwgpudevice_createPipelineLayout: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createQuerySet: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createRenderBundleEncoder: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createRenderPipeline: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createSampler: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createShaderModule: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createTexture: (a: number, b: any) => [number, number, number];
    readonly rhiwgpudevice_createTextureView: (a: number, b: number, c: any) => [number, number, number];
    readonly rhiwgpudevice_features: (a: number) => any;
    readonly rhiwgpudevice_forgeaxToken: (a: number) => number;
    readonly rhiwgpudevice_limits: (a: number) => any;
    readonly rhiwgpudevice_queue: (a: number) => number;
    readonly rhiwgpudevice_registerLostCallback: (a: number, b: any) => void;
    readonly rhiwgpudevice_surfaceViewFormats: (a: number) => number;
    readonly rhiwgpuinstance_create: () => any;
    readonly rhiwgpuinstance_createSurface: (a: number, b: any) => [number, number, number];
    readonly rhiwgpuinstance_requestAdapter: (a: number) => any;
    readonly rhiwgpuinstance_requestAdapterWithCanvas: (a: number, b: any) => any;
    readonly rhiwgpupipelinelayout_forgeaxToken: (a: number) => number;
    readonly rhiwgpuqueue_copyExternalImageToTexture: (a: number, b: any, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number];
    readonly rhiwgpuqueue_onSubmittedWorkDone: (a: number, b: any) => [number, number, number];
    readonly rhiwgpuqueue_submit: (a: number, b: any) => [number, number];
    readonly rhiwgpuqueue_writeBuffer: (a: number, b: number, c: bigint, d: number, e: number, f: number, g: bigint, h: number, i: bigint) => void;
    readonly rhiwgpuqueue_writeTexture: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: bigint, k: number, l: number, m: number, n: number, o: number) => void;
    readonly rhiwgpurenderbundle_forgeaxToken: (a: number) => number;
    readonly rhiwgpurenderbundleencoder_draw: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly rhiwgpurenderbundleencoder_drawIndexed: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly rhiwgpurenderbundleencoder_drawIndexedIndirect: (a: number, b: number, c: bigint) => [number, number];
    readonly rhiwgpurenderbundleencoder_drawIndirect: (a: number, b: number, c: bigint) => [number, number];
    readonly rhiwgpurenderbundleencoder_finish: (a: number, b: any) => [number, number, number];
    readonly rhiwgpurenderbundleencoder_insertDebugMarker: (a: number, b: number, c: number) => [number, number];
    readonly rhiwgpurenderbundleencoder_popDebugGroup: (a: number) => [number, number];
    readonly rhiwgpurenderbundleencoder_pushDebugGroup: (a: number, b: number, c: number) => [number, number];
    readonly rhiwgpurenderbundleencoder_setBindGroup: (a: number, b: number, c: number, d: any, e: number, f: number) => [number, number];
    readonly rhiwgpurenderbundleencoder_setIndexBuffer: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: bigint) => [number, number];
    readonly rhiwgpurenderbundleencoder_setPipeline: (a: number, b: number) => [number, number];
    readonly rhiwgpurenderbundleencoder_setVertexBuffer: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: bigint) => [number, number];
    readonly rhiwgpurenderpass_beginOcclusionQuery: (a: number, b: number) => void;
    readonly rhiwgpurenderpass_draw: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly rhiwgpurenderpass_drawIndexed: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly rhiwgpurenderpass_drawIndexedIndirect: (a: number, b: number, c: bigint) => void;
    readonly rhiwgpurenderpass_drawIndirect: (a: number, b: number, c: bigint) => void;
    readonly rhiwgpurenderpass_end: (a: number) => void;
    readonly rhiwgpurenderpass_endOcclusionQuery: (a: number) => void;
    readonly rhiwgpurenderpass_executeBundles: (a: number, b: any) => [number, number];
    readonly rhiwgpurenderpass_insertDebugMarker: (a: number, b: number, c: number) => void;
    readonly rhiwgpurenderpass_popDebugGroup: (a: number) => void;
    readonly rhiwgpurenderpass_pushDebugGroup: (a: number, b: number, c: number) => void;
    readonly rhiwgpurenderpass_setBindGroup: (a: number, b: number, c: number, d: any, e: number, f: number) => void;
    readonly rhiwgpurenderpass_setBlendConstant: (a: number, b: any) => void;
    readonly rhiwgpurenderpass_setIndexBuffer: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: bigint) => void;
    readonly rhiwgpurenderpass_setPipeline: (a: number, b: number) => void;
    readonly rhiwgpurenderpass_setScissorRect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly rhiwgpurenderpass_setStencilReference: (a: number, b: number) => void;
    readonly rhiwgpurenderpass_setVertexBuffer: (a: number, b: number, c: number, d: bigint, e: number, f: bigint) => void;
    readonly rhiwgpurenderpass_setViewport: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly rhiwgpusampler_forgeaxResourceKind: (a: number) => [number, number];
    readonly rhiwgpusampler_forgeaxToken: (a: number) => number;
    readonly rhiwgpushadermodule_forgeaxToken: (a: number) => number;
    readonly rhiwgpusurface_configure: (a: number, b: any) => [number, number];
    readonly rhiwgpusurface_getCurrentTexture: (a: number) => [number, number, number];
    readonly rhiwgpusurface_probeSurfacePresentation: (a: number) => [number, number, number];
    readonly rhiwgpusurfacetexture_getTexture: (a: number) => number;
    readonly rhiwgpusurfacetexture_present: (a: number) => [number, number];
    readonly rhiwgputexture_createView: (a: number, b: any) => [number, number, number];
    readonly rhiwgputexture_depthOrArrayLayers: (a: number) => number;
    readonly rhiwgputexture_destroy: (a: number) => void;
    readonly rhiwgputexture_height: (a: number) => number;
    readonly rhiwgputexture_width: (a: number) => number;
    readonly rhiwgputextureview_forgeaxResourceKind: (a: number) => [number, number];
    readonly rhiwgputextureview_forgeaxToken: (a: number) => number;
    readonly specialize_compute_entries: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly start: () => void;
    readonly validate: (a: number) => [number, number, number];
    readonly validate_render_entries: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h2e98ac29f1fbd5db: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1312d179d1d9248b: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h9a8e4b1067196a8b: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__hf4075af474fd64d6: (a: number, b: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
