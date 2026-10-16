import { ANALYTIC_FOG_POST_PROCESS_ID } from '../pipeline/analytic-fog-pass';
import type { RenderSystem } from '../render-system';

/** The fog pass owns its View + depth layout; the registry only carries the prewarmed source. */
export function registerAnalyticFogPostProcess(
  renderSystem: Pick<RenderSystem, 'registerBuiltinPostProcess'>,
  source: string,
  candidate: boolean,
): void {
  if (candidate) return;
  renderSystem.registerBuiltinPostProcess(ANALYTIC_FOG_POST_PROCESS_ID, { source });
}
