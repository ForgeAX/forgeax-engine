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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_uidocument_free: (a: number, b: number) => void;
    readonly uidocument_attach_shadow: (a: number, b: bigint) => [bigint, number, number];
    readonly uidocument_attribute: (a: number, b: bigint, c: number, d: number) => [number, number, number, number];
    readonly uidocument_attribute_names: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_can_focus: (a: number, b: bigint) => [number, number, number];
    readonly uidocument_children: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_clone_node: (a: number, b: bigint, c: number) => [bigint, number, number];
    readonly uidocument_collect_detached: (a: number, b: number, c: number) => [number, number, number];
    readonly uidocument_computed_style: (a: number, b: bigint, c: number, d: number) => [number, number, number, number];
    readonly uidocument_create_element: (a: number, b: number, c: number) => [bigint, number, number];
    readonly uidocument_create_fragment: (a: number) => bigint;
    readonly uidocument_create_text: (a: number, b: number, c: number) => bigint;
    readonly uidocument_document_element: (a: number) => bigint;
    readonly uidocument_focus: (a: number, b: bigint, c: number) => [number, number];
    readonly uidocument_focused: (a: number) => bigint;
    readonly uidocument_form_owner: (a: number, b: bigint) => [bigint, number, number];
    readonly uidocument_hit: (a: number, b: number, c: number) => [bigint, number, number];
    readonly uidocument_inner_html: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_input_bad_input: (a: number, b: bigint) => [number, number, number];
    readonly uidocument_input_checked: (a: number, b: bigint) => [number, number, number];
    readonly uidocument_input_step: (a: number, b: bigint, c: number) => [number, number];
    readonly uidocument_input_text: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_input_value: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_insert: (a: number, b: bigint, c: bigint, d: bigint) => [number, number];
    readonly uidocument_keyboard_focus: (a: number) => void;
    readonly uidocument_matches: (a: number, b: bigint, c: number, d: number) => [number, number, number];
    readonly uidocument_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly uidocument_node_type: (a: number, b: bigint) => [number, number, number];
    readonly uidocument_number_step: (a: number, b: bigint, c: number) => [number, number];
    readonly uidocument_number_stepper_hit: (a: number, b: bigint, c: number, d: number) => [number, number, number];
    readonly uidocument_option_selected: (a: number, b: bigint) => [number, number, number];
    readonly uidocument_paint: (a: number) => [number, number, number, number];
    readonly uidocument_paint_gpu: (a: number) => [number, number, number];
    readonly uidocument_parent: (a: number, b: bigint) => [bigint, number, number];
    readonly uidocument_query: (a: number, b: bigint, c: number, d: number) => [number, number, number, number];
    readonly uidocument_radio_group: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_range_key: (a: number, b: bigint, c: number, d: number) => [number, number];
    readonly uidocument_range_pointer: (a: number, b: bigint, c: number, d: number) => [number, number];
    readonly uidocument_rect: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_remove: (a: number, b: bigint) => [number, number];
    readonly uidocument_reset_form: (a: number, b: bigint) => [number, number];
    readonly uidocument_resource_errors: (a: number) => [number, number];
    readonly uidocument_resource_failed: (a: number, b: number, c: number, d: number) => [number, number];
    readonly uidocument_resource_requests: (a: number) => [number, number];
    readonly uidocument_resource_response: (a: number, b: number, c: number, d: number) => [number, number];
    readonly uidocument_resource_url: (a: number, b: number) => [number, number, number, number];
    readonly uidocument_root: (a: number) => bigint;
    readonly uidocument_scroll_by_user: (a: number, b: bigint, c: number, d: number) => [number, number, number, number];
    readonly uidocument_scroll_into_view: (a: number, b: bigint, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly uidocument_scroll_metrics: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_scroll_to: (a: number, b: bigint, c: number, d: number) => [number, number];
    readonly uidocument_select_close: (a: number, b: bigint) => [number, number];
    readonly uidocument_select_index: (a: number, b: bigint) => [number, number, number];
    readonly uidocument_select_input_text: (a: number, b: bigint) => [number, number, number];
    readonly uidocument_select_key: (a: number, b: bigint, c: number, d: number) => [number, number, number];
    readonly uidocument_select_options: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_select_pointer: (a: number, b: bigint, c: number, d: number, e: number) => [number, number, number];
    readonly uidocument_sequential_focus_target: (a: number, b: number) => bigint;
    readonly uidocument_set_active: (a: number, b: bigint) => [number, number];
    readonly uidocument_set_attribute: (a: number, b: bigint, c: number, d: number, e: number, f: number) => [number, number];
    readonly uidocument_set_hover: (a: number, b: bigint) => [number, number];
    readonly uidocument_set_inner_html: (a: number, b: bigint, c: number, d: number) => [number, number];
    readonly uidocument_set_input_checked: (a: number, b: bigint, c: number) => [number, number];
    readonly uidocument_set_input_text: (a: number, b: bigint, c: number, d: number) => [number, number, number];
    readonly uidocument_set_input_value: (a: number, b: bigint, c: number, d: number) => [number, number];
    readonly uidocument_set_option_selected: (a: number, b: bigint, c: number) => [number, number];
    readonly uidocument_set_reduced_motion: (a: number, b: number) => void;
    readonly uidocument_set_select_index: (a: number, b: bigint, c: number) => [number, number];
    readonly uidocument_set_style: (a: number, b: bigint, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly uidocument_set_text_content: (a: number, b: bigint, c: number, d: number) => [number, number];
    readonly uidocument_set_time: (a: number, b: number) => [number, number];
    readonly uidocument_set_viewport: (a: number, b: number, c: number, d: number) => [number, number];
    readonly uidocument_shadow_host: (a: number, b: bigint) => [bigint, number, number];
    readonly uidocument_shadow_root: (a: number, b: bigint) => [bigint, number, number];
    readonly uidocument_show_validation_message: (a: number, b: bigint, c: number, d: number) => [number, number];
    readonly uidocument_style_value: (a: number, b: bigint, c: number, d: number) => [number, number, number, number];
    readonly uidocument_tag_name: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_template_content: (a: number, b: bigint) => [bigint, number, number];
    readonly uidocument_text_content: (a: number, b: bigint) => [number, number, number, number];
    readonly uidocument_touch_pan_axes: (a: number, b: bigint) => [number, number, number];
    readonly uidocument_with_resources: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly Servo_NumericType_MatchesAngle: (a: number) => number;
    readonly Servo_NumericType_MatchesLength: (a: number) => number;
    readonly Servo_NumericType_MatchesLengthPercentage: (a: number) => number;
    readonly Servo_NumericType_MatchesNumber: (a: number) => number;
    readonly Servo_NumericType_MatchesPercentage: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
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
