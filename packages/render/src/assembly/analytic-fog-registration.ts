import { ANALYTIC_FOG_POST_PROCESS_ID } from '../pipeline/analytic-fog-pass';
import type { RendererState } from '../render-system';
import { deferredPostProcessEntry } from './deferred-post-process-entry';

/** Screen fog owns its View/depth layout and prepares source only when selected. */
export function registerAnalyticFogPostProcess(
  renderSystem: Pick<RendererState, 'registerBuiltinPostProcess'>,
  source: string | (() => string),
  candidate: boolean,
): void {
  if (candidate) return;
  renderSystem.registerBuiltinPostProcess(
    ANALYTIC_FOG_POST_PROCESS_ID,
    deferredPostProcessEntry({}, () => (typeof source === 'string' ? source : source())),
  );
}
