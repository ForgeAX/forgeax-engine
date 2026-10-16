import { isSerializableValue, type JsonValue } from '@forgeax/engine-tool-runtime';

export type ToolPreviewPresentation = 'hidden' | 'visible';

export interface ToolPreviewAction {
  readonly frame: number;
  readonly name: string;
  readonly value?: JsonValue;
}

export interface ToolPreviewRecipe {
  readonly backend: 'webgpu';
  readonly presentation: ToolPreviewPresentation;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly actions: readonly ToolPreviewAction[];
  readonly deltaSeconds: number;
  readonly frames: number;
}

export interface ToolPreviewRecipeOptions {
  readonly backend?: 'webgpu' | 'rhi-null' | string;
  readonly presentation?: ToolPreviewPresentation;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly actions?: readonly ToolPreviewAction[];
  readonly deltaSeconds?: number;
  readonly frames?: number;
}

export type ToolPreviewTraceEvent =
  | 'canvas-created'
  | 'rhi-debug-armed'
  | 'renderer-created'
  | 'world-updated'
  | 'draw-submitted'
  | 'validation-complete';

export interface ToolPreviewTrace {
  readonly events: readonly ToolPreviewTraceEvent[];
  readonly backend: 'webgpu' | string;
  readonly adapter: string;
  readonly presentation: ToolPreviewPresentation;
}

export type ToolPreviewTraceValidation =
  | { readonly ok: true; readonly value: ToolPreviewTrace }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'tool-preview-invalid-trace';
        readonly expected: string;
        readonly hint: string;
        readonly detail: { readonly missing: string; readonly index: number };
      };
    };

export function createToolPreviewRecipe(options: ToolPreviewRecipeOptions): ToolPreviewRecipe {
  if (options.backend !== undefined && options.backend !== 'webgpu') {
    throw new TypeError('tool preview requires the real WebGPU backend');
  }
  const viewport = options.viewport ?? { width: 640, height: 360 };
  if (
    !Number.isSafeInteger(viewport.width) ||
    !Number.isSafeInteger(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw new TypeError('tool preview viewport must contain positive safe integers');
  }
  const deltaSeconds = options.deltaSeconds ?? 1 / 60;
  const frames = options.frames ?? 1;
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
    throw new TypeError('tool preview deltaSeconds must be finite and non-negative');
  }
  if (!Number.isSafeInteger(frames) || frames <= 0) {
    throw new TypeError('tool preview frames must be a positive safe integer');
  }
  const actions = (options.actions ?? []).map((action) => ({ ...action }));
  for (const action of actions) {
    if (
      !Number.isSafeInteger(action.frame) ||
      action.frame < 0 ||
      action.frame >= frames ||
      action.name.length === 0 ||
      (action.value !== undefined && !isSerializableValue(action.value))
    ) {
      throw new TypeError('tool preview actions require a valid frame, name, and JSON value');
    }
  }
  return {
    backend: 'webgpu',
    presentation: options.presentation ?? 'hidden',
    viewport: { width: viewport.width, height: viewport.height },
    actions,
    deltaSeconds,
    frames,
  };
}

const REQUIRED_EVENTS: readonly ToolPreviewTraceEvent[] = [
  'canvas-created',
  'rhi-debug-armed',
  'renderer-created',
  'world-updated',
  'draw-submitted',
  'validation-complete',
];

export function validateToolPreviewTrace(trace: ToolPreviewTrace): ToolPreviewTraceValidation {
  if (trace.backend !== 'webgpu') {
    return {
      ok: false,
      error: {
        code: 'tool-preview-invalid-trace',
        expected: 'trace.backend === "webgpu"',
        hint: 'run the same recipe with a real WebGPU adapter; RHI-null is not a preview backend',
        detail: { missing: 'webgpu-backend', index: -1 },
      },
    };
  }
  let last = -1;
  for (const event of REQUIRED_EVENTS) {
    const index = trace.events.indexOf(event);
    if (index <= last) {
      return {
        ok: false,
        error: {
          code: 'tool-preview-invalid-trace',
          expected: `event '${event}' occurs after the previous recipe phase`,
          hint: 'arm RHI-debug before Renderer construction and retain update/draw/validation evidence',
          detail: { missing: event, index },
        },
      };
    }
    last = index;
  }
  return { ok: true, value: trace };
}
