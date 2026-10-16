import type { Renderer } from '@forgeax/engine-render';
import { createRendererInspectionError, type RendererInspectionFailureReason } from '../errors';
import type { ExecutionRendererInspectionResult } from './types';
import { serializableDetail } from './worker-error';

export function rendererInspectionFailure(
  reason: RendererInspectionFailureReason,
  cause?: unknown,
): ExecutionRendererInspectionResult {
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

/** Read-only snapshot. Clone failure is explicit; no field is filtered or synthesized. */
export function readRendererInspection(
  renderer: Renderer | undefined,
  signal?: AbortSignal,
): ExecutionRendererInspectionResult {
  if (signal?.aborted) return rendererInspectionFailure('cancelled');
  try {
    if (renderer === undefined || renderer.state() !== 'alive')
      return rendererInspectionFailure('not-ready');
    return { ok: true, value: structuredClone(renderer.inspect()) };
  } catch (cause) {
    return rendererInspectionFailure('inspection', cause);
  }
}
