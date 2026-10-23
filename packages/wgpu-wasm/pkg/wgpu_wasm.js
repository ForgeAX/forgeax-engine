/* @ts-self-types="./wgpu_wasm.d.ts" */

/**
 * Handle for the `parse` output. JS holds an opaque struct it cannot inspect; the
 * only legal next move is to feed it into `validate` (plan-strategy §S-1 opaque handle).
 */
export class ParsedModule {
    static __wrap(ptr) {
        const obj = Object.create(ParsedModule.prototype);
        obj.__wbg_ptr = ptr;
        ParsedModuleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ParsedModuleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_parsedmodule_free(ptr, 0);
    }
}
if (Symbol.dispose) ParsedModule.prototype[Symbol.dispose] = ParsedModule.prototype.free;

export class RhiWgpuAdapter {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuAdapter.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuAdapterFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuAdapterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpuadapter_free(ptr, 0);
    }
    /**
     * @returns {Set<any>}
     */
    get features() {
        const ret = wasm.rhiwgpuadapter_features(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {any} options
     * @returns {Promise<RhiWgpuDevice>}
     */
    requestDevice(options) {
        const ret = wasm.rhiwgpuadapter_requestDevice(this.__wbg_ptr, options);
        return ret;
    }
}
if (Symbol.dispose) RhiWgpuAdapter.prototype[Symbol.dispose] = RhiWgpuAdapter.prototype.free;

export class RhiWgpuBindGroup {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuBindGroup.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuBindGroupFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuBindGroupFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpubindgroup_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuBindGroup.prototype[Symbol.dispose] = RhiWgpuBindGroup.prototype.free;

export class RhiWgpuBindGroupLayout {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuBindGroupLayout.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuBindGroupLayoutFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuBindGroupLayoutFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpubindgrouplayout_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpubindgrouplayout_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuBindGroupLayout.prototype[Symbol.dispose] = RhiWgpuBindGroupLayout.prototype.free;

export class RhiWgpuBuffer {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuBuffer.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuBufferFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuBufferFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpubuffer_free(ptr, 0);
    }
    destroy() {
        const ret = wasm.rhiwgpubuffer_destroy(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpubuffer_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * JS owns copies only for this mapping lease. Writable copies are
     * committed before native unmap; READ edits are deliberately discarded.
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     * @returns {ArrayBuffer}
     */
    getMappedRange(offset, size) {
        const ret = wasm.rhiwgpubuffer_getMappedRange(this.__wbg_ptr, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Start the native mapping before returning its Promise, so unmap can
     * cancel a pending request. Its identity cannot retire a newer mapping.
     * @param {number} mode
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     * @returns {Promise<any>}
     */
    mapAsync(mode, offset, size) {
        const ret = wasm.rhiwgpubuffer_mapAsync(this.__wbg_ptr, mode, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
        return ret;
    }
    /**
     * @returns {string}
     */
    get mapState() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rhiwgpubuffer_mapState(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    unmap() {
        const ret = wasm.rhiwgpubuffer_unmap(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) RhiWgpuBuffer.prototype[Symbol.dispose] = RhiWgpuBuffer.prototype.free;

export class RhiWgpuCommandBuffer {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuCommandBuffer.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuCommandBufferFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    static __unwrap(jsValue) {
        if (!(jsValue instanceof RhiWgpuCommandBuffer)) {
            return 0;
        }
        return jsValue.__destroy_into_raw();
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuCommandBufferFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpucommandbuffer_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuCommandBuffer.prototype[Symbol.dispose] = RhiWgpuCommandBuffer.prototype.free;

export class RhiWgpuCommandEncoder {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuCommandEncoder.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuCommandEncoderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuCommandEncoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpucommandencoder_free(ptr, 0);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuComputePass}
     */
    beginComputePass(desc_js) {
        const ret = wasm.rhiwgpucommandencoder_beginComputePass(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuComputePass.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuRenderPass}
     */
    beginRenderPass(desc_js) {
        const ret = wasm.rhiwgpucommandencoder_beginRenderPass(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuRenderPass.__wrap(ret[0]);
    }
    /**
     * bug-20260610 Gap 12: clearBuffer.
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     */
    clearBuffer(buffer, offset, size) {
        _assertClass(buffer, RhiWgpuBuffer);
        wasm.rhiwgpucommandencoder_clearBuffer(this.__wbg_ptr, buffer.__wbg_ptr, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
    }
    /**
     * bug-20260610 Gap 12: copyBufferToBuffer per WebGPU spec
     * `(source, sourceOffset, destination, destinationOffset, size)`.
     * @param {RhiWgpuBuffer} source
     * @param {bigint} source_offset
     * @param {RhiWgpuBuffer} destination
     * @param {bigint} destination_offset
     * @param {bigint} size
     */
    copyBufferToBuffer(source, source_offset, destination, destination_offset, size) {
        _assertClass(source, RhiWgpuBuffer);
        _assertClass(destination, RhiWgpuBuffer);
        wasm.rhiwgpucommandencoder_copyBufferToBuffer(this.__wbg_ptr, source.__wbg_ptr, source_offset, destination.__wbg_ptr, destination_offset, size);
    }
    /**
     * bug-20260610 Gap 12: copyBufferToTexture flat-args form (handles via
     * borrowed `&T` so wasm pointers survive across the call — see writeTexture
     * note about `try_from_js_value` consuming pointers).
     * @param {RhiWgpuBuffer} source_buffer
     * @param {bigint} source_offset
     * @param {number | null | undefined} source_bytes_per_row
     * @param {number | null | undefined} source_rows_per_image
     * @param {RhiWgpuTexture} dest_texture
     * @param {number} dest_mip_level
     * @param {number} dest_origin_x
     * @param {number} dest_origin_y
     * @param {number} dest_origin_z
     * @param {number} dest_aspect
     * @param {number} size_width
     * @param {number} size_height
     * @param {number} size_depth
     */
    copyBufferToTexture(source_buffer, source_offset, source_bytes_per_row, source_rows_per_image, dest_texture, dest_mip_level, dest_origin_x, dest_origin_y, dest_origin_z, dest_aspect, size_width, size_height, size_depth) {
        _assertClass(source_buffer, RhiWgpuBuffer);
        _assertClass(dest_texture, RhiWgpuTexture);
        wasm.rhiwgpucommandencoder_copyBufferToTexture(this.__wbg_ptr, source_buffer.__wbg_ptr, source_offset, isLikeNone(source_bytes_per_row) ? Number.MAX_SAFE_INTEGER : (source_bytes_per_row) >>> 0, isLikeNone(source_rows_per_image) ? Number.MAX_SAFE_INTEGER : (source_rows_per_image) >>> 0, dest_texture.__wbg_ptr, dest_mip_level, dest_origin_x, dest_origin_y, dest_origin_z, dest_aspect, size_width, size_height, size_depth);
    }
    /**
     * bug-20260610 Gap 12: copyTextureToBuffer flat-args form.
     * @param {RhiWgpuTexture} source_texture
     * @param {number} source_mip_level
     * @param {number} source_origin_x
     * @param {number} source_origin_y
     * @param {number} source_origin_z
     * @param {number} source_aspect
     * @param {RhiWgpuBuffer} dest_buffer
     * @param {bigint} dest_offset
     * @param {number | null | undefined} dest_bytes_per_row
     * @param {number | null | undefined} dest_rows_per_image
     * @param {number} size_width
     * @param {number} size_height
     * @param {number} size_depth
     */
    copyTextureToBuffer(source_texture, source_mip_level, source_origin_x, source_origin_y, source_origin_z, source_aspect, dest_buffer, dest_offset, dest_bytes_per_row, dest_rows_per_image, size_width, size_height, size_depth) {
        _assertClass(source_texture, RhiWgpuTexture);
        _assertClass(dest_buffer, RhiWgpuBuffer);
        wasm.rhiwgpucommandencoder_copyTextureToBuffer(this.__wbg_ptr, source_texture.__wbg_ptr, source_mip_level, source_origin_x, source_origin_y, source_origin_z, source_aspect, dest_buffer.__wbg_ptr, dest_offset, isLikeNone(dest_bytes_per_row) ? Number.MAX_SAFE_INTEGER : (dest_bytes_per_row) >>> 0, isLikeNone(dest_rows_per_image) ? Number.MAX_SAFE_INTEGER : (dest_rows_per_image) >>> 0, size_width, size_height, size_depth);
    }
    /**
     * bug-20260610 Gap 12: copyTextureToTexture flat-args form.
     * @param {RhiWgpuTexture} source_texture
     * @param {number} source_mip_level
     * @param {number} source_origin_x
     * @param {number} source_origin_y
     * @param {number} source_origin_z
     * @param {number} source_aspect
     * @param {RhiWgpuTexture} dest_texture
     * @param {number} dest_mip_level
     * @param {number} dest_origin_x
     * @param {number} dest_origin_y
     * @param {number} dest_origin_z
     * @param {number} dest_aspect
     * @param {number} size_width
     * @param {number} size_height
     * @param {number} size_depth
     */
    copyTextureToTexture(source_texture, source_mip_level, source_origin_x, source_origin_y, source_origin_z, source_aspect, dest_texture, dest_mip_level, dest_origin_x, dest_origin_y, dest_origin_z, dest_aspect, size_width, size_height, size_depth) {
        _assertClass(source_texture, RhiWgpuTexture);
        _assertClass(dest_texture, RhiWgpuTexture);
        wasm.rhiwgpucommandencoder_copyTextureToTexture(this.__wbg_ptr, source_texture.__wbg_ptr, source_mip_level, source_origin_x, source_origin_y, source_origin_z, source_aspect, dest_texture.__wbg_ptr, dest_mip_level, dest_origin_x, dest_origin_y, dest_origin_z, dest_aspect, size_width, size_height, size_depth);
    }
    /**
     * @returns {RhiWgpuCommandBuffer}
     */
    finish() {
        const ret = wasm.rhiwgpucommandencoder_finish(this.__wbg_ptr);
        return RhiWgpuCommandBuffer.__wrap(ret);
    }
    /**
     * @param {string} label
     */
    insertDebugMarker(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpucommandencoder_insertDebugMarker(this.__wbg_ptr, ptr0, len0);
    }
    popDebugGroup() {
        wasm.rhiwgpucommandencoder_popDebugGroup(this.__wbg_ptr);
    }
    /**
     * @param {string} label
     */
    pushDebugGroup(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpucommandencoder_pushDebugGroup(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {RhiWgpuQuerySet} query_set
     * @param {number} first_query
     * @param {number} query_count
     * @param {RhiWgpuBuffer} destination
     * @param {number} destination_offset
     */
    resolveQuerySet(query_set, first_query, query_count, destination, destination_offset) {
        _assertClass(query_set, RhiWgpuQuerySet);
        _assertClass(destination, RhiWgpuBuffer);
        wasm.rhiwgpucommandencoder_resolveQuerySet(this.__wbg_ptr, query_set.__wbg_ptr, first_query, query_count, destination.__wbg_ptr, destination_offset);
    }
}
if (Symbol.dispose) RhiWgpuCommandEncoder.prototype[Symbol.dispose] = RhiWgpuCommandEncoder.prototype.free;

/**
 * Short-lived completion observation, explicitly released by the JS driver.
 */
export class RhiWgpuCompletionRequest {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuCompletionRequest.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuCompletionRequestFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuCompletionRequestFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpucompletionrequest_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    poll() {
        const ret = wasm.rhiwgpucompletionrequest_poll(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) RhiWgpuCompletionRequest.prototype[Symbol.dispose] = RhiWgpuCompletionRequest.prototype.free;

export class RhiWgpuComputePass {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuComputePass.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuComputePassFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuComputePassFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpucomputepass_free(ptr, 0);
    }
    /**
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint} offset
     */
    dispatchWorkgroupsIndirect(buffer, offset) {
        _assertClass(buffer, RhiWgpuBuffer);
        wasm.rhiwgpucomputepass_dispatchWorkgroupsIndirect(this.__wbg_ptr, buffer.__wbg_ptr, offset);
    }
    /**
     * @param {number} x
     * @param {number | null} [y]
     * @param {number | null} [z]
     */
    dispatchWorkgroups(x, y, z) {
        wasm.rhiwgpucomputepass_dispatchWorkgroups(this.__wbg_ptr, x, isLikeNone(y) ? Number.MAX_SAFE_INTEGER : (y) >>> 0, isLikeNone(z) ? Number.MAX_SAFE_INTEGER : (z) >>> 0);
    }
    end() {
        wasm.rhiwgpucomputepass_end(this.__wbg_ptr);
    }
    /**
     * @param {number} index
     * @param {RhiWgpuBindGroup} bind_group
     * @param {any} dynamic_offsets
     */
    setBindGroup(index, bind_group, dynamic_offsets) {
        _assertClass(bind_group, RhiWgpuBindGroup);
        wasm.rhiwgpucomputepass_setBindGroup(this.__wbg_ptr, index, bind_group.__wbg_ptr, dynamic_offsets);
    }
    /**
     * @param {RhiWgpuComputePipeline} pipeline
     */
    setPipeline(pipeline) {
        _assertClass(pipeline, RhiWgpuComputePipeline);
        wasm.rhiwgpucomputepass_setPipeline(this.__wbg_ptr, pipeline.__wbg_ptr);
    }
}
if (Symbol.dispose) RhiWgpuComputePass.prototype[Symbol.dispose] = RhiWgpuComputePass.prototype.free;

export class RhiWgpuComputePipeline {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuComputePipeline.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuComputePipelineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuComputePipelineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpucomputepipeline_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuComputePipeline.prototype[Symbol.dispose] = RhiWgpuComputePipeline.prototype.free;

export class RhiWgpuDevice {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuDevice.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuDeviceFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuDeviceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpudevice_free(ptr, 0);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuBindGroupLayout}
     */
    createBindGroupLayout(desc_js) {
        const ret = wasm.rhiwgpudevice_createBindGroupLayout(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuBindGroupLayout.__wrap(ret[0]);
    }
    /**
     * Descriptor resources are borrowed through their live tokens. Temporary
     * native clones live only through create_bind_group; wgpu retains its own.
     * @param {any} desc_js
     * @returns {RhiWgpuBindGroup}
     */
    createBindGroup(desc_js) {
        const ret = wasm.rhiwgpudevice_createBindGroup(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuBindGroup.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuBuffer}
     */
    createBuffer(desc_js) {
        const ret = wasm.rhiwgpudevice_createBuffer(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuBuffer.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuCommandEncoder}
     */
    createCommandEncoder(desc_js) {
        const ret = wasm.rhiwgpudevice_createCommandEncoder(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuCommandEncoder.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @param {RhiWgpuShaderModule} module
     * @param {RhiWgpuPipelineLayout | null} [layout]
     * @returns {RhiWgpuComputePipeline}
     */
    createComputePipeline(desc_js, module, layout) {
        _assertClass(module, RhiWgpuShaderModule);
        let ptr0 = 0;
        if (!isLikeNone(layout)) {
            _assertClass(layout, RhiWgpuPipelineLayout);
            ptr0 = layout.__destroy_into_raw();
        }
        const ret = wasm.rhiwgpudevice_createComputePipeline(this.__wbg_ptr, desc_js, module.__wbg_ptr, ptr0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuComputePipeline.__wrap(ret[0]);
    }
    /**
     * bug-20260610: take ONE descriptor whose `bindGroupLayouts` is an Array
     * of `RhiWgpuBindGroupLayout` handles, mirroring the WebGPU spec
     * (`GPUPipelineLayoutDescriptor.bindGroupLayouts`). The legacy 2-arg form
     * (descriptor + array) was wired through the TS shim's generic `wrap()`
     * helper which calls with **one** arg, so the BGL array always arrived
     * `undefined` and wgpu built a 0-slot layout that later failed validation
     * when bound to a 4-slot pipeline.
     * @param {any} desc_js
     * @returns {RhiWgpuPipelineLayout}
     */
    createPipelineLayout(desc_js) {
        const ret = wasm.rhiwgpudevice_createPipelineLayout(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuPipelineLayout.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuQuerySet}
     */
    createQuerySet(desc_js) {
        const ret = wasm.rhiwgpudevice_createQuerySet(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuQuerySet.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuRenderBundleEncoder}
     */
    createRenderBundleEncoder(desc_js) {
        const ret = wasm.rhiwgpudevice_createRenderBundleEncoder(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuRenderBundleEncoder.__wrap(ret[0]);
    }
    /**
     * bug-20260610 Gap 14: refactored to spec-aligned single-descriptor form.
     * The earlier `(desc, vertex_module, fragment_module, layout)` form
     * required the TS shim to extract handles + pass them as separate args
     * — but the shim's generic `wrap()` helper only sends 1 arg, so the
     * other three arrived as `undefined` and `_assertClass` blew up before
     * the body ran. Reflect the handles off the descriptor so the call
     * shape matches the WebGPU spec
     * (`device.createRenderPipeline({layout, vertex:{module,...}, fragment:{module,...}, ...})`).
     * @param {any} desc_js
     * @returns {RhiWgpuRenderPipeline}
     */
    createRenderPipeline(desc_js) {
        const ret = wasm.rhiwgpudevice_createRenderPipeline(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuRenderPipeline.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuSampler}
     */
    createSampler(desc_js) {
        const ret = wasm.rhiwgpudevice_createSampler(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuSampler.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuShaderModule}
     */
    createShaderModule(desc_js) {
        const ret = wasm.rhiwgpudevice_createShaderModule(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuShaderModule.__wrap(ret[0]);
    }
    /**
     * bug-20260610 Gap 10: device-side texture-view creation. The TS shim
     * (`packages/rhi-wgpu/src/device.ts`) prefers
     * `device.createTextureView(tex, desc)` over `tex.createView(desc)`
     * because some wasm bindings expose `createView` only at the device
     * level. Mirror the spec descriptor surface (label / format / dimension /
     * aspect / mip / array slice).
     * @param {RhiWgpuTexture} texture
     * @param {any} desc_js
     * @returns {RhiWgpuTextureView}
     */
    createTextureView(texture, desc_js) {
        _assertClass(texture, RhiWgpuTexture);
        const ret = wasm.rhiwgpudevice_createTextureView(this.__wbg_ptr, texture.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuTextureView.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuTexture}
     */
    createTexture(desc_js) {
        const ret = wasm.rhiwgpudevice_createTexture(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuTexture.__wrap(ret[0]);
    }
    /**
     * @returns {Set<any>}
     */
    get features() {
        const ret = wasm.rhiwgpudevice_features(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpudevice_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
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
     * @returns {object}
     */
    get limits() {
        const ret = wasm.rhiwgpudevice_limits(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {RhiWgpuQueue}
     */
    get queue() {
        const ret = wasm.rhiwgpudevice_queue(this.__wbg_ptr);
        return RhiWgpuQueue.__wrap(ret);
    }
    /**
     * @param {Function} js_callback
     */
    registerLostCallback(js_callback) {
        wasm.rhiwgpudevice_registerLostCallback(this.__wbg_ptr, js_callback);
    }
    /**
     * Expose the concrete downlevel surface-view capability to the thin
     * TypeScript adapter. This is an internal capability fact, not a public
     * RhiCaps field; render routing consumes it as the dual-view/raw-only
     * surface profile input.
     * @returns {boolean}
     */
    get surfaceViewFormats() {
        const ret = wasm.rhiwgpudevice_surfaceViewFormats(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) RhiWgpuDevice.prototype[Symbol.dispose] = RhiWgpuDevice.prototype.free;

export class RhiWgpuInstance {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuInstance.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuInstanceFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuInstanceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpuinstance_free(ptr, 0);
    }
    /**
     * @param {HTMLCanvasElement} canvas
     * @returns {RhiWgpuSurface}
     */
    createSurface(canvas) {
        const ret = wasm.rhiwgpuinstance_createSurface(this.__wbg_ptr, canvas);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuSurface.__wrap(ret[0]);
    }
    /**
     * @returns {Promise<RhiWgpuInstance>}
     */
    static create() {
        const ret = wasm.rhiwgpuinstance_create();
        return ret;
    }
    /**
     * @param {HTMLCanvasElement} canvas
     * @returns {Promise<any>}
     */
    requestAdapterWithCanvas(canvas) {
        const ret = wasm.rhiwgpuinstance_requestAdapterWithCanvas(this.__wbg_ptr, canvas);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    requestAdapter() {
        const ret = wasm.rhiwgpuinstance_requestAdapter(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) RhiWgpuInstance.prototype[Symbol.dispose] = RhiWgpuInstance.prototype.free;

export class RhiWgpuPipelineLayout {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuPipelineLayout.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuPipelineLayoutFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuPipelineLayoutFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpupipelinelayout_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpupipelinelayout_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuPipelineLayout.prototype[Symbol.dispose] = RhiWgpuPipelineLayout.prototype.free;

export class RhiWgpuQuerySet {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuQuerySet.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuQuerySetFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuQuerySetFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpuqueryset_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuQuerySet.prototype[Symbol.dispose] = RhiWgpuQuerySet.prototype.free;

export class RhiWgpuQueue {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuQueue.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuQueueFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuQueueFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpuqueue_free(ptr, 0);
    }
    /**
     * `queue.copyExternalImageToTexture(...)` flat-args form, mirroring
     * writeTexture: the texture is borrowed so its JS pointer survives.
     * WebGL2 has no `texture_external`, so video and canvas sources reach
     * sampled textures only through this copy.
     * @param {any} source
     * @param {number} source_origin_x
     * @param {number} source_origin_y
     * @param {boolean} flip_y
     * @param {RhiWgpuTexture} texture
     * @param {number} mip_level
     * @param {number} origin_x
     * @param {number} origin_y
     * @param {number} origin_z
     * @param {number} aspect
     * @param {boolean} display_p3
     * @param {boolean} premultiplied_alpha
     * @param {number} size_width
     * @param {number} size_height
     * @param {number} size_depth
     */
    copyExternalImageToTexture(source, source_origin_x, source_origin_y, flip_y, texture, mip_level, origin_x, origin_y, origin_z, aspect, display_p3, premultiplied_alpha, size_width, size_height, size_depth) {
        _assertClass(texture, RhiWgpuTexture);
        const ret = wasm.rhiwgpuqueue_copyExternalImageToTexture(this.__wbg_ptr, source, source_origin_x, source_origin_y, flip_y, texture.__wbg_ptr, mip_level, origin_x, origin_y, origin_z, aspect, display_p3, premultiplied_alpha, size_width, size_height, size_depth);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The private JS driver owns scheduling and catches native throws/traps.
     * Only the native callback is allowed to report completion.
     * @param {Function} driver
     * @returns {Promise<any>}
     */
    onSubmittedWorkDone(driver) {
        const ret = wasm.rhiwgpuqueue_onSubmittedWorkDone(this.__wbg_ptr, driver);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Array<any>} buffers
     */
    submit(buffers) {
        const ret = wasm.rhiwgpuqueue_submit(this.__wbg_ptr, buffers);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * bug-20260610: explicit `js_name = writeBuffer` because wasm-bindgen's
     * default snake_case export (`write_buffer`) does not match the WebGPU
     * spec / TS shim's `queue.writeBuffer(...)` call site.
     *
     * TS shim signature: `writeBuffer(buffer, bufferOffset, data, dataOffset?, size?)`.
     * dataOffset / size are optional in the spec — we honour them by slicing
     * the input bytes before forwarding to wgpu.
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint} buffer_offset
     * @param {Uint8Array} data
     * @param {bigint | null} [data_offset]
     * @param {bigint | null} [size]
     */
    writeBuffer(buffer, buffer_offset, data, data_offset, size) {
        _assertClass(buffer, RhiWgpuBuffer);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpuqueue_writeBuffer(this.__wbg_ptr, buffer.__wbg_ptr, buffer_offset, ptr0, len0, !isLikeNone(data_offset), isLikeNone(data_offset) ? BigInt(0) : data_offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
    }
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
     * @param {RhiWgpuTexture} texture
     * @param {number} mip_level
     * @param {number} origin_x
     * @param {number} origin_y
     * @param {number} origin_z
     * @param {number} aspect
     * @param {Uint8Array} data
     * @param {bigint} layout_offset
     * @param {number | null | undefined} bytes_per_row
     * @param {number | null | undefined} rows_per_image
     * @param {number} size_width
     * @param {number} size_height
     * @param {number} size_depth
     */
    writeTexture(texture, mip_level, origin_x, origin_y, origin_z, aspect, data, layout_offset, bytes_per_row, rows_per_image, size_width, size_height, size_depth) {
        _assertClass(texture, RhiWgpuTexture);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpuqueue_writeTexture(this.__wbg_ptr, texture.__wbg_ptr, mip_level, origin_x, origin_y, origin_z, aspect, ptr0, len0, layout_offset, isLikeNone(bytes_per_row) ? Number.MAX_SAFE_INTEGER : (bytes_per_row) >>> 0, isLikeNone(rows_per_image) ? Number.MAX_SAFE_INTEGER : (rows_per_image) >>> 0, size_width, size_height, size_depth);
    }
}
if (Symbol.dispose) RhiWgpuQueue.prototype[Symbol.dispose] = RhiWgpuQueue.prototype.free;

export class RhiWgpuRenderBundle {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuRenderBundle.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuRenderBundleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuRenderBundleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpurenderbundle_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpurenderbundle_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuRenderBundle.prototype[Symbol.dispose] = RhiWgpuRenderBundle.prototype.free;

export class RhiWgpuRenderBundleEncoder {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuRenderBundleEncoder.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuRenderBundleEncoderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuRenderBundleEncoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpurenderbundleencoder_free(ptr, 0);
    }
    /**
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint} offset
     */
    drawIndexedIndirect(buffer, offset) {
        _assertClass(buffer, RhiWgpuBuffer);
        const ret = wasm.rhiwgpurenderbundleencoder_drawIndexedIndirect(this.__wbg_ptr, buffer.__wbg_ptr, offset);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} count
     * @param {number | null} [instances]
     * @param {number | null} [first]
     * @param {number | null} [base]
     * @param {number | null} [first_instance]
     */
    drawIndexed(count, instances, first, base, first_instance) {
        const ret = wasm.rhiwgpurenderbundleencoder_drawIndexed(this.__wbg_ptr, count, isLikeNone(instances) ? Number.MAX_SAFE_INTEGER : (instances) >>> 0, isLikeNone(first) ? Number.MAX_SAFE_INTEGER : (first) >>> 0, isLikeNone(base) ? Number.MAX_SAFE_INTEGER : (base) >> 0, isLikeNone(first_instance) ? Number.MAX_SAFE_INTEGER : (first_instance) >>> 0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint} offset
     */
    drawIndirect(buffer, offset) {
        _assertClass(buffer, RhiWgpuBuffer);
        const ret = wasm.rhiwgpurenderbundleencoder_drawIndirect(this.__wbg_ptr, buffer.__wbg_ptr, offset);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} count
     * @param {number | null} [instances]
     * @param {number | null} [first]
     * @param {number | null} [first_instance]
     */
    draw(count, instances, first, first_instance) {
        const ret = wasm.rhiwgpurenderbundleencoder_draw(this.__wbg_ptr, count, isLikeNone(instances) ? Number.MAX_SAFE_INTEGER : (instances) >>> 0, isLikeNone(first) ? Number.MAX_SAFE_INTEGER : (first) >>> 0, isLikeNone(first_instance) ? Number.MAX_SAFE_INTEGER : (first_instance) >>> 0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {any} desc
     * @returns {RhiWgpuRenderBundle}
     */
    finish(desc) {
        const ret = wasm.rhiwgpurenderbundleencoder_finish(this.__wbg_ptr, desc);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuRenderBundle.__wrap(ret[0]);
    }
    /**
     * @param {string} label
     */
    insertDebugMarker(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rhiwgpurenderbundleencoder_insertDebugMarker(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    popDebugGroup() {
        const ret = wasm.rhiwgpurenderbundleencoder_popDebugGroup(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} label
     */
    pushDebugGroup(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rhiwgpurenderbundleencoder_pushDebugGroup(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} index
     * @param {RhiWgpuBindGroup} group
     * @param {any} offsets
     * @param {number | null} [start]
     * @param {number | null} [length]
     */
    setBindGroup(index, group, offsets, start, length) {
        _assertClass(group, RhiWgpuBindGroup);
        const ret = wasm.rhiwgpurenderbundleencoder_setBindGroup(this.__wbg_ptr, index, group.__wbg_ptr, offsets, isLikeNone(start) ? Number.MAX_SAFE_INTEGER : (start) >>> 0, isLikeNone(length) ? Number.MAX_SAFE_INTEGER : (length) >>> 0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {RhiWgpuBuffer} buffer
     * @param {string} format
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     */
    setIndexBuffer(buffer, format, offset, size) {
        _assertClass(buffer, RhiWgpuBuffer);
        const ptr0 = passStringToWasm0(format, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rhiwgpurenderbundleencoder_setIndexBuffer(this.__wbg_ptr, buffer.__wbg_ptr, ptr0, len0, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {RhiWgpuRenderPipeline} pipeline
     */
    setPipeline(pipeline) {
        _assertClass(pipeline, RhiWgpuRenderPipeline);
        const ret = wasm.rhiwgpurenderbundleencoder_setPipeline(this.__wbg_ptr, pipeline.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} slot
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     */
    setVertexBuffer(slot, buffer, offset, size) {
        _assertClass(buffer, RhiWgpuBuffer);
        const ret = wasm.rhiwgpurenderbundleencoder_setVertexBuffer(this.__wbg_ptr, slot, buffer.__wbg_ptr, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) RhiWgpuRenderBundleEncoder.prototype[Symbol.dispose] = RhiWgpuRenderBundleEncoder.prototype.free;

export class RhiWgpuRenderPass {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuRenderPass.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuRenderPassFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuRenderPassFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpurenderpass_free(ptr, 0);
    }
    /**
     * @param {number} query_index
     */
    beginOcclusionQuery(query_index) {
        wasm.rhiwgpurenderpass_beginOcclusionQuery(this.__wbg_ptr, query_index);
    }
    /**
     * @param {RhiWgpuBuffer} indirect_buffer
     * @param {bigint} indirect_offset
     */
    drawIndexedIndirect(indirect_buffer, indirect_offset) {
        _assertClass(indirect_buffer, RhiWgpuBuffer);
        wasm.rhiwgpurenderpass_drawIndexedIndirect(this.__wbg_ptr, indirect_buffer.__wbg_ptr, indirect_offset);
    }
    /**
     * @param {number} index_count
     * @param {number | null | undefined} instance_count
     * @param {number} first_index
     * @param {number} base_vertex
     * @param {number} first_instance
     */
    drawIndexed(index_count, instance_count, first_index, base_vertex, first_instance) {
        wasm.rhiwgpurenderpass_drawIndexed(this.__wbg_ptr, index_count, isLikeNone(instance_count) ? Number.MAX_SAFE_INTEGER : (instance_count) >>> 0, first_index, base_vertex, first_instance);
    }
    /**
     * @param {RhiWgpuBuffer} indirect_buffer
     * @param {bigint} indirect_offset
     */
    drawIndirect(indirect_buffer, indirect_offset) {
        _assertClass(indirect_buffer, RhiWgpuBuffer);
        wasm.rhiwgpurenderpass_drawIndirect(this.__wbg_ptr, indirect_buffer.__wbg_ptr, indirect_offset);
    }
    /**
     * @param {number} vertex_count
     * @param {number | null | undefined} instance_count
     * @param {number} first_vertex
     * @param {number} first_instance
     */
    draw(vertex_count, instance_count, first_vertex, first_instance) {
        wasm.rhiwgpurenderpass_draw(this.__wbg_ptr, vertex_count, isLikeNone(instance_count) ? Number.MAX_SAFE_INTEGER : (instance_count) >>> 0, first_vertex, first_instance);
    }
    endOcclusionQuery() {
        wasm.rhiwgpurenderpass_endOcclusionQuery(this.__wbg_ptr);
    }
    end() {
        wasm.rhiwgpurenderpass_end(this.__wbg_ptr);
    }
    /**
     * @param {Array<any>} bundles
     */
    executeBundles(bundles) {
        const ret = wasm.rhiwgpurenderpass_executeBundles(this.__wbg_ptr, bundles);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} label
     */
    insertDebugMarker(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpurenderpass_insertDebugMarker(this.__wbg_ptr, ptr0, len0);
    }
    popDebugGroup() {
        wasm.rhiwgpurenderpass_popDebugGroup(this.__wbg_ptr);
    }
    /**
     * @param {string} label
     */
    pushDebugGroup(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpurenderpass_pushDebugGroup(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * bug-20260610 Gap 13: setBindGroup variadic spec form. Supports
     * `(index, bindGroup)` and `(index, bindGroup, dynamicOffsets)` and the
     * 3-form `(index, bindGroup, dynamicOffsetsData, start, length)`.
     * Defensive: dynamic offsets default to empty when `dyn_offsets_js` is
     * undefined / null.
     * @param {number} index
     * @param {RhiWgpuBindGroup} bind_group
     * @param {any} dyn_offsets_js
     * @param {number | null} [start]
     * @param {number | null} [length]
     */
    setBindGroup(index, bind_group, dyn_offsets_js, start, length) {
        _assertClass(bind_group, RhiWgpuBindGroup);
        wasm.rhiwgpurenderpass_setBindGroup(this.__wbg_ptr, index, bind_group.__wbg_ptr, dyn_offsets_js, isLikeNone(start) ? Number.MAX_SAFE_INTEGER : (start) >>> 0, isLikeNone(length) ? Number.MAX_SAFE_INTEGER : (length) >>> 0);
    }
    /**
     * @param {any} color_js
     */
    setBlendConstant(color_js) {
        wasm.rhiwgpurenderpass_setBlendConstant(this.__wbg_ptr, color_js);
    }
    /**
     * bug-20260610 Gap 13: setIndexBuffer per WebGPU spec
     * `(buffer, format, offset?, size?)`. Format is `'uint16' | 'uint32'`.
     * @param {RhiWgpuBuffer} buffer
     * @param {string} format
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     */
    setIndexBuffer(buffer, format, offset, size) {
        _assertClass(buffer, RhiWgpuBuffer);
        const ptr0 = passStringToWasm0(format, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpurenderpass_setIndexBuffer(this.__wbg_ptr, buffer.__wbg_ptr, ptr0, len0, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
    }
    /**
     * @param {RhiWgpuRenderPipeline} pipeline
     */
    setPipeline(pipeline) {
        _assertClass(pipeline, RhiWgpuRenderPipeline);
        wasm.rhiwgpurenderpass_setPipeline(this.__wbg_ptr, pipeline.__wbg_ptr);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     */
    setScissorRect(x, y, w, h) {
        wasm.rhiwgpurenderpass_setScissorRect(this.__wbg_ptr, x, y, w, h);
    }
    /**
     * @param {number} reference
     */
    setStencilReference(reference) {
        wasm.rhiwgpurenderpass_setStencilReference(this.__wbg_ptr, reference);
    }
    /**
     * @param {number} slot
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint} offset
     * @param {bigint | null} [_size]
     */
    setVertexBuffer(slot, buffer, offset, _size) {
        _assertClass(buffer, RhiWgpuBuffer);
        wasm.rhiwgpurenderpass_setVertexBuffer(this.__wbg_ptr, slot, buffer.__wbg_ptr, offset, !isLikeNone(_size), isLikeNone(_size) ? BigInt(0) : _size);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {number} min_depth
     * @param {number} max_depth
     */
    setViewport(x, y, width, height, min_depth, max_depth) {
        wasm.rhiwgpurenderpass_setViewport(this.__wbg_ptr, x, y, width, height, min_depth, max_depth);
    }
}
if (Symbol.dispose) RhiWgpuRenderPass.prototype[Symbol.dispose] = RhiWgpuRenderPass.prototype.free;

export class RhiWgpuRenderPipeline {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuRenderPipeline.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuRenderPipelineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuRenderPipelineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpurenderpipeline_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuRenderPipeline.prototype[Symbol.dispose] = RhiWgpuRenderPipeline.prototype.free;

export class RhiWgpuSampler {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuSampler.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuSamplerFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuSamplerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpusampler_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get forgeaxResourceKind() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rhiwgpusampler_forgeaxResourceKind(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpusampler_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuSampler.prototype[Symbol.dispose] = RhiWgpuSampler.prototype.free;

export class RhiWgpuShaderModule {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuShaderModule.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuShaderModuleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuShaderModuleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpushadermodule_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpushadermodule_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuShaderModule.prototype[Symbol.dispose] = RhiWgpuShaderModule.prototype.free;

export class RhiWgpuSurface {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuSurface.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuSurfaceFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuSurfaceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpusurface_free(ptr, 0);
    }
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
     * @param {any} desc_js
     */
    configure(desc_js) {
        const ret = wasm.rhiwgpusurface_configure(this.__wbg_ptr, desc_js);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {RhiWgpuSurfaceTexture}
     */
    getCurrentTexture() {
        const ret = wasm.rhiwgpusurface_getCurrentTexture(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuSurfaceTexture.__wrap(ret[0]);
    }
    /**
     * Probe the configured concrete presentation surface. Acquisition and
     * validation are established by acquiring and presenting one real surface
     * image; this method does not claim pixel readback.
     * @returns {any}
     */
    probeSurfacePresentation() {
        const ret = wasm.rhiwgpusurface_probeSurfacePresentation(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) RhiWgpuSurface.prototype[Symbol.dispose] = RhiWgpuSurface.prototype.free;

export class RhiWgpuSurfaceTexture {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuSurfaceTexture.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuSurfaceTextureFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuSurfaceTextureFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpusurfacetexture_free(ptr, 0);
    }
    /**
     * bug-20260610: clone the inner Texture (wgpu::Texture is Arc-Clone)
     * rather than ptr::read + mem::forget'ing the SurfaceTexture. The
     * previous shape leaked the SurfaceTexture forever, so wgpu_core
     * never saw the previous frame's release and panicked
     * "Surface image is already acquired" on the second
     * `getCurrentTexture()`. The new shape keeps the SurfaceTexture in
     * `self.inner` so the JS-side `present()` call (added below) can
     * release it.
     * @returns {RhiWgpuTexture}
     */
    getTexture() {
        const ret = wasm.rhiwgpusurfacetexture_getTexture(this.__wbg_ptr);
        return RhiWgpuTexture.__wrap(ret);
    }
    /**
     * bug-20260610: spec-shaped `present()` so the runtime per-frame loop
     * can release the acquired surface image after queue.submit. Without
     * this the next frame's `getCurrentTexture()` panics inside
     * wgpu_core::Storage with "Surface image is already acquired".
     * WebGPU spec auto-presents on next browser frame, but wgpu's GLES /
     * native backend requires explicit present (mirrors the requestSurface
     * flow in winit / glutin programs).
     */
    present() {
        const ret = wasm.rhiwgpusurfacetexture_present(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) RhiWgpuSurfaceTexture.prototype[Symbol.dispose] = RhiWgpuSurfaceTexture.prototype.free;

export class RhiWgpuTexture {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuTexture.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuTextureFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuTextureFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgputexture_free(ptr, 0);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuTextureView}
     */
    createView(desc_js) {
        const ret = wasm.rhiwgputexture_createView(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuTextureView.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    get depthOrArrayLayers() {
        const ret = wasm.rhiwgputexture_depthOrArrayLayers(this.__wbg_ptr);
        return ret >>> 0;
    }
    destroy() {
        wasm.rhiwgputexture_destroy(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.rhiwgputexture_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * bug-20260610: spec-aligned getters so the engine can read swap-chain
     * texture dimensions. Without these, `currentTexture.width` reads
     * `undefined`, the runtime computes `targetW = (undefined | 0) === 0`,
     * and `Device::create_texture` for the depth attachment trips
     * `Dimension X is zero`.
     * @returns {number}
     */
    get width() {
        const ret = wasm.rhiwgputexture_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuTexture.prototype[Symbol.dispose] = RhiWgpuTexture.prototype.free;

export class RhiWgpuTextureView {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuTextureView.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuTextureViewFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuTextureViewFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgputextureview_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get forgeaxResourceKind() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rhiwgputextureview_forgeaxResourceKind(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgputextureview_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuTextureView.prototype[Symbol.dispose] = RhiWgpuTextureView.prototype.free;

/**
 * Handle for the `validate` output. Carries both Module and ModuleInfo; passed into
 * `emit_reflection`.
 */
export class ValidatedModule {
    static __wrap(ptr) {
        const obj = Object.create(ValidatedModule.prototype);
        obj.__wbg_ptr = ptr;
        ValidatedModuleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ValidatedModuleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_validatedmodule_free(ptr, 0);
    }
}
if (Symbol.dispose) ValidatedModule.prototype[Symbol.dispose] = ValidatedModule.prototype.free;

/**
 * Compose a WGSL shader via naga_oil and serialise the composed naga module
 * back to WGSL text (plan-strategy D-01 Rust-side composer).
 * @param {string} entry_source
 * @param {string} imports_json
 * @param {string} defines_json
 * @returns {string}
 */
export function compose_shader(entry_source, imports_json, defines_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(entry_source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(imports_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(defines_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.compose_shader(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * `ValidatedModule` + options JSON -> `BindGroupLayoutDescriptor[]` JSON string.
 *
 * `options_json` shape: `{ "dynamicOffsets": [{ "group": u32, "binding": u32 }, ...] }`.
 * The naga IR does not express the dynamic-offset dimension (see research Finding 2
 * footnote), so it is injected via JS-side options.
 * @param {ValidatedModule} validated
 * @param {string} options_json
 * @returns {string}
 */
export function emit_reflection(validated, options_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        _assertClass(validated, ValidatedModule);
        const ptr0 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.emit_reflection(validated.__wbg_ptr, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * WGSL source -> `naga::Module`. On failure throws a `JsError` whose payload carries
 * `message` / `line_num` / `line_pos`.
 * @param {string} source
 * @returns {ParsedModule}
 */
export function parse(source) {
    const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ParsedModule.__wrap(ret[0]);
}

/**
 * Produce portable WGSL for each selected compute entry; never driver binaries.
 * @param {string} source
 * @param {string} entries_json
 * @returns {string}
 */
export function specialize_compute_entries(source, entries_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(entries_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.specialize_compute_entries(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

export function start() {
    wasm.start();
}

/**
 * `naga::Module` -> `ModuleInfo`. On failure throws a `JsError` whose message is the
 * validator's prose diagnostic (no source position is attached).
 * @param {ParsedModule} parsed
 * @returns {ValidatedModule}
 */
export function validate(parsed) {
    _assertClass(parsed, ParsedModule);
    var ptr0 = parsed.__destroy_into_raw();
    const ret = wasm.validate(ptr0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ValidatedModule.__wrap(ret[0]);
}

/**
 * Validate the selected graphics stages, rather than merely the whole module.
 * @param {ValidatedModule} validated
 * @param {string} vertex
 * @param {string | null} [fragment]
 * @param {string | null} [color_formats]
 */
export function validate_render_entries(validated, vertex, fragment, color_formats) {
    _assertClass(validated, ValidatedModule);
    const ptr0 = passStringToWasm0(vertex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(fragment) ? 0 : passStringToWasm0(fragment, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(color_formats) ? 0 : passStringToWasm0(color_formats, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    const ret = wasm.validate_render_entries(validated.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_14af1003b8dd5ead: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_a2383202b9353e4c: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_5b446f51afd21013: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_4687d8d8c2017d52: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_92f62ee1427d9e49: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_b123553bed3bb382: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_e343b7d08827ba72: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_3c45d4f2dde4e749: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_90b56bc79aad6f6c: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_02babf21faa37971: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_677f21e468d6b461: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_2e0e7dee9f701a71: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_dcc1a90847f04c41: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_activeTexture_11079673eac5c921: function(arg0, arg1) {
            arg0.activeTexture(arg1 >>> 0);
        },
        __wbg_activeTexture_2fad46c01cafe6b1: function(arg0, arg1) {
            arg0.activeTexture(arg1 >>> 0);
        },
        __wbg_add_fe5625748340d98f: function(arg0, arg1) {
            const ret = arg0.add(arg1);
            return ret;
        },
        __wbg_attachShader_8920a5beea54aba7: function(arg0, arg1, arg2) {
            arg0.attachShader(arg1, arg2);
        },
        __wbg_attachShader_9567ae57af6746d5: function(arg0, arg1, arg2) {
            arg0.attachShader(arg1, arg2);
        },
        __wbg_beginQuery_eaee271e7ccd67d1: function(arg0, arg1, arg2) {
            arg0.beginQuery(arg1 >>> 0, arg2);
        },
        __wbg_bindAttribLocation_6a6f66cbe96ef24e: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.bindAttribLocation(arg1, arg2 >>> 0, getStringFromWasm0(arg3, arg4));
        },
        __wbg_bindAttribLocation_ade0ee986a734cdf: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.bindAttribLocation(arg1, arg2 >>> 0, getStringFromWasm0(arg3, arg4));
        },
        __wbg_bindBufferRange_a5aef3642afdabc8: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.bindBufferRange(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
        },
        __wbg_bindBuffer_0324f62b876c4403: function(arg0, arg1, arg2) {
            arg0.bindBuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindBuffer_2195e89b585ce0c3: function(arg0, arg1, arg2) {
            arg0.bindBuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindFramebuffer_22e4b8e6e6d8d0e8: function(arg0, arg1, arg2) {
            arg0.bindFramebuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindFramebuffer_378eb18ef219d37a: function(arg0, arg1, arg2) {
            arg0.bindFramebuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindRenderbuffer_db090531fb28de34: function(arg0, arg1, arg2) {
            arg0.bindRenderbuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindRenderbuffer_e0c5aeef245a913a: function(arg0, arg1, arg2) {
            arg0.bindRenderbuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindSampler_9b9743706aee71d1: function(arg0, arg1, arg2) {
            arg0.bindSampler(arg1 >>> 0, arg2);
        },
        __wbg_bindTexture_3cf008f256f3ed99: function(arg0, arg1, arg2) {
            arg0.bindTexture(arg1 >>> 0, arg2);
        },
        __wbg_bindTexture_613a47b8917a0ccd: function(arg0, arg1, arg2) {
            arg0.bindTexture(arg1 >>> 0, arg2);
        },
        __wbg_bindVertexArrayOES_3141815cb8234a6e: function(arg0, arg1) {
            arg0.bindVertexArrayOES(arg1);
        },
        __wbg_bindVertexArray_f58af0a346185ec5: function(arg0, arg1) {
            arg0.bindVertexArray(arg1);
        },
        __wbg_blendColor_68fc6d6454f2128d: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.blendColor(arg1, arg2, arg3, arg4);
        },
        __wbg_blendColor_a6256f41d1925899: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.blendColor(arg1, arg2, arg3, arg4);
        },
        __wbg_blendEquationSeparate_0a17fa4ea863d445: function(arg0, arg1, arg2) {
            arg0.blendEquationSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blendEquationSeparate_fa2d4e5dde5ad8b3: function(arg0, arg1, arg2) {
            arg0.blendEquationSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blendEquation_5fb8aee6a55cf900: function(arg0, arg1) {
            arg0.blendEquation(arg1 >>> 0);
        },
        __wbg_blendEquation_d21914e937b14896: function(arg0, arg1) {
            arg0.blendEquation(arg1 >>> 0);
        },
        __wbg_blendFuncSeparate_28abe082febb1a26: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.blendFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_blendFuncSeparate_2af9d47f7efc0452: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.blendFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_blendFunc_491ee1105079ce76: function(arg0, arg1, arg2) {
            arg0.blendFunc(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blendFunc_589e4252bb396484: function(arg0, arg1, arg2) {
            arg0.blendFunc(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blitFramebuffer_7b39bfec6cfece56: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.blitFramebuffer(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0);
        },
        __wbg_bufferData_50f5eb06469330e4: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferData_53e0f7a06b58fe81: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferData_5fa44d94fe7a3878: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferData_bad7ce562b6a9eac: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferSubData_22c4c420e0f67cda: function(arg0, arg1, arg2, arg3) {
            arg0.bufferSubData(arg1 >>> 0, arg2, arg3);
        },
        __wbg_bufferSubData_8609cd8a2c013181: function(arg0, arg1, arg2, arg3) {
            arg0.bufferSubData(arg1 >>> 0, arg2, arg3);
        },
        __wbg_buffer_56ec2905a66f58b9: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_byteLength_27689b065d089962: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_call_1875a20c43a36133: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_call_187d372bd5fdd4aa: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_6137034ef55c9d0f: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_clearBufferfv_05f7fc7252e623eb: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.clearBufferfv(arg1 >>> 0, arg2, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_clearBufferiv_e8e740accbd0f2df: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.clearBufferiv(arg1 >>> 0, arg2, getArrayI32FromWasm0(arg3, arg4));
        },
        __wbg_clearBufferuiv_e7f50f91f2195e38: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.clearBufferuiv(arg1 >>> 0, arg2, getArrayU32FromWasm0(arg3, arg4));
        },
        __wbg_clearDepth_4840a5497ae51286: function(arg0, arg1) {
            arg0.clearDepth(arg1);
        },
        __wbg_clearDepth_5a119c24c5d193bc: function(arg0, arg1) {
            arg0.clearDepth(arg1);
        },
        __wbg_clearStencil_1b8b8c727f598eec: function(arg0, arg1) {
            arg0.clearStencil(arg1);
        },
        __wbg_clearStencil_e4383e4a543e7997: function(arg0, arg1) {
            arg0.clearStencil(arg1);
        },
        __wbg_clear_175cf3cb6d98d72b: function(arg0, arg1) {
            arg0.clear(arg1 >>> 0);
        },
        __wbg_clear_cb96796cc568b7c8: function(arg0, arg1) {
            arg0.clear(arg1 >>> 0);
        },
        __wbg_clientWaitSync_73122aa040ce343d: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.clientWaitSync(arg1, arg2 >>> 0, arg3 >>> 0);
            return ret;
        },
        __wbg_clipControlEXT_91e8aacf9c3d5999: function(arg0, arg1, arg2) {
            arg0.clipControlEXT(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_colorMask_4d6afbbbc3022fbe: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.colorMask(arg1 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
        },
        __wbg_colorMask_8c903995f6f873be: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.colorMask(arg1 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
        },
        __wbg_compileShader_073a75409aaf96d2: function(arg0, arg1) {
            arg0.compileShader(arg1);
        },
        __wbg_compileShader_c2b53ff3a8851f60: function(arg0, arg1) {
            arg0.compileShader(arg1);
        },
        __wbg_compressedTexSubImage2D_4942a783e20221c2: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
            arg0.compressedTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8);
        },
        __wbg_compressedTexSubImage2D_4c408678ff5f3056: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.compressedTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8, arg9);
        },
        __wbg_compressedTexSubImage2D_80961cdbbd2b3aea: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
            arg0.compressedTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8);
        },
        __wbg_compressedTexSubImage3D_1e0f86237d82f8b9: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.compressedTexSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10);
        },
        __wbg_compressedTexSubImage3D_682e402a0ac201ba: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.compressedTexSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10, arg11);
        },
        __wbg_copyBufferSubData_e82219c4834bd9ae: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.copyBufferSubData(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
        },
        __wbg_copyTexSubImage2D_455fba12cf4a776c: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
            arg0.copyTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
        },
        __wbg_copyTexSubImage2D_fe71e36efa520f37: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
            arg0.copyTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
        },
        __wbg_copyTexSubImage3D_717cd6c97934f2e6: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.copyTexSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
        },
        __wbg_createBuffer_d1dd23bf8704564c: function(arg0) {
            const ret = arg0.createBuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createBuffer_ffe613371d42cfd3: function(arg0) {
            const ret = arg0.createBuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createFramebuffer_2c6b5b0f49c88e5d: function(arg0) {
            const ret = arg0.createFramebuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createFramebuffer_d0969af4e9886297: function(arg0) {
            const ret = arg0.createFramebuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createProgram_cbf448e6f18a9402: function(arg0) {
            const ret = arg0.createProgram();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createProgram_e0c81b0d2b8d0fd0: function(arg0) {
            const ret = arg0.createProgram();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createQuery_ec241083d0b36197: function(arg0) {
            const ret = arg0.createQuery();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createRenderbuffer_2b17e9fe2e6fb4be: function(arg0) {
            const ret = arg0.createRenderbuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createRenderbuffer_c864095d6ebd60d0: function(arg0) {
            const ret = arg0.createRenderbuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createSampler_1b330d9da0c6523f: function(arg0) {
            const ret = arg0.createSampler();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createShader_6c1a2295587878a5: function(arg0, arg1) {
            const ret = arg0.createShader(arg1 >>> 0);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createShader_7c9d99a21ecb08c0: function(arg0, arg1) {
            const ret = arg0.createShader(arg1 >>> 0);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createTexture_01e8e591b64237de: function(arg0) {
            const ret = arg0.createTexture();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createTexture_5f2583508ebe379b: function(arg0) {
            const ret = arg0.createTexture();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createVertexArrayOES_a8dc8498b56df937: function(arg0) {
            const ret = arg0.createVertexArrayOES();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createVertexArray_b223ea69dd08fcab: function(arg0) {
            const ret = arg0.createVertexArray();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_cullFace_12123c1c97f1ba2c: function(arg0, arg1) {
            arg0.cullFace(arg1 >>> 0);
        },
        __wbg_cullFace_1a01f0b6d5aeb687: function(arg0, arg1) {
            arg0.cullFace(arg1 >>> 0);
        },
        __wbg_deleteBuffer_070e58aaaf2a7a8b: function(arg0, arg1) {
            arg0.deleteBuffer(arg1);
        },
        __wbg_deleteBuffer_7775ee9e248c8468: function(arg0, arg1) {
            arg0.deleteBuffer(arg1);
        },
        __wbg_deleteFramebuffer_3f8ab330098bf8e6: function(arg0, arg1) {
            arg0.deleteFramebuffer(arg1);
        },
        __wbg_deleteFramebuffer_570d3b214a509fa2: function(arg0, arg1) {
            arg0.deleteFramebuffer(arg1);
        },
        __wbg_deleteProgram_822906f0368175d0: function(arg0, arg1) {
            arg0.deleteProgram(arg1);
        },
        __wbg_deleteProgram_b524b30ad176cdb4: function(arg0, arg1) {
            arg0.deleteProgram(arg1);
        },
        __wbg_deleteQuery_266895df9763e0b3: function(arg0, arg1) {
            arg0.deleteQuery(arg1);
        },
        __wbg_deleteRenderbuffer_826c9b43b7ea68f5: function(arg0, arg1) {
            arg0.deleteRenderbuffer(arg1);
        },
        __wbg_deleteRenderbuffer_f4e121a3ab21c605: function(arg0, arg1) {
            arg0.deleteRenderbuffer(arg1);
        },
        __wbg_deleteSampler_f8afded8bf215d53: function(arg0, arg1) {
            arg0.deleteSampler(arg1);
        },
        __wbg_deleteShader_a70f6cc1918d67eb: function(arg0, arg1) {
            arg0.deleteShader(arg1);
        },
        __wbg_deleteShader_da18a294158c2d15: function(arg0, arg1) {
            arg0.deleteShader(arg1);
        },
        __wbg_deleteSync_4f0be28b03f50495: function(arg0, arg1) {
            arg0.deleteSync(arg1);
        },
        __wbg_deleteTexture_78c170241204a466: function(arg0, arg1) {
            arg0.deleteTexture(arg1);
        },
        __wbg_deleteTexture_9f42750adb092e4f: function(arg0, arg1) {
            arg0.deleteTexture(arg1);
        },
        __wbg_deleteVertexArrayOES_e01f31634d466176: function(arg0, arg1) {
            arg0.deleteVertexArrayOES(arg1);
        },
        __wbg_deleteVertexArray_ca9768805d051d49: function(arg0, arg1) {
            arg0.deleteVertexArray(arg1);
        },
        __wbg_depthFunc_92e96d8f46a23300: function(arg0, arg1) {
            arg0.depthFunc(arg1 >>> 0);
        },
        __wbg_depthFunc_a41fb5adacb22e09: function(arg0, arg1) {
            arg0.depthFunc(arg1 >>> 0);
        },
        __wbg_depthMask_06ecff4d4514c38f: function(arg0, arg1) {
            arg0.depthMask(arg1 !== 0);
        },
        __wbg_depthMask_0d7c3dec3b8405ee: function(arg0, arg1) {
            arg0.depthMask(arg1 !== 0);
        },
        __wbg_depthRange_24c7969249461e8e: function(arg0, arg1, arg2) {
            arg0.depthRange(arg1, arg2);
        },
        __wbg_depthRange_6a4e169ccf314148: function(arg0, arg1, arg2) {
            arg0.depthRange(arg1, arg2);
        },
        __wbg_disableVertexAttribArray_11c9f11bee30c9d8: function(arg0, arg1) {
            arg0.disableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_disableVertexAttribArray_c4c8af1f9e4120d4: function(arg0, arg1) {
            arg0.disableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_disable_19fe787eccdf0272: function(arg0, arg1) {
            arg0.disable(arg1 >>> 0);
        },
        __wbg_disable_81b2cb5f8cea15ae: function(arg0, arg1) {
            arg0.disable(arg1 >>> 0);
        },
        __wbg_displayHeight_903e670be87f29ab: function(arg0) {
            const ret = arg0.displayHeight;
            return ret;
        },
        __wbg_displayWidth_5da2bf55e335368a: function(arg0) {
            const ret = arg0.displayWidth;
            return ret;
        },
        __wbg_document_9854e03c05fc8834: function(arg0) {
            const ret = arg0.document;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_done_b41a1d26cdb37fb6: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_drawArraysInstancedANGLE_b76512b5abba6668: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.drawArraysInstancedANGLE(arg1 >>> 0, arg2, arg3, arg4);
        },
        __wbg_drawArraysInstanced_9b44aa78a087154d: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.drawArraysInstanced(arg1 >>> 0, arg2, arg3, arg4);
        },
        __wbg_drawArrays_08872e02fb57b847: function(arg0, arg1, arg2, arg3) {
            arg0.drawArrays(arg1 >>> 0, arg2, arg3);
        },
        __wbg_drawArrays_741af5c3f8db636f: function(arg0, arg1, arg2, arg3) {
            arg0.drawArrays(arg1 >>> 0, arg2, arg3);
        },
        __wbg_drawBuffersWEBGL_c1bc0bbfd584c9b2: function(arg0, arg1) {
            arg0.drawBuffersWEBGL(arg1);
        },
        __wbg_drawBuffers_7a58bd4729f7a1fc: function(arg0, arg1) {
            arg0.drawBuffers(arg1);
        },
        __wbg_drawElementsInstancedANGLE_c3fc0cfa9e29a1bc: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.drawElementsInstancedANGLE(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_drawElementsInstanced_d7c396aa034159b6: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.drawElementsInstanced(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_enableVertexAttribArray_1496b78a8dbab9fd: function(arg0, arg1) {
            arg0.enableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_enableVertexAttribArray_d52693866bc8b8dd: function(arg0, arg1) {
            arg0.enableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_enable_6eeb9c0e9b483cee: function(arg0, arg1) {
            arg0.enable(arg1 >>> 0);
        },
        __wbg_enable_cb4fc19b51148c37: function(arg0, arg1) {
            arg0.enable(arg1 >>> 0);
        },
        __wbg_endQuery_73863d04a795d520: function(arg0, arg1) {
            arg0.endQuery(arg1 >>> 0);
        },
        __wbg_entries_fb6397112b1de25f: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_fenceSync_330293024adb66bc: function(arg0, arg1, arg2) {
            const ret = arg0.fenceSync(arg1 >>> 0, arg2 >>> 0);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_finish_173a156040775de3: function(arg0) {
            arg0.finish();
        },
        __wbg_finish_31ffb964be7e9749: function(arg0) {
            arg0.finish();
        },
        __wbg_flush_13b162660ad850d2: function(arg0) {
            arg0.flush();
        },
        __wbg_flush_a5ad38200881ac35: function(arg0) {
            arg0.flush();
        },
        __wbg_framebufferRenderbuffer_1c6337e0030411f3: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.framebufferRenderbuffer(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4);
        },
        __wbg_framebufferRenderbuffer_f019e9231b142c0d: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.framebufferRenderbuffer(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4);
        },
        __wbg_framebufferTexture2D_73c52f23ec33aa22: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.framebufferTexture2D(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5);
        },
        __wbg_framebufferTexture2D_caddefa1f767646e: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.framebufferTexture2D(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5);
        },
        __wbg_framebufferTextureLayer_1d5c0f0e3234e521: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.framebufferTextureLayer(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
        },
        __wbg_framebufferTextureMultiviewOVR_77f19224ff7be6ef: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.framebufferTextureMultiviewOVR(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5, arg6);
        },
        __wbg_from_296ca31f8d0f1c52: function(arg0) {
            const ret = Array.from(arg0);
            return ret;
        },
        __wbg_frontFace_6751b4b97f997aeb: function(arg0, arg1) {
            arg0.frontFace(arg1 >>> 0);
        },
        __wbg_frontFace_b064adb15b6f3772: function(arg0, arg1) {
            arg0.frontFace(arg1 >>> 0);
        },
        __wbg_getBufferSubData_dd23246099b166d1: function(arg0, arg1, arg2, arg3) {
            arg0.getBufferSubData(arg1 >>> 0, arg2, arg3);
        },
        __wbg_getContext_051324720aa5b7e8: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.getContext(getStringFromWasm0(arg1, arg2), arg3);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_getContext_189ce278aa985704: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.getContext(getStringFromWasm0(arg1, arg2), arg3);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_getExtension_abfda2c5db286b07: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.getExtension(getStringFromWasm0(arg1, arg2));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_getIndexedParameter_0f49864473e337fa: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.getIndexedParameter(arg1 >>> 0, arg2 >>> 0);
            return ret;
        }, arguments); },
        __wbg_getParameter_974595a6624c6c10: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.getParameter(arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_getParameter_a97f491753b05668: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.getParameter(arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_getProgramInfoLog_208fb1ff31006495: function(arg0, arg1, arg2) {
            const ret = arg1.getProgramInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getProgramInfoLog_3276b294d6d42fe2: function(arg0, arg1, arg2) {
            const ret = arg1.getProgramInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getProgramParameter_50bafab01cf88652: function(arg0, arg1, arg2) {
            const ret = arg0.getProgramParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getProgramParameter_fc7124bb9fb7c675: function(arg0, arg1, arg2) {
            const ret = arg0.getProgramParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getQueryParameter_937ba13f77db778f: function(arg0, arg1, arg2) {
            const ret = arg0.getQueryParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getShaderInfoLog_7e0cbba353ca95da: function(arg0, arg1, arg2) {
            const ret = arg1.getShaderInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getShaderInfoLog_bb64c5a52df0b7a3: function(arg0, arg1, arg2) {
            const ret = arg1.getShaderInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getShaderParameter_745acf10b8e45e31: function(arg0, arg1, arg2) {
            const ret = arg0.getShaderParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getShaderParameter_e55ea9c456df5484: function(arg0, arg1, arg2) {
            const ret = arg0.getShaderParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getSupportedExtensions_1459bad37860c0c3: function(arg0) {
            const ret = arg0.getSupportedExtensions();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_getSupportedProfiles_7b2acfa66b565d24: function(arg0) {
            const ret = arg0.getSupportedProfiles();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_getSyncParameter_bb4be47b67bfa2f8: function(arg0, arg1, arg2) {
            const ret = arg0.getSyncParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getUniformBlockIndex_5e2252ceb34531a5: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.getUniformBlockIndex(arg1, getStringFromWasm0(arg2, arg3));
            return ret;
        },
        __wbg_getUniformLocation_50ba45dade572703: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.getUniformLocation(arg1, getStringFromWasm0(arg2, arg3));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_getUniformLocation_cb4e3e121235f91a: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.getUniformLocation(arg1, getStringFromWasm0(arg2, arg3));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_get_31af05bd4842a84f: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_658f6698067d9515: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_6c896e0571ddae51: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_unchecked_288889d017702237: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_height_50d2b2bc8c6ec859: function(arg0) {
            const ret = arg0.height;
            return ret;
        },
        __wbg_height_816341c9bbd4e9e3: function(arg0) {
            const ret = arg0.height;
            return ret;
        },
        __wbg_height_9dca4d43c3e4b84b: function(arg0) {
            const ret = arg0.height;
            return ret;
        },
        __wbg_height_aa756cf29b6d629c: function(arg0) {
            const ret = arg0.height;
            return ret;
        },
        __wbg_height_fc97e1a0c2e7331f: function(arg0) {
            const ret = arg0.height;
            return ret;
        },
        __wbg_includes_9b0dfa946c313621: function(arg0, arg1, arg2) {
            const ret = arg0.includes(arg1, arg2);
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_a99f175873e5d9b8: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlCanvasElement_0a30c11fbbf41841: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLCanvasElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlImageElement_1e066996b10acb3d: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLImageElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlVideoElement_23ccafac1e35054c: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLVideoElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_ImageBitmap_74bea45ee48d3d7a: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ImageBitmap;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_ImageData_121ec429b771a0f1: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ImageData;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_OffscreenCanvas_f555a827ab5d2552: function(arg0) {
            let result;
            try {
                result = arg0 instanceof OffscreenCanvas;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Promise_e1dc6893aa1ece28: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Promise;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint32Array_53a4facaf04b8a8b: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint32Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_828cef2aaacafc31: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_WebGl2RenderingContext_64c994c14c0790fb: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WebGL2RenderingContext;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Window_82d71df4eddf88bc: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_invalidateFramebuffer_4f576db65bb37d6a: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.invalidateFramebuffer(arg1 >>> 0, arg2);
        }, arguments); },
        __wbg_isArray_2b41c29f43a3fb12: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isArray_e15a2ff68ffdbef2: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isContextLost_fbbab8b921e614b7: function(arg0) {
            const ret = arg0.isContextLost();
            return ret;
        },
        __wbg_isSafeInteger_717808ad6a54bd9e: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_is_4b278c0bd3caba97: function(arg0, arg1) {
            const ret = Object.is(arg0, arg1);
            return ret;
        },
        __wbg_iterator_e3c31c892080e444: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_511b1f84719d3462: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_7f3c00c40364105e: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_d4bdea10311bd9cf: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_linkProgram_571a9ea00d38ff83: function(arg0, arg1) {
            arg0.linkProgram(arg1);
        },
        __wbg_linkProgram_acdc299c43d734a0: function(arg0, arg1) {
            arg0.linkProgram(arg1);
        },
        __wbg_new_1dbf7428bba60a42: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_2a9ffaae259649c3: function(arg0) {
            const ret = new Set(arg0);
            return ret;
        },
        __wbg_new_5502aad30c185fc8: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h1312d179d1d9248b(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_ee2291f50781bf1d: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_typed_b01cb72a8af741a3: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h1312d179d1d9248b(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_length_3da0ad195f6f63ba: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_next_33784799010f1bbe: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_f4aac29c42af995c: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_of_d5dbecdc59e02e34: function(arg0) {
            const ret = Array.of(arg0);
            return ret;
        },
        __wbg_pixelStorei_af18e636b3e7b725: function(arg0, arg1, arg2) {
            arg0.pixelStorei(arg1 >>> 0, arg2);
        },
        __wbg_pixelStorei_cb4e43466f5b8703: function(arg0, arg1, arg2) {
            arg0.pixelStorei(arg1 >>> 0, arg2);
        },
        __wbg_polygonOffset_81dc8ca84e29572b: function(arg0, arg1, arg2) {
            arg0.polygonOffset(arg1, arg2);
        },
        __wbg_polygonOffset_8f922d9173d8849d: function(arg0, arg1, arg2) {
            arg0.polygonOffset(arg1, arg2);
        },
        __wbg_prototypesetcall_06eb15da165dee8f: function(arg0, arg1, arg2) {
            Uint32Array.prototype.set.call(getArrayU32FromWasm0(arg0, arg1), arg2);
        },
        __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_2baf45db356cf468: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queryCounterEXT_9016a6ffa350b4b2: function(arg0, arg1, arg2) {
            arg0.queryCounterEXT(arg1, arg2 >>> 0);
        },
        __wbg_querySelector_ecbc2550705b235f: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.querySelector(getStringFromWasm0(arg1, arg2));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_queueMicrotask_9833f9a49df95a49: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_a72f977e97f23c5f: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_readBuffer_b5d9a34a2f3d20d5: function(arg0, arg1) {
            arg0.readBuffer(arg1 >>> 0);
        },
        __wbg_readPixels_31e44e70558ac590: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
            arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
        }, arguments); },
        __wbg_readPixels_3321086a7818a739: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
            arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
        }, arguments); },
        __wbg_readPixels_eb030cd9976eeca5: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
            arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
        }, arguments); },
        __wbg_reject_1548d2ad77237dc9: function(arg0) {
            const ret = Promise.reject(arg0);
            return ret;
        },
        __wbg_renderbufferStorageMultisample_ed16f3ef446e3bc7: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.renderbufferStorageMultisample(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_renderbufferStorage_52b131bbf3112b3a: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.renderbufferStorage(arg1 >>> 0, arg2 >>> 0, arg3, arg4);
        },
        __wbg_renderbufferStorage_bca487b0dea425b8: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.renderbufferStorage(arg1 >>> 0, arg2 >>> 0, arg3, arg4);
        },
        __wbg_resolve_0076e10020304ede: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_rhiwgpuadapter_new: function(arg0) {
            const ret = RhiWgpuAdapter.__wrap(arg0);
            return ret;
        },
        __wbg_rhiwgpucommandbuffer_unwrap: function(arg0) {
            const ret = RhiWgpuCommandBuffer.__unwrap(arg0);
            return ret;
        },
        __wbg_rhiwgpudevice_new: function(arg0) {
            const ret = RhiWgpuDevice.__wrap(arg0);
            return ret;
        },
        __wbg_rhiwgpuinstance_new: function(arg0) {
            const ret = RhiWgpuInstance.__wrap(arg0);
            return ret;
        },
        __wbg_samplerParameterf_2d62cb907392e2d6: function(arg0, arg1, arg2, arg3) {
            arg0.samplerParameterf(arg1, arg2 >>> 0, arg3);
        },
        __wbg_samplerParameteri_a5615e67ed0b654b: function(arg0, arg1, arg2, arg3) {
            arg0.samplerParameteri(arg1, arg2 >>> 0, arg3);
        },
        __wbg_scissor_12ddc324094acd50: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.scissor(arg1, arg2, arg3, arg4);
        },
        __wbg_scissor_a9468482697c2bdb: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.scissor(arg1, arg2, arg3, arg4);
        },
        __wbg_set_145a351398b48c65: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_575d3ddb70fe831d: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_height_c9789c1c77eaedff: function(arg0, arg1) {
            arg0.height = arg1 >>> 0;
        },
        __wbg_set_height_fde391767df1ce27: function(arg0, arg1) {
            arg0.height = arg1 >>> 0;
        },
        __wbg_set_width_0ca908d167690992: function(arg0, arg1) {
            arg0.width = arg1 >>> 0;
        },
        __wbg_set_width_b0e1267db4b196b5: function(arg0, arg1) {
            arg0.width = arg1 >>> 0;
        },
        __wbg_shaderSource_06379dac249994dd: function(arg0, arg1, arg2, arg3) {
            arg0.shaderSource(arg1, getStringFromWasm0(arg2, arg3));
        },
        __wbg_shaderSource_c8812639b47d87b9: function(arg0, arg1, arg2, arg3) {
            arg0.shaderSource(arg1, getStringFromWasm0(arg2, arg3));
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_266715b9d96ba635: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_0b583911f537483a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_stencilFuncSeparate_3f31dcd12a0d4785: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
        },
        __wbg_stencilFuncSeparate_f168b66c597aa85f: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
        },
        __wbg_stencilMaskSeparate_b30c097ea6b98504: function(arg0, arg1, arg2) {
            arg0.stencilMaskSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_stencilMaskSeparate_ff739f8711e9fd42: function(arg0, arg1, arg2) {
            arg0.stencilMaskSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_stencilMask_9e18cc018897c747: function(arg0, arg1) {
            arg0.stencilMask(arg1 >>> 0);
        },
        __wbg_stencilMask_a22be64c66abd825: function(arg0, arg1) {
            arg0.stencilMask(arg1 >>> 0);
        },
        __wbg_stencilOpSeparate_7d01185cbdb89d99: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilOpSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_stencilOpSeparate_c5af5f5dbd237bea: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilOpSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_texImage2D_82bf2b4c8aa9a1db: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texImage2D_a856af552acdc9d9: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texImage2D_ca3d0fe24620ec85: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texImage3D_29a847f33877ed12: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.texImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8 >>> 0, arg9 >>> 0, arg10);
        }, arguments); },
        __wbg_texImage3D_78fb39719c620063: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.texImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8 >>> 0, arg9 >>> 0, arg10);
        }, arguments); },
        __wbg_texParameteri_647fdb1426809cb5: function(arg0, arg1, arg2, arg3) {
            arg0.texParameteri(arg1 >>> 0, arg2 >>> 0, arg3);
        },
        __wbg_texParameteri_7864076abcdb03e0: function(arg0, arg1, arg2, arg3) {
            arg0.texParameteri(arg1 >>> 0, arg2 >>> 0, arg3);
        },
        __wbg_texStorage2D_cf2bd991072d9efb: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.texStorage2D(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_texStorage3D_74b701c2b176380c: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.texStorage3D(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5, arg6);
        },
        __wbg_texSubImage2D_07337d0974e99c39: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_196472d4111ce5b6: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_24cf5097ebaa84cc: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_31a0c2797aa04f32: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_5e90c7a719d40256: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_64e36398b8f046ac: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_bb322aae90f7657f: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_d7bffff06a3b8315: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage3D_001f2e62ed945b72: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_5143d5af7e182ddc: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_53c6014e2d129891: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_5d773fc7a8cd4d08: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_adb96e37e6949ec9: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_d4e74595e01f7f71: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_e0d113b7047a5130: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_then_c949d5a25a4e78f8: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_e71170d78fcf8954: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_uniform1f_9cfecfaeb8cf43c1: function(arg0, arg1, arg2) {
            arg0.uniform1f(arg1, arg2);
        },
        __wbg_uniform1f_b5856e35a43b65a1: function(arg0, arg1, arg2) {
            arg0.uniform1f(arg1, arg2);
        },
        __wbg_uniform1i_531b98c4a7177366: function(arg0, arg1, arg2) {
            arg0.uniform1i(arg1, arg2);
        },
        __wbg_uniform1i_fc2dc8cadc49d8ec: function(arg0, arg1, arg2) {
            arg0.uniform1i(arg1, arg2);
        },
        __wbg_uniform1ui_353c67ec681b540c: function(arg0, arg1, arg2) {
            arg0.uniform1ui(arg1, arg2 >>> 0);
        },
        __wbg_uniform2fv_319c49f0ce340f26: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform2fv_a7d3c1830d18c1b2: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform2iv_65f36fc9777697d7: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform2iv_ca9cb507409b9ad1: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform2uiv_c95af5fb653ccb86: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2uiv(arg1, getArrayU32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3fv_055ea5ac38af4fce: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3fv_58520ffe22a6e27c: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3iv_0590e8b7eff2a791: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3iv_e91b1410dc299f50: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3uiv_9992491000463a52: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3uiv(arg1, getArrayU32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4f_22bfec882308eec2: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.uniform4f(arg1, arg2, arg3, arg4, arg5);
        },
        __wbg_uniform4f_8dd8f311e656ca0d: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.uniform4f(arg1, arg2, arg3, arg4, arg5);
        },
        __wbg_uniform4fv_3ef2f5121fcb78ae: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4fv_cf8ff646c36232c8: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4iv_6fc5436b4f876039: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4iv_99c2b07787d362d6: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4uiv_a6fb3237d9df7ed4: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4uiv(arg1, getArrayU32FromWasm0(arg2, arg3));
        },
        __wbg_uniformBlockBinding_07116582301fb019: function(arg0, arg1, arg2, arg3) {
            arg0.uniformBlockBinding(arg1, arg2 >>> 0, arg3 >>> 0);
        },
        __wbg_uniformMatrix2fv_34b2245136106a2f: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix2fv_611c7fcb378f057e: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix2x3fv_6b33a76d09b6c00f: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix2x3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix2x4fv_66c787e2d0a5dd0a: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix2x4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix3fv_472e7824735acce1: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix3fv_83fdc9c3c0d43204: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix3x2fv_33df849b78b8556e: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix3x2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix3x4fv_8914dc5121a813b4: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix3x4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix4fv_dff9738d995fd0b1: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix4fv_e691d7f14d3609f7: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix4x2fv_1c9ccf4427b82548: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix4x2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix4x3fv_a84b16e0a7abee2c: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix4x3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_useProgram_5bdae58fd9f9826f: function(arg0, arg1) {
            arg0.useProgram(arg1);
        },
        __wbg_useProgram_e075c2902e420761: function(arg0, arg1) {
            arg0.useProgram(arg1);
        },
        __wbg_value_f3c585ee8f5ba40c: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_vertexAttribDivisorANGLE_659fb027198a47c3: function(arg0, arg1, arg2) {
            arg0.vertexAttribDivisorANGLE(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_vertexAttribDivisor_7575d382215322f7: function(arg0, arg1, arg2) {
            arg0.vertexAttribDivisor(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_vertexAttribIPointer_fc8057c62cfcc63c: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.vertexAttribIPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_vertexAttribPointer_24b495e18df325dc: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.vertexAttribPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
        },
        __wbg_vertexAttribPointer_54d56b18f71a946d: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.vertexAttribPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
        },
        __wbg_videoHeight_4070b88110b1ac0d: function(arg0) {
            const ret = arg0.videoHeight;
            return ret;
        },
        __wbg_videoWidth_ea74d0fb1493f025: function(arg0) {
            const ret = arg0.videoWidth;
            return ret;
        },
        __wbg_viewport_16936692526e2ce6: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.viewport(arg1, arg2, arg3, arg4);
        },
        __wbg_viewport_e35d16c542d2ce70: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.viewport(arg1, arg2, arg3, arg4);
        },
        __wbg_width_3b5d66c5eac1eb28: function(arg0) {
            const ret = arg0.width;
            return ret;
        },
        __wbg_width_3d0dce3d9892e35e: function(arg0) {
            const ret = arg0.width;
            return ret;
        },
        __wbg_width_7a1b335e4a553dc3: function(arg0) {
            const ret = arg0.width;
            return ret;
        },
        __wbg_width_8a9cc26363f10d5f: function(arg0) {
            const ret = arg0.width;
            return ret;
        },
        __wbg_width_c9bfe09197f3b26e: function(arg0) {
            const ret = arg0.width;
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 1746, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h9a8e4b1067196a8b);
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [String, String], shim_idx: 7, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h4183095fef8c09a0);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 9, ret: RustStruct { name: "RhiWgpuCompletionRequest", unique_crate_identifier: "wgpu-wasm-be790ca1f18a4bd9" }, inner_ret: Some(RustStruct { name: "RhiWgpuCompletionRequest", unique_crate_identifier: "wgpu-wasm-be790ca1f18a4bd9" }) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h92ceaa4223fd4913);
            return ret;
        },
        __wbindgen_generic_0000000000000004: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(F32)) -> NamedExternref("Float32Array")`.
            const ret = getArrayF32FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000006: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(I16)) -> NamedExternref("Int16Array")`.
            const ret = getArrayI16FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000007: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(I32)) -> NamedExternref("Int32Array")`.
            const ret = getArrayI32FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000008: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(I8)) -> NamedExternref("Int8Array")`.
            const ret = getArrayI8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000009: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U16)) -> NamedExternref("Uint16Array")`.
            const ret = getArrayU16FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_000000000000000a: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U32)) -> NamedExternref("Uint32Array")`.
            const ret = getArrayU32FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_000000000000000b: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_000000000000000c: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_000000000000000d: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
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
        "./wgpu_wasm_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__h92ceaa4223fd4913(arg0, arg1) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h92ceaa4223fd4913(arg0, arg1);
    return RhiWgpuCompletionRequest.__wrap(ret);
}

function wasm_bindgen__convert__closures_____invoke__h9a8e4b1067196a8b(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h9a8e4b1067196a8b(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h1312d179d1d9248b(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h1312d179d1d9248b(arg0, arg1, arg2, arg3);
}

function wasm_bindgen__convert__closures_____invoke__h4183095fef8c09a0(arg0, arg1, arg2, arg3) {
    const ptr0 = passStringToWasm0(arg2, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(arg3, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.wasm_bindgen__convert__closures_____invoke__h4183095fef8c09a0(arg0, arg1, ptr0, len0, ptr1, len1);
}

const ParsedModuleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_parsedmodule_free(ptr, 1));
const RhiWgpuAdapterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpuadapter_free(ptr, 1));
const RhiWgpuBindGroupFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpubindgroup_free(ptr, 1));
const RhiWgpuBindGroupLayoutFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpubindgrouplayout_free(ptr, 1));
const RhiWgpuBufferFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpubuffer_free(ptr, 1));
const RhiWgpuCommandBufferFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpucommandbuffer_free(ptr, 1));
const RhiWgpuCommandEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpucommandencoder_free(ptr, 1));
const RhiWgpuCompletionRequestFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpucompletionrequest_free(ptr, 1));
const RhiWgpuComputePassFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpucomputepass_free(ptr, 1));
const RhiWgpuComputePipelineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpucomputepipeline_free(ptr, 1));
const RhiWgpuDeviceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpudevice_free(ptr, 1));
const RhiWgpuInstanceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpuinstance_free(ptr, 1));
const RhiWgpuPipelineLayoutFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpupipelinelayout_free(ptr, 1));
const RhiWgpuQuerySetFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpuqueryset_free(ptr, 1));
const RhiWgpuQueueFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpuqueue_free(ptr, 1));
const RhiWgpuRenderBundleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpurenderbundle_free(ptr, 1));
const RhiWgpuRenderBundleEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpurenderbundleencoder_free(ptr, 1));
const RhiWgpuRenderPassFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpurenderpass_free(ptr, 1));
const RhiWgpuRenderPipelineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpurenderpipeline_free(ptr, 1));
const RhiWgpuSamplerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpusampler_free(ptr, 1));
const RhiWgpuShaderModuleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpushadermodule_free(ptr, 1));
const RhiWgpuSurfaceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpusurface_free(ptr, 1));
const RhiWgpuSurfaceTextureFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpusurfacetexture_free(ptr, 1));
const RhiWgpuTextureFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgputexture_free(ptr, 1));
const RhiWgpuTextureViewFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgputextureview_free(ptr, 1));
const ValidatedModuleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_validatedmodule_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedInt16ArrayMemory0 = null;
function getInt16ArrayMemory0() {
    if (cachedInt16ArrayMemory0 === null || cachedInt16ArrayMemory0.byteLength === 0) {
        cachedInt16ArrayMemory0 = new Int16Array(wasm.memory.buffer);
    }
    return cachedInt16ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

let cachedInt8ArrayMemory0 = null;
function getInt8ArrayMemory0() {
    if (cachedInt8ArrayMemory0 === null || cachedInt8ArrayMemory0.byteLength === 0) {
        cachedInt8ArrayMemory0 = new Int8Array(wasm.memory.buffer);
    }
    return cachedInt8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
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

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
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

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedInt16ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedInt8ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
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
        module_or_path = new URL('wgpu_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
