import { RhiError } from '@forgeax/engine-rhi';
import type { SsrHistoryResetReason } from '../ssr/history';
import type { TemporalFrameStage } from '../temporal/frame-coordinator';
import type { TemporalView } from '../temporal/view';
import type { RenderSystemInternals } from './render-context';

function ssrRuntimeError(
  cause: unknown,
): RhiError | { code: string; message: string; name?: string } {
  if (cause instanceof RhiError) return cause;
  if (cause instanceof Error)
    return { code: 'ssr-history-failure', message: cause.message, name: cause.name };
  return { code: 'ssr-history-failure', message: String(cause) };
}

export function reportSsrHistoryFailure(
  internals: RenderSystemInternals,
  stage: TemporalFrameStage,
  cause: unknown,
): void {
  internals.errorRegistry.fire(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: `SSR history ${stage} succeeds before queue submission`,
      hint: 'inspect the SSR history owner failure and retry the next frame',
      detail: { error: ssrRuntimeError(cause) },
    }),
  );
}

export function mapSsrHistoryResetReason(
  reason: TemporalView['resetReason'],
): SsrHistoryResetReason | undefined {
  switch (reason) {
    case 'first-frame':
      return 'first-enable';
    case 'resize':
      return 'resize';
    case 'camera-cut':
    case 'view-switch':
      return 'camera-cut';
    case 'history-version':
      return 'history-version';
    case 'environment-change':
    case 'fog-change':
      return 'reflection-generation';
    case 'time-discontinuity':
      return 'camera-cut';
    case 'device-recover':
      return 'device-recovery';
    case 'submit-failure':
    case undefined:
      return undefined;
  }
}
