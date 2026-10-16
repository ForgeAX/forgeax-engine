/* tslint:disable */
/* eslint-disable */

export class UiDocument {
    free(): void;
    [Symbol.dispose](): void;
    attach_shadow(id: bigint): bigint;
    attribute(id: bigint, attr: string): string | undefined;
    attribute_names(id: bigint): string[];
    can_focus(id: bigint): boolean;
    children(id: bigint): BigUint64Array;
    clone_node(id: bigint, deep: boolean): bigint;
    /**
     * Collect only detached subtrees with no reachable JS node wrappers. A
     * retained descendant also retains its parents and siblings, as in DOM.
     */
    collect_detached(retained: BigUint64Array): number;
    computed_style(id: bigint, property: string): string;
    create_element(tag: string): bigint;
    create_fragment(): bigint;
    create_text(text: string): bigint;
    document_element(): bigint;
    focus(id: bigint, by_pointer: boolean): void;
    focused(): bigint;
    form_owner(id: bigint): bigint;
    hit(x: number, y: number): bigint;
    inner_html(id: bigint): string;
    input_bad_input(id: bigint): boolean;
    input_checked(id: bigint): boolean;
    input_step(id: bigint, count: number): void;
    input_text(id: bigint): string;
    input_value(id: bigint): string;
    insert(parent: bigint, child: bigint, before: bigint): void;
    keyboard_focus(): void;
    matches(id: bigint, selector: string): boolean;
    constructor(html: string, width: number, height: number, scale: number, font: Uint8Array);
    node_type(id: bigint): number;
    /**
     * User number stepping accepts step=any as a unit increment, as native browsers do.
     */
    number_step(id: bigint, count: number): void;
    /**
     * Number button hit-testing reuses the native transformed/clipped hit path.
     */
    number_stepper_hit(id: bigint, x: number, y: number): number;
    option_selected(id: bigint): boolean;
    /**
     * Empty means unchanged. Otherwise wasm-bindgen copies the complete RGBA
     * buffer into JS-owned bytes; no Rust pointer survives across modules.
     */
    paint(): Uint8Array;
    /**
     * Owns only CPU preparation bytes. The Renderer owns device, textures and submission.
     */
    paint_gpu(): any;
    parent(id: bigint): bigint;
    query(scope: bigint, selector: string): BigUint64Array;
    radio_group(id: bigint): BigUint64Array;
    range_key(id: bigint, key: string): void;
    /**
     * Pointer defaults and painting use the same native value and thumb geometry.
     */
    range_pointer(id: bigint, x: number, y: number): void;
    rect(id: bigint): Float64Array;
    remove(id: bigint): void;
    reset_form(id: bigint): void;
    /**
     * Alternating URL/message pairs, drained after each transport batch.
     */
    resource_errors(): string[];
    resource_failed(id: number, message: string): void;
    resource_requests(): Uint32Array;
    resource_response(id: number, bytes: Uint8Array): void;
    resource_url(id: number): string;
    root(): bigint;
    /**
     * CSS/wheel deltas are positive towards larger scroll offsets. Return the
     * actual core scrollers, so JS dispatches events after releasing the borrow.
     */
    scroll_by_user(id: bigint, x: number, y: number): BigUint64Array;
    scroll_into_view(id: bigint, block: string, inline: string): BigUint64Array;
    scroll_metrics(id: bigint): Float64Array;
    scroll_to(id: bigint, x: number, y: number): void;
    select_close(id: bigint): void;
    select_index(id: bigint): number;
    select_input_text(id: bigint): boolean;
    select_key(id: bigint, key: string): boolean;
    select_options(id: bigint): BigUint64Array;
    select_pointer(id: bigint, x: number, y: number, commit: boolean): boolean;
    sequential_focus_target(reverse: boolean): bigint;
    set_active(id: bigint): void;
    set_attribute(id: bigint, attr: string, value?: string | null): void;
    set_hover(id: bigint): void;
    set_inner_html(id: bigint, html: string): void;
    set_input_checked(id: bigint, checked: boolean): void;
    set_input_text(id: bigint, value: string): boolean;
    set_input_value(id: bigint, value: string): void;
    set_option_selected(id: bigint, selected: boolean): void;
    set_reduced_motion(reduce: boolean): void;
    set_select_index(id: bigint, index: number): void;
    set_style(id: bigint, property: string, value: string, priority: string): void;
    set_text_content(id: bigint, text: string): void;
    set_time(time_ms: number): void;
    set_viewport(width: number, height: number, scale: number): void;
    shadow_host(id: bigint): bigint;
    shadow_root(id: bigint): bigint;
    show_validation_message(id: bigint, message: string): void;
    style_value(id: bigint, property: string): string;
    tag_name(id: bigint): string;
    template_content(id: bigint): bigint;
    text_content(id: bigint): string;
    /**
     * Snapshot direct-manipulation pan permissions at pointerdown. Bit 0 is X,
     * bit 1 is Y. Wheel/programmatic scrolling has independent semantics.
     */
    touch_pan_axes(id: bigint): number;
    static with_resources(html: string, width: number, height: number, scale: number, font: Uint8Array, font_family?: string | null, base_url?: string | null): UiDocument;
}

export declare function initialize(host: import("../src/wasm-host.js").UiWasmHost): Promise<void>;
