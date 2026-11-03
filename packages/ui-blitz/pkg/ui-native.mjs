import { sha256 } from '@noble/hashes/sha2.js';
const artifact = {"bytes":15695399,"sha256":"856b65ec4d79270c4518d37ac80be60e9897aeb08edd34e4e6b888dbbccd8434"};
/* @ts-self-types="./ui_blitz.d.ts" */

export class UiDocument {
    static __wrap(ptr) {
        const obj = Object.create(UiDocument.prototype);
        obj.__wbg_ptr = ptr;
        UiDocumentFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UiDocumentFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_uidocument_free(ptr, 0);
    }
    /**
     * @param {bigint} id
     * @returns {bigint}
     */
    attach_shadow(id) {
        const ret = wasm.uidocument_attach_shadow(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {bigint} id
     * @param {string} attr
     * @returns {string | undefined}
     */
    attribute(id, attr) {
        const ptr0 = passStringToWasm0(attr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_attribute(this.__wbg_ptr, id, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * @param {bigint} id
     * @returns {string[]}
     */
    attribute_names(id) {
        const ret = wasm.uidocument_attribute_names(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {bigint} id
     * @returns {boolean}
     */
    can_focus(id) {
        const ret = wasm.uidocument_can_focus(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {bigint} id
     * @returns {BigUint64Array}
     */
    children(id) {
        const ret = wasm.uidocument_children(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {bigint} id
     * @param {boolean} deep
     * @returns {bigint}
     */
    clone_node(id, deep) {
        const ret = wasm.uidocument_clone_node(this.__wbg_ptr, id, deep);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * Collect only detached subtrees with no reachable JS node wrappers. A
     * retained descendant also retains its parents and siblings, as in DOM.
     * @param {BigUint64Array} retained
     * @returns {number}
     */
    collect_detached(retained) {
        const ptr0 = passArray64ToWasm0(retained, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_collect_detached(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {bigint} id
     * @param {string} property
     * @returns {string}
     */
    computed_style(id, property) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(property, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.uidocument_computed_style(this.__wbg_ptr, id, ptr0, len0);
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
     * @param {string} tag
     * @returns {bigint}
     */
    create_element(tag) {
        const ptr0 = passStringToWasm0(tag, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_create_element(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @returns {bigint}
     */
    create_fragment() {
        const ret = wasm.uidocument_create_fragment(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {string} text
     * @returns {bigint}
     */
    create_text(text) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_create_text(this.__wbg_ptr, ptr0, len0);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    document_element() {
        const ret = wasm.uidocument_document_element(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} id
     * @param {boolean} by_pointer
     */
    focus(id, by_pointer) {
        const ret = wasm.uidocument_focus(this.__wbg_ptr, id, by_pointer);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {bigint}
     */
    focused() {
        const ret = wasm.uidocument_focused(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} id
     * @returns {bigint}
     */
    form_owner(id) {
        const ret = wasm.uidocument_form_owner(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @returns {bigint}
     */
    hit(x, y) {
        const ret = wasm.uidocument_hit(this.__wbg_ptr, x, y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {bigint} id
     * @returns {string}
     */
    inner_html(id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.uidocument_inner_html(this.__wbg_ptr, id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {bigint} id
     * @returns {boolean}
     */
    input_bad_input(id) {
        const ret = wasm.uidocument_input_bad_input(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {bigint} id
     * @returns {boolean}
     */
    input_checked(id) {
        const ret = wasm.uidocument_input_checked(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {bigint} id
     * @param {number} count
     */
    input_step(id, count) {
        const ret = wasm.uidocument_input_step(this.__wbg_ptr, id, count);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @returns {string}
     */
    input_text(id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.uidocument_input_text(this.__wbg_ptr, id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {bigint} id
     * @returns {string}
     */
    input_value(id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.uidocument_input_value(this.__wbg_ptr, id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {bigint} parent
     * @param {bigint} child
     * @param {bigint} before
     */
    insert(parent, child, before) {
        const ret = wasm.uidocument_insert(this.__wbg_ptr, parent, child, before);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    keyboard_focus() {
        wasm.uidocument_keyboard_focus(this.__wbg_ptr);
    }
    /**
     * @param {bigint} id
     * @param {string} selector
     * @returns {boolean}
     */
    matches(id, selector) {
        const ptr0 = passStringToWasm0(selector, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_matches(this.__wbg_ptr, id, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {string} html
     * @param {number} width
     * @param {number} height
     * @param {number} scale
     * @param {Uint8Array} font
     */
    constructor(html, width, height, scale, font) {
        const ptr0 = passStringToWasm0(html, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(font, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_new(ptr0, len0, width, height, scale, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        UiDocumentFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {bigint} id
     * @returns {number}
     */
    node_type(id) {
        const ret = wasm.uidocument_node_type(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * User number stepping accepts step=any as a unit increment, as native browsers do.
     * @param {bigint} id
     * @param {number} count
     */
    number_step(id, count) {
        const ret = wasm.uidocument_number_step(this.__wbg_ptr, id, count);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Number button hit-testing reuses the native transformed/clipped hit path.
     * @param {bigint} id
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    number_stepper_hit(id, x, y) {
        const ret = wasm.uidocument_number_stepper_hit(this.__wbg_ptr, id, x, y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {bigint} id
     * @returns {boolean}
     */
    option_selected(id) {
        const ret = wasm.uidocument_option_selected(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Empty means unchanged. Otherwise wasm-bindgen copies the complete RGBA
     * buffer into JS-owned bytes; no Rust pointer survives across modules.
     * @returns {Uint8Array}
     */
    paint() {
        const ret = wasm.uidocument_paint(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Owns only CPU preparation bytes. The Renderer owns device, textures and submission.
     * @returns {any}
     */
    paint_gpu() {
        const ret = wasm.uidocument_paint_gpu(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {bigint} id
     * @returns {bigint}
     */
    parent(id) {
        const ret = wasm.uidocument_parent(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {bigint} scope
     * @param {string} selector
     * @returns {BigUint64Array}
     */
    query(scope, selector) {
        const ptr0 = passStringToWasm0(selector, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_query(this.__wbg_ptr, scope, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v2;
    }
    /**
     * @param {bigint} id
     * @returns {BigUint64Array}
     */
    radio_group(id) {
        const ret = wasm.uidocument_radio_group(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {bigint} id
     * @param {string} key
     */
    range_key(id, key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_range_key(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Pointer defaults and painting use the same native value and thumb geometry.
     * @param {bigint} id
     * @param {number} x
     * @param {number} y
     */
    range_pointer(id, x, y) {
        const ret = wasm.uidocument_range_pointer(this.__wbg_ptr, id, x, y);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @returns {Float64Array}
     */
    rect(id) {
        const ret = wasm.uidocument_rect(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {bigint} id
     */
    remove(id) {
        const ret = wasm.uidocument_remove(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     */
    reset_form(id) {
        const ret = wasm.uidocument_reset_form(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Alternating URL/message pairs, drained after each transport batch.
     * @returns {string[]}
     */
    resource_errors() {
        const ret = wasm.uidocument_resource_errors(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} id
     * @param {string} message
     */
    resource_failed(id, message) {
        const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_resource_failed(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    resource_requests() {
        const ret = wasm.uidocument_resource_requests(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} id
     * @param {Uint8Array} bytes
     */
    resource_response(id, bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_resource_response(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} id
     * @returns {string}
     */
    resource_url(id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.uidocument_resource_url(this.__wbg_ptr, id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {bigint}
     */
    root() {
        const ret = wasm.uidocument_root(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * CSS/wheel deltas are positive towards larger scroll offsets. Return the
     * actual core scrollers, so JS dispatches events after releasing the borrow.
     * @param {bigint} id
     * @param {number} x
     * @param {number} y
     * @returns {BigUint64Array}
     */
    scroll_by_user(id, x, y) {
        const ret = wasm.uidocument_scroll_by_user(this.__wbg_ptr, id, x, y);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {bigint} id
     * @param {string} block
     * @param {string} inline
     * @returns {BigUint64Array}
     */
    scroll_into_view(id, block, inline) {
        const ptr0 = passStringToWasm0(block, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(inline, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_scroll_into_view(this.__wbg_ptr, id, ptr0, len0, ptr1, len1);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v3;
    }
    /**
     * @param {bigint} id
     * @returns {Float64Array}
     */
    scroll_metrics(id) {
        const ret = wasm.uidocument_scroll_metrics(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {bigint} id
     * @param {number} x
     * @param {number} y
     */
    scroll_to(id, x, y) {
        const ret = wasm.uidocument_scroll_to(this.__wbg_ptr, id, x, y);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     */
    select_close(id) {
        const ret = wasm.uidocument_select_close(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @returns {number}
     */
    select_index(id) {
        const ret = wasm.uidocument_select_index(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {bigint} id
     * @returns {boolean}
     */
    select_input_text(id) {
        const ret = wasm.uidocument_select_input_text(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {bigint} id
     * @param {string} key
     * @returns {boolean}
     */
    select_key(id, key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_select_key(this.__wbg_ptr, id, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {bigint} id
     * @returns {BigUint64Array}
     */
    select_options(id) {
        const ret = wasm.uidocument_select_options(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {bigint} id
     * @param {number} x
     * @param {number} y
     * @param {boolean} commit
     * @returns {boolean}
     */
    select_pointer(id, x, y, commit) {
        const ret = wasm.uidocument_select_pointer(this.__wbg_ptr, id, x, y, commit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {boolean} reverse
     * @returns {bigint}
     */
    sequential_focus_target(reverse) {
        const ret = wasm.uidocument_sequential_focus_target(this.__wbg_ptr, reverse);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} id
     */
    set_active(id) {
        const ret = wasm.uidocument_set_active(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @param {string} attr
     * @param {string | null} [value]
     */
    set_attribute(id, attr, value) {
        const ptr0 = passStringToWasm0(attr, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(value) ? 0 : passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_set_attribute(this.__wbg_ptr, id, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     */
    set_hover(id) {
        const ret = wasm.uidocument_set_hover(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @param {string} html
     */
    set_inner_html(id, html) {
        const ptr0 = passStringToWasm0(html, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_set_inner_html(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @param {boolean} checked
     */
    set_input_checked(id, checked) {
        const ret = wasm.uidocument_set_input_checked(this.__wbg_ptr, id, checked);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @param {string} value
     * @returns {boolean}
     */
    set_input_text(id, value) {
        const ptr0 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_set_input_text(this.__wbg_ptr, id, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {bigint} id
     * @param {string} value
     */
    set_input_value(id, value) {
        const ptr0 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_set_input_value(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @param {boolean} selected
     */
    set_option_selected(id, selected) {
        const ret = wasm.uidocument_set_option_selected(this.__wbg_ptr, id, selected);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {boolean} reduce
     */
    set_reduced_motion(reduce) {
        wasm.uidocument_set_reduced_motion(this.__wbg_ptr, reduce);
    }
    /**
     * @param {bigint} id
     * @param {number} index
     */
    set_select_index(id, index) {
        const ret = wasm.uidocument_set_select_index(this.__wbg_ptr, id, index);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @param {string} property
     * @param {string} value
     * @param {string} priority
     */
    set_style(id, property, value, priority) {
        const ptr0 = passStringToWasm0(property, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(priority, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_set_style(this.__wbg_ptr, id, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @param {string} text
     */
    set_text_content(id, text) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_set_text_content(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} time_ms
     */
    set_time(time_ms) {
        const ret = wasm.uidocument_set_time(this.__wbg_ptr, time_ms);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} width
     * @param {number} height
     * @param {number} scale
     */
    set_viewport(width, height, scale) {
        const ret = wasm.uidocument_set_viewport(this.__wbg_ptr, width, height, scale);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @returns {bigint}
     */
    shadow_host(id) {
        const ret = wasm.uidocument_shadow_host(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {bigint} id
     * @returns {bigint}
     */
    shadow_root(id) {
        const ret = wasm.uidocument_shadow_root(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {bigint} id
     * @param {string} message
     */
    show_validation_message(id, message) {
        const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_show_validation_message(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @param {string} property
     * @returns {string}
     */
    style_value(id, property) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(property, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.uidocument_style_value(this.__wbg_ptr, id, ptr0, len0);
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
     * @param {bigint} id
     * @returns {string}
     */
    tag_name(id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.uidocument_tag_name(this.__wbg_ptr, id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {bigint} id
     * @returns {bigint}
     */
    template_content(id) {
        const ret = wasm.uidocument_template_content(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {bigint} id
     * @returns {string}
     */
    text_content(id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.uidocument_text_content(this.__wbg_ptr, id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Snapshot direct-manipulation pan permissions at pointerdown. Bit 0 is X,
     * bit 1 is Y. Wheel/programmatic scrolling has independent semantics.
     * @param {bigint} id
     * @returns {number}
     */
    touch_pan_axes(id) {
        const ret = wasm.uidocument_touch_pan_axes(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {string} html
     * @param {number} width
     * @param {number} height
     * @param {number} scale
     * @param {Uint8Array} font
     * @param {string | null} [font_family]
     * @param {string | null} [base_url]
     * @returns {UiDocument}
     */
    static with_resources(html, width, height, scale, font, font_family, base_url) {
        const ptr0 = passStringToWasm0(html, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(font, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(font_family) ? 0 : passStringToWasm0(font_family, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len2 = WASM_VECTOR_LEN;
        var ptr3 = isLikeNone(base_url) ? 0 : passStringToWasm0(base_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len3 = WASM_VECTOR_LEN;
        const ret = wasm.uidocument_with_resources(ptr0, len0, width, height, scale, ptr1, len1, ptr2, len2, ptr3, len3);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return UiDocument.__wrap(ret[0]);
    }
}
if (Symbol.dispose) UiDocument.prototype[Symbol.dispose] = UiDocument.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_from_296ca31f8d0f1c52: function(arg0) {
            const ret = Array.from(arg0);
            return ret;
        },
        __wbg_new_1dbf7428bba60a42: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_ee2291f50781bf1d: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_now_aa4ccb83129e9e55: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
            const ret = arg0.performance;
            return ret;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_bea140a88be9b277: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
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
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000004: function(arg0) {
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
        "./ui_blitz_bg.js": import0,
    };
}

const UiDocumentFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_uidocument_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getBigUint64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

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

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
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
    cachedBigUint64ArrayMemory0 = null;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

// Generated wrappers and finalizer above are unchanged. The host supplies the
// matching immutable packaged module and the instance's complete imports.
let initialization;
let initializationHost;
let terminalFailure;

export function initialize(host) {
  if (terminalFailure) return Promise.reject(terminalFailure);
  if (initializationHost && initializationHost !== host) {
    return Promise.reject(new Error('ui-wasm-host-mismatch: reuse the initialized realm host'));
  }
  if (initialization) return initialization;
  initializationHost = host;
  initialization = Promise.resolve().then(async () => {
    const bytes = await host.readWasm();
    const digest = Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== artifact.bytes || digest !== artifact.sha256) {
      throw new Error('ui-wasm-integrity: bytes do not match the generated binding');
    }
    const imports = __wbg_get_imports();
    const result = await host.instantiate(imports);
    try {
      __wbg_finalize_init(result.instance, result.module);
    } catch (cause) {
      terminalFailure = new Error('ui-wasm-start-failed: create a fresh realm', { cause });
      throw terminalFailure;
    }
  }).catch(cause => {
    if (!terminalFailure) {
      initializationHost = undefined;
      initialization = undefined;
    }
    throw cause;
  });
  return initialization;
}
