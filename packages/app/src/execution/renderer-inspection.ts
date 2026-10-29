import type { Renderer, RenderInspection } from '@forgeax/engine-render';
import { createRendererInspectionError, type RendererInspectionFailureReason } from '../errors';
import type {
  ExecutionRendererInspectionOptions,
  ExecutionRendererInspectionResult,
} from './types';
import { serializableDetail } from './worker-error';

export function rendererInspectionFailure(
  reason: RendererInspectionFailureReason,
  cause?: unknown,
): Extract<ExecutionRendererInspectionResult, { readonly ok: false }> {
  let preservedCause: unknown;
  try {
    preservedCause = serializableDetail(cause);
  } catch {
    preservedCause = { serializationFailed: true };
  }
  const error = createRendererInspectionError(reason, preservedCause);
  return {
    ok: false,
    error: { code: error.code, expected: error.expected, hint: error.hint, detail: error.detail },
  };
}

/** Select at the owner before cloning; unselected inventories never cross realms. */
export function readRendererInspection<K extends keyof RenderInspection = keyof RenderInspection>(
  renderer: Renderer | undefined,
  signal?: AbortSignal,
  options?: ExecutionRendererInspectionOptions<K>,
): ExecutionRendererInspectionResult<Pick<RenderInspection, K>> {
  if (signal?.aborted) return rendererInspectionFailure('cancelled');
  try {
    if (renderer === undefined || renderer.state() !== 'alive')
      return rendererInspectionFailure('not-ready');
    const snapshot = renderer.inspect(options);
    const selected =
      options?.fields === undefined
        ? snapshot
        : Object.fromEntries(options.fields.map((field) => [field, snapshot[field]]));
    return { ok: true, value: structuredClone(selected) as Pick<RenderInspection, K> };
  } catch (cause) {
    return rendererInspectionFailure('inspection', cause);
  }
}
