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

export interface ToolPreviewRecipeOptions extends Partial<Omit<ToolPreviewRecipe, 'backend'>> {
  readonly backend?: string;
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
  readonly presentation: ToolPreviewPresentation;
}

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
