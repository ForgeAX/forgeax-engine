// selectors.ts — sole definition point for all data-forgeax-* anchor constants (AC-13).
//
// All string literals containing 'data-forgeax-' MUST appear ONLY in this file.
// Components, smoke scripts, and AI consumers import from here.
//
// Naming convention: data-forgeax-<noun> all lowercase hyphenated,
// continuing the window.__forgeax.captureFrame (PR1) pattern.
//
// Related: plan-strategy D-5 (selectors SSOT); AC-13 (grep verification); charter F1.

/** Load status values for the viewer container. */
export const LOAD_STATUS = Object.freeze(['parse-error', 'loaded', 'empty'] as const);
export type LoadStatus = (typeof LOAD_STATUS)[number];

/**
 * Identity function returning the given load status value.
 * Callers use this to validate and narrow `loadStatus` values at runtime.
 */
export function loadStatus(value: LoadStatus): LoadStatus {
  return value;
}

/** RT (render target) status values for the RT panel. */
export const RT_STATUS = Object.freeze(['ok', 'no-rt', 'no-webgpu', 'error'] as const);
export type RtStatus = (typeof RT_STATUS)[number];

/**
 * Identity function returning the given RT status value.
 * Callers use this to validate and narrow `rtStatus` values at runtime.
 */
export function rtStatus(value: RtStatus): RtStatus {
  return value;
}

/**
 * Attribute name for data-forgeax-draw. Value is the integer draw index.
 *
 * SSOT anchor key consumed by components and smoke scripts.
 * Callers write: `{...{ [drawAnchor()]: String(idx) }}`.
 * Smoke CSS selector: `[data-forgeax-draw="N"]`.
 */
export function drawAnchor(): string {
  return 'data-forgeax-draw';
}

/**
 * Attribute name for data-forgeax-pass. Value is the integer pass index.
 *
 * SSOT anchor key consumed by components and smoke scripts.
 * Callers write: `{...{ [passAnchor()]: String(passIdx) }}`.
 * Smoke CSS selector: `[data-forgeax-pass="N"]`.
 */
export function passAnchor(): string {
  return 'data-forgeax-pass';
}

/**
 * Attribute name for data-forgeax-selected. Value is always "true".
 *
 * SSOT anchor key consumed by TreePanel to mark the active draw row.
 * Callers write: `{...{ [selectedAnchor()]: 'true' }}`.
 * Smoke CSS selector: `[data-forgeax-selected="true"]`.
 */
export function selectedAnchor(): string {
  return 'data-forgeax-selected';
}

/**
 * Attribute name for data-forgeax-load-status. Value is a LoadStatus string.
 *
 * SSOT anchor key consumed by App.tsx and ErrorBanner.tsx.
 * Callers write: `{...{ [loadStatusAnchor()]: 'loaded' }}`.
 * Smoke CSS selector: `[data-forgeax-load-status="loaded"]`.
 */
export function loadStatusAnchor(): string {
  return 'data-forgeax-load-status';
}

/**
 * Attribute name for data-forgeax-rt-status. Value is an RtStatus string.
 *
 * SSOT anchor key consumed by DrawCallViewer (RT/depth preview status).
 * Callers write: `{...{ [rtStatusAnchor()]: status }}`.
 * Smoke CSS selector: `[data-forgeax-rt-status="ok"]`.
 */
export function rtStatusAnchor(): string {
  return 'data-forgeax-rt-status';
}

/**
 * Attribute name for data-forgeax-rt-canvas. Value is always empty string.
 *
 * SSOT anchor key consumed by DrawCallViewer to mark the RT/depth preview <canvas>.
 * Callers write: `{...{ [rtCanvasAnchor()]: '' }}`.
 * Smoke CSS selector: `canvas[data-forgeax-rt-canvas]`.
 */
export function rtCanvasAnchor(): string {
  return 'data-forgeax-rt-canvas';
}

/** Attribute name for the viewer-private shader preview canvas. */
export function previewCanvasAnchor(): string {
  return 'data-forgeax-preview-canvas';
}

/** Attribute name for the shell capability branch shown by the viewer. */
export function capabilityAnchor(): string {
  return 'data-forgeax-capability';
}

// ============================================================================
// Four-panel Viewer anchors (AC-13 SSOT: all data-forgeax-* only here)
// ============================================================================

/**
 * Attribute name for data-forgeax-event-browser. Value is 'draws-only' or 'all-commands'.
 *
 * SSOT anchor consumed by EventBrowser panel to mark its root container.
 * Smoke CSS selector: `[data-forgeax-event-browser]`.
 */
export function eventBrowserAnchor(): string {
  return 'data-forgeax-event-browser';
}

/**
 * Attribute name for data-forgeax-command-row. Value is the integer event index.
 *
 * SSOT anchor consumed by EventBrowser to mark individual command rows.
 * Callers write: `{...{ [commandRowAnchor()]: String(eventIdx) }}`.
 * Smoke CSS selector: `[data-forgeax-command-row="N"]`.
 */
export function commandRowAnchor(): string {
  return 'data-forgeax-command-row';
}

/**
 * Attribute name for data-forgeax-pipeline-state. Value is 'selected' or 'default'.
 *
 * SSOT anchor consumed by PipelineState panel to mark its container.
 * Smoke CSS selector: `[data-forgeax-pipeline-state]`.
 */
export function pipelineStateAnchor(): string {
  return 'data-forgeax-pipeline-state';
}

/**
 * Attribute name for data-forgeax-draw-call-viewer. Value is 'selected' or 'default'.
 *
 * SSOT anchor consumed by DrawCallViewer panel to mark its container.
 * Smoke CSS selector: `[data-forgeax-draw-call-viewer]`.
 */
export function drawCallViewerAnchor(): string {
  return 'data-forgeax-draw-call-viewer';
}

/**
 * Attribute name for data-forgeax-texture-thumbnail. Value is the integer thumbnail index.
 *
 * SSOT anchor consumed by DrawCallViewer to mark individual per-work texture entries.
 * Smoke CSS selector: `[data-forgeax-texture-thumbnail="N"]`.
 */
export function textureThumbnailAnchor(): string {
  return 'data-forgeax-texture-thumbnail';
}

/**
 * Attribute name for data-forgeax-texture-slice. Value is the integer slice index.
 *
 * SSOT anchor consumed by DrawCallViewer to mark the array/cube slice <select>
 * (shown only for cube / cube-array / 2d-array bound textures). The attribute
 * value tracks the currently selected slice.
 * Callers write: `{...{ [textureSliceAnchor()]: String(slice) }}`.
 * Smoke CSS selector: `[data-forgeax-texture-slice]`.
 */
export function textureSliceAnchor(): string {
  return 'data-forgeax-texture-slice';
}

/**
 * Attribute name for data-forgeax-texture-zoom. Value is the current zoom: the
 * percentage as an integer string (e.g. '100', '800'), or 'fit' for fit-to-window.
 *
 * SSOT anchor consumed by DrawCallViewer to mark the zoom toolbar's percentage
 * input (and surface the active zoom to smoke/e2e).
 * Callers write: `{...{ [textureZoomAnchor()]: zoom === 'fit' ? 'fit' : String(pct) }}`.
 * Smoke CSS selector: `[data-forgeax-texture-zoom]`.
 */
export function textureZoomAnchor(): string {
  return 'data-forgeax-texture-zoom';
}

/**
 * Attribute name for data-forgeax-texel-info. Marks the texel picker readout span
 * (coordinate + raw RGBA for color, or depth/stencil scalar) so smoke/e2e can
 * assert the hover value appears, persists across re-render, and is non-zero.
 * Smoke CSS selector: `[data-forgeax-texel-info]`.
 */
export function texelInfoAnchor(): string {
  return 'data-forgeax-texel-info';
}

/**
 * Attribute name for data-forgeax-resource-inspector. Value is 'loaded' or 'empty'.
 *
 * SSOT anchor consumed by ResourceInspector panel to mark its container.
 * Smoke CSS selector: `[data-forgeax-resource-inspector]`.
 */
export function resourceInspectorAnchor(): string {
  return 'data-forgeax-resource-inspector';
}

/**
 * Attribute name for data-forgeax-resource-row. Value is the resource handleId string.
 *
 * SSOT anchor consumed by ResourceInspector to mark individual resource rows.
 * Callers write: `{...{ [resourceRowAnchor()]: handleId }}`.
 * Smoke CSS selector: `[data-forgeax-resource-row="<handleId>"]`.
 */
export function resourceRowAnchor(): string {
  return 'data-forgeax-resource-row';
}

// ============================================================================
// M4: Instance Data section anchors (AC-12 SSOT: all data-forgeax-instance-*
// literals only here — grep gate enforced by PipelineState.test.tsx AC-12).
// ============================================================================

/**
 * Attribute name for data-forgeax-instance-data-section. Marks the `<table>`
 * that renders decoded group-3 binding-0 InstanceData rows in PipelineState.
 * Absent when the selected draw yields kind !== 'ok' (none / no-blob /
 * unexpected-stride / buffer-truncated).
 *
 * SSOT anchor consumed by PipelineState.InstanceDataSection.
 * Callers write: `<table {...{ [instanceDataSectionAnchor()]: '' }}>`.
 * Smoke CSS selector: `[data-forgeax-instance-data-section]`.
 */
export function instanceDataSectionAnchor(): string {
  return 'data-forgeax-instance-data-section';
}

/**
 * Attribute name for data-forgeax-instance-row. Value is the integer row index
 * (0 .. min(instanceCount, 256) - 1).
 *
 * SSOT anchor consumed by PipelineState.InstanceDataSection to mark each
 * decoded instance <tr>.
 * Callers write: `<tr {...{ [instanceRowAnchor()]: String(idx) }}>`.
 * Smoke CSS selector: `[data-forgeax-instance-row="N"]`.
 */
export function instanceRowAnchor(): string {
  return 'data-forgeax-instance-row';
}
