/* @ts-self-types="./forgeax_render_kernel_wasm.d.ts" */

/**
 * Standalone zero-GC bulk numerical hot-path accelerator for direct integration into `@forgeax/engine-render`.
 */
export class WasmHotPathAccel {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmHotPathAccelFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmhotpathaccel_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    camera_vp_ptr() {
        const ret = wasm.wasmhotpathaccel_camera_vp_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} count
     */
    ensure_capacity(count) {
        wasm.wasmhotpathaccel_ensure_capacity(this.__wbg_ptr, count);
    }
    /**
     * @param {number} camera_count
     */
    ensure_frustum_cameras(camera_count) {
        wasm.wasmhotpathaccel_ensure_frustum_cameras(this.__wbg_ptr, camera_count);
    }
    /**
     * @returns {number}
     */
    flags_ptr() {
        const ret = wasm.wasmhotpathaccel_flags_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    frustum_planes_ptr() {
        const ret = wasm.wasmhotpathaccel_frustum_planes_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    layer_masks_ptr() {
        const ret = wasm.wasmhotpathaccel_layer_masks_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    local_aabbs_ptr() {
        const ret = wasm.wasmhotpathaccel_local_aabbs_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} initial_capacity
     */
    constructor(initial_capacity) {
        const ret = wasm.wasmhotpathaccel_new(initial_capacity);
        this.__wbg_ptr = ret;
        WasmHotPathAccelFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    out_sort_order_ptr() {
        const ret = wasm.wasmhotpathaccel_out_sort_order_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    out_vis_bits_ptr() {
        const ret = wasm.wasmhotpathaccel_out_vis_bits_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    out_visible_ptr() {
        const ret = wasm.wasmhotpathaccel_out_visible_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    out_world_aabbs_ptr() {
        const ret = wasm.wasmhotpathaccel_out_world_aabbs_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} count
     * @param {number} camera_count
     * @returns {number}
     */
    run_cull_world_aabbs(count, camera_count) {
        const ret = wasm.wasmhotpathaccel_run_cull_world_aabbs(this.__wbg_ptr, count, camera_count);
        return ret >>> 0;
    }
    /**
     * @param {number} count
     * @param {number} eye_x
     * @param {number} eye_y
     * @param {number} eye_z
     */
    run_sort_transparent(count, eye_x, eye_y, eye_z) {
        wasm.wasmhotpathaccel_run_sort_transparent(this.__wbg_ptr, count, eye_x, eye_y, eye_z);
    }
    /**
     * @param {number} count
     * @param {number} camera_layer_mask
     * @param {boolean} shadow_caster_only
     * @param {boolean} write_world_aabbs
     * @returns {number}
     */
    run_transform_and_cull(count, camera_layer_mask, shadow_caster_only, write_world_aabbs) {
        const ret = wasm.wasmhotpathaccel_run_transform_and_cull(this.__wbg_ptr, count, camera_layer_mask, shadow_caster_only, write_world_aabbs);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    sort_layers_ptr() {
        const ret = wasm.wasmhotpathaccel_sort_layers_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    sort_positions_ptr() {
        const ret = wasm.wasmhotpathaccel_sort_positions_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    sort_ties_ptr() {
        const ret = wasm.wasmhotpathaccel_sort_ties_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    world_aabbs_ptr() {
        const ret = wasm.wasmhotpathaccel_world_aabbs_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    world_matrices_ptr() {
        const ret = wasm.wasmhotpathaccel_world_matrices_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) WasmHotPathAccel.prototype[Symbol.dispose] = WasmHotPathAccel.prototype.free;

export class WasmRenderKernel {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmRenderKernelFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmrenderkernel_free(ptr, 0);
    }
    /**
     * @param {number} frame_id
     * @param {number} surface_width
     * @param {number} surface_height
     */
    begin_frame(frame_id, surface_width, surface_height) {
        const ret = wasm.wasmrenderkernel_begin_frame(this.__wbg_ptr, frame_id, surface_width, surface_height);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {number}
     */
    cmd_buffer_capacity() {
        const ret = wasm.wasmrenderkernel_cmd_buffer_capacity(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} byte_len
     * @returns {number}
     */
    commit_scene_delta_len(byte_len) {
        const ret = wasm.wasmrenderkernel_commit_scene_delta_len(this.__wbg_ptr, byte_len);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} cam_x
     * @param {number} cam_y
     * @param {number} cam_z
     * @param {number} layer_mask
     * @param {number} flags
     * @param {number} lod_bias
     * @returns {number}
     */
    cull(cam_x, cam_y, cam_z, layer_mask, flags, lod_bias) {
        const ret = wasm.wasmrenderkernel_cull(this.__wbg_ptr, cam_x, cam_y, cam_z, layer_mask, flags, lod_bias);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @returns {number}
     */
    cull_lights_ptr() {
        const ret = wasm.wasmrenderkernel_cull_lights_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    cull_summary_ptr() {
        const ret = wasm.wasmrenderkernel_cull_summary_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    cull_vp_ptr() {
        const ret = wasm.wasmrenderkernel_cull_vp_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    delta_buffer_capacity() {
        const ret = wasm.wasmrenderkernel_delta_buffer_capacity(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} id
     */
    destroy_buffer(id) {
        const ret = wasm.wasmrenderkernel_destroy_buffer(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} id
     */
    destroy_dynamic_texture(id) {
        const ret = wasm.wasmrenderkernel_destroy_dynamic_texture(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} id
     */
    destroy_material(id) {
        const ret = wasm.wasmrenderkernel_destroy_material(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} id
     */
    destroy_mesh(id) {
        const ret = wasm.wasmrenderkernel_destroy_mesh(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} id
     */
    destroy_sampler(id) {
        const ret = wasm.wasmrenderkernel_destroy_sampler(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} id
     */
    destroy_shader(id) {
        const ret = wasm.wasmrenderkernel_destroy_shader(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} id
     */
    destroy_texture(id) {
        const ret = wasm.wasmrenderkernel_destroy_texture(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} min_words
     * @returns {number}
     */
    ensure_cmd_buffer(min_words) {
        const ret = wasm.wasmrenderkernel_ensure_cmd_buffer(this.__wbg_ptr, min_words);
        return ret >>> 0;
    }
    /**
     * Ensures delta staging buffer has at least `min_bytes` and returns its linear memory pointer.
     * @param {number} min_bytes
     * @returns {number}
     */
    ensure_delta_buffer(min_bytes) {
        const ret = wasm.wasmrenderkernel_ensure_delta_buffer(this.__wbg_ptr, min_bytes);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    instance_rows_len() {
        const ret = wasm.wasmrenderkernel_instance_rows_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    instance_rows_ptr() {
        const ret = wasm.wasmrenderkernel_instance_rows_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    constructor() {
        const ret = wasm.wasmrenderkernel_new();
        this.__wbg_ptr = ret;
        WasmRenderKernelFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    object_count() {
        const ret = wasm.wasmrenderkernel_object_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Packs live scene lights into 64-byte GPU records matching `kernel-wgpu/src/scene_gpu.rs`.
     * @returns {number}
     */
    pack_scene_lights_gpu() {
        const ret = wasm.wasmrenderkernel_pack_scene_lights_gpu(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Packs live scene objects into 96-byte GPU rows matching `kernel-wgpu/src/scene_gpu.rs`.
     * @returns {number}
     */
    pack_scene_objects_gpu() {
        const ret = wasm.wasmrenderkernel_pack_scene_objects_gpu(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    receipt_ptr() {
        const ret = wasm.wasmrenderkernel_receipt_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} byte_size
     * @returns {number}
     */
    register_buffer(byte_size) {
        const ret = wasm.wasmrenderkernel_register_buffer(this.__wbg_ptr, byte_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} width
     * @param {number} height
     * @param {number} format
     * @returns {number}
     */
    register_dynamic_texture(width, height, format) {
        const ret = wasm.wasmrenderkernel_register_dynamic_texture(this.__wbg_ptr, width, height, format);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} shader_program_id
     * @param {number} layout_family_id
     * @param {number} render_state_bits
     * @param {number} variant_flags
     * @param {number} queue
     * @param {number} param_bytes_len
     * @returns {number}
     */
    register_material(shader_program_id, layout_family_id, render_state_bits, variant_flags, queue, param_bytes_len) {
        const ret = wasm.wasmrenderkernel_register_material(this.__wbg_ptr, shader_program_id, layout_family_id, render_state_bits, variant_flags, queue, param_bytes_len);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} vertex_layout_id
     * @param {number} index_count
     * @param {number} vertex_count
     * @param {boolean} is_uint32_index
     * @param {number} topology
     * @returns {number}
     */
    register_mesh(vertex_layout_id, index_count, vertex_count, is_uint32_index, topology) {
        const ret = wasm.wasmrenderkernel_register_mesh(this.__wbg_ptr, vertex_layout_id, index_count, vertex_count, is_uint32_index, topology);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} hash
     * @returns {number}
     */
    register_sampler(hash) {
        const ret = wasm.wasmrenderkernel_register_sampler(this.__wbg_ptr, hash);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} layout_family_id
     * @returns {number}
     */
    register_shader(layout_family_id) {
        const ret = wasm.wasmrenderkernel_register_shader(this.__wbg_ptr, layout_family_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} width
     * @param {number} height
     * @param {number} format
     * @returns {number}
     */
    register_texture(width, height, format) {
        const ret = wasm.wasmrenderkernel_register_texture(this.__wbg_ptr, width, height, format);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @returns {number}
     */
    resolved_cmds_len() {
        const ret = wasm.wasmrenderkernel_resolved_cmds_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    resolved_cmds_ptr() {
        const ret = wasm.wasmrenderkernel_resolved_cmds_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    scene_lights_gpu_ptr() {
        const ret = wasm.wasmrenderkernel_scene_lights_gpu_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    scene_objects_gpu_ptr() {
        const ret = wasm.wasmrenderkernel_scene_objects_gpu_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Sets submesh ranges for a registered mesh (packed 5 u32 words per submesh:
     * `[first_index, index_count, base_vertex_bits, first_vertex, vertex_count]`).
     * @param {number} id
     * @param {Uint32Array} packed
     */
    set_mesh_submeshes(id, packed) {
        const ptr0 = passArray32ToWasm0(packed, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmrenderkernel_set_mesh_submeshes(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} word_len
     * @returns {number}
     */
    submit_frame_words(word_len) {
        const ret = wasm.wasmrenderkernel_submit_frame_words(this.__wbg_ptr, word_len);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @returns {number}
     */
    submitted_bitmap_len() {
        const ret = wasm.wasmrenderkernel_submitted_bitmap_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    submitted_bitmap_ptr() {
        const ret = wasm.wasmrenderkernel_submitted_bitmap_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} id
     * @param {number} revision
     * @param {number} width
     * @param {number} height
     * @returns {boolean}
     */
    update_dynamic_texture(id, revision, width, height) {
        const ret = wasm.wasmrenderkernel_update_dynamic_texture(this.__wbg_ptr, id, revision, width, height);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) WasmRenderKernel.prototype[Symbol.dispose] = WasmRenderKernel.prototype.free;

/**
 * Exposes WASM linear memory so JS can construct zero-copy TypedArray views.
 * @returns {any}
 */
export function wasm_memory() {
    const ret = wasm.wasm_memory();
    return ret;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_memory_caa4a6165639c8b5: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./forgeax_render_kernel_wasm_bg.js": import0,
    };
}

const WasmHotPathAccelFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmhotpathaccel_free(ptr, 1));
const WasmRenderKernelFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmrenderkernel_free(ptr, 1));

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        const defaultWasmRel = './forgeax_render_kernel_wasm_bg.wasm';
        module_or_path = new URL(defaultWasmRel, import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
