/* tslint:disable */
/* eslint-disable */

/**
 * Standalone zero-GC bulk numerical hot-path accelerator for direct integration into `@forgeax/engine-render`.
 */
export class WasmHotPathAccel {
    free(): void;
    [Symbol.dispose](): void;
    camera_vp_ptr(): number;
    ensure_capacity(count: number): void;
    ensure_frustum_cameras(camera_count: number): void;
    flags_ptr(): number;
    frustum_planes_ptr(): number;
    layer_masks_ptr(): number;
    local_aabbs_ptr(): number;
    constructor(initial_capacity: number);
    out_sort_order_ptr(): number;
    out_vis_bits_ptr(): number;
    out_visible_ptr(): number;
    out_world_aabbs_ptr(): number;
    run_cull_world_aabbs(count: number, camera_count: number): number;
    run_sort_transparent(count: number, eye_x: number, eye_y: number, eye_z: number): void;
    run_transform_and_cull(count: number, camera_layer_mask: number, shadow_caster_only: boolean, write_world_aabbs: boolean): number;
    sort_layers_ptr(): number;
    sort_positions_ptr(): number;
    sort_ties_ptr(): number;
    world_aabbs_ptr(): number;
    world_matrices_ptr(): number;
}

export class WasmRenderKernel {
    free(): void;
    [Symbol.dispose](): void;
    begin_frame(frame_id: number, surface_width: number, surface_height: number): void;
    cmd_buffer_capacity(): number;
    commit_scene_delta_len(byte_len: number): number;
    cull(cam_x: number, cam_y: number, cam_z: number, layer_mask: number, flags: number, lod_bias: number): number;
    cull_lights_ptr(): number;
    cull_summary_ptr(): number;
    cull_vp_ptr(): number;
    delta_buffer_capacity(): number;
    destroy_buffer(id: number): void;
    destroy_dynamic_texture(id: number): void;
    destroy_material(id: number): void;
    destroy_mesh(id: number): void;
    destroy_sampler(id: number): void;
    destroy_shader(id: number): void;
    destroy_texture(id: number): void;
    ensure_cmd_buffer(min_words: number): number;
    /**
     * Ensures delta staging buffer has at least `min_bytes` and returns its linear memory pointer.
     */
    ensure_delta_buffer(min_bytes: number): number;
    instance_rows_len(): number;
    instance_rows_ptr(): number;
    constructor();
    object_count(): number;
    /**
     * Packs live scene lights into 64-byte GPU records matching `kernel-wgpu/src/scene_gpu.rs`.
     */
    pack_scene_lights_gpu(): number;
    /**
     * Packs live scene objects into 96-byte GPU rows matching `kernel-wgpu/src/scene_gpu.rs`.
     */
    pack_scene_objects_gpu(): number;
    receipt_ptr(): number;
    register_buffer(byte_size: number): number;
    register_dynamic_texture(width: number, height: number, format: number): number;
    register_material(shader_program_id: number, layout_family_id: number, render_state_bits: number, variant_flags: number, queue: number, param_bytes_len: number): number;
    register_mesh(vertex_layout_id: number, index_count: number, vertex_count: number, is_uint32_index: boolean, topology: number): number;
    register_sampler(hash: number): number;
    register_shader(layout_family_id: number): number;
    register_texture(width: number, height: number, format: number): number;
    resolved_cmds_len(): number;
    resolved_cmds_ptr(): number;
    scene_lights_gpu_ptr(): number;
    scene_objects_gpu_ptr(): number;
    /**
     * Sets submesh ranges for a registered mesh (packed 5 u32 words per submesh:
     * `[first_index, index_count, base_vertex_bits, first_vertex, vertex_count]`).
     */
    set_mesh_submeshes(id: number, packed: Uint32Array): void;
    submit_frame_words(word_len: number): number;
    submitted_bitmap_len(): number;
    submitted_bitmap_ptr(): number;
    update_dynamic_texture(id: number, revision: number, width: number, height: number): boolean;
}

/**
 * Exposes WASM linear memory so JS can construct zero-copy TypedArray views.
 */
export function wasm_memory(): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmhotpathaccel_free: (a: number, b: number) => void;
    readonly __wbg_wasmrenderkernel_free: (a: number, b: number) => void;
    readonly wasm_memory: () => any;
    readonly wasmhotpathaccel_camera_vp_ptr: (a: number) => number;
    readonly wasmhotpathaccel_ensure_capacity: (a: number, b: number) => void;
    readonly wasmhotpathaccel_ensure_frustum_cameras: (a: number, b: number) => void;
    readonly wasmhotpathaccel_flags_ptr: (a: number) => number;
    readonly wasmhotpathaccel_frustum_planes_ptr: (a: number) => number;
    readonly wasmhotpathaccel_layer_masks_ptr: (a: number) => number;
    readonly wasmhotpathaccel_local_aabbs_ptr: (a: number) => number;
    readonly wasmhotpathaccel_new: (a: number) => number;
    readonly wasmhotpathaccel_out_sort_order_ptr: (a: number) => number;
    readonly wasmhotpathaccel_out_vis_bits_ptr: (a: number) => number;
    readonly wasmhotpathaccel_out_visible_ptr: (a: number) => number;
    readonly wasmhotpathaccel_out_world_aabbs_ptr: (a: number) => number;
    readonly wasmhotpathaccel_run_cull_world_aabbs: (a: number, b: number, c: number) => number;
    readonly wasmhotpathaccel_run_sort_transparent: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmhotpathaccel_run_transform_and_cull: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasmhotpathaccel_sort_layers_ptr: (a: number) => number;
    readonly wasmhotpathaccel_sort_positions_ptr: (a: number) => number;
    readonly wasmhotpathaccel_sort_ties_ptr: (a: number) => number;
    readonly wasmhotpathaccel_world_aabbs_ptr: (a: number) => number;
    readonly wasmhotpathaccel_world_matrices_ptr: (a: number) => number;
    readonly wasmrenderkernel_begin_frame: (a: number, b: number, c: number, d: number) => [number, number];
    readonly wasmrenderkernel_cmd_buffer_capacity: (a: number) => number;
    readonly wasmrenderkernel_commit_scene_delta_len: (a: number, b: number) => [number, number, number];
    readonly wasmrenderkernel_cull: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly wasmrenderkernel_cull_lights_ptr: (a: number) => number;
    readonly wasmrenderkernel_cull_summary_ptr: (a: number) => number;
    readonly wasmrenderkernel_cull_vp_ptr: (a: number) => number;
    readonly wasmrenderkernel_delta_buffer_capacity: (a: number) => number;
    readonly wasmrenderkernel_destroy_buffer: (a: number, b: number) => [number, number];
    readonly wasmrenderkernel_destroy_dynamic_texture: (a: number, b: number) => [number, number];
    readonly wasmrenderkernel_destroy_material: (a: number, b: number) => [number, number];
    readonly wasmrenderkernel_destroy_mesh: (a: number, b: number) => [number, number];
    readonly wasmrenderkernel_destroy_sampler: (a: number, b: number) => [number, number];
    readonly wasmrenderkernel_destroy_shader: (a: number, b: number) => [number, number];
    readonly wasmrenderkernel_destroy_texture: (a: number, b: number) => [number, number];
    readonly wasmrenderkernel_ensure_cmd_buffer: (a: number, b: number) => number;
    readonly wasmrenderkernel_ensure_delta_buffer: (a: number, b: number) => number;
    readonly wasmrenderkernel_instance_rows_len: (a: number) => number;
    readonly wasmrenderkernel_instance_rows_ptr: (a: number) => number;
    readonly wasmrenderkernel_new: () => number;
    readonly wasmrenderkernel_object_count: (a: number) => number;
    readonly wasmrenderkernel_pack_scene_lights_gpu: (a: number) => number;
    readonly wasmrenderkernel_pack_scene_objects_gpu: (a: number) => number;
    readonly wasmrenderkernel_receipt_ptr: (a: number) => number;
    readonly wasmrenderkernel_register_buffer: (a: number, b: number) => [number, number, number];
    readonly wasmrenderkernel_register_dynamic_texture: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly wasmrenderkernel_register_material: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly wasmrenderkernel_register_mesh: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly wasmrenderkernel_register_sampler: (a: number, b: number) => [number, number, number];
    readonly wasmrenderkernel_register_shader: (a: number, b: number) => [number, number, number];
    readonly wasmrenderkernel_register_texture: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly wasmrenderkernel_resolved_cmds_len: (a: number) => number;
    readonly wasmrenderkernel_resolved_cmds_ptr: (a: number) => number;
    readonly wasmrenderkernel_scene_lights_gpu_ptr: (a: number) => number;
    readonly wasmrenderkernel_scene_objects_gpu_ptr: (a: number) => number;
    readonly wasmrenderkernel_set_mesh_submeshes: (a: number, b: number, c: number, d: number) => [number, number];
    readonly wasmrenderkernel_submit_frame_words: (a: number, b: number) => [number, number, number];
    readonly wasmrenderkernel_submitted_bitmap_len: (a: number) => number;
    readonly wasmrenderkernel_submitted_bitmap_ptr: (a: number) => number;
    readonly wasmrenderkernel_update_dynamic_texture: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
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
