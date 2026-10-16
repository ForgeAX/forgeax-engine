import type { RenderFeatureWorkPlan } from '../../../render/src/features/plan.js';

type RasterPass = Extract<RenderFeatureWorkPlan['passes'][number], { kind: 'raster' }>;

/** Adjacent draws may share an encoder only when attachment and sampling state match. */
function compatible(left: RasterPass, right: RasterPass): boolean {
  if (left.sceneDepth !== right.sceneDepth || left.sceneDepth === 'before-pass') return false;
  if (left.colorAttachments.length !== right.colorAttachments.length) return false;
  for (const [index, a] of left.colorAttachments.entries()) {
    const b = right.colorAttachments[index];
    if (
      b === undefined ||
      a.target !== b.target ||
      a.loadOp !== 'load' ||
      b.loadOp !== 'load' ||
      a.storeOp !== 'store' ||
      b.storeOp !== 'store'
    )
      return false;
  }
  const a = left.depthStencilAttachment,
    b = right.depthStencilAttachment;
  if (a !== undefined || b !== undefined) {
    if (
      a === undefined ||
      b === undefined ||
      a.target !== b.target ||
      a.depthLoadOp !== 'load' ||
      b.depthLoadOp !== 'load' ||
      a.depthStoreOp !== 'store' ||
      b.depthStoreOp !== 'store'
    )
      return false;
  }
  const sampledA = left.sampledTargets,
    sampledB = right.sampledTargets;
  if (sampledA === sampledB) return true;
  if ((sampledA?.length ?? 0) !== (sampledB?.length ?? 0)) return false;
  for (let index = 0; index < (sampledA?.length ?? 0); index++)
    if (sampledA?.[index] !== sampledB?.[index]) return false;
  return true;
}

/** Keep authored draw order, phase boundaries and per-emitter visibility. */
export function coalesceVfxRasterPasses(
  passes: readonly RasterPass[],
  phase: 'opaque' | 'blended',
): readonly RasterPass[] {
  const result: RasterPass[] = [];
  let previous: RasterPass | undefined;
  let merged: (RasterPass & { enabled: boolean; draws: RasterPass['draws'][number][] }) | undefined;
  for (const pass of passes) {
    const enabled = pass.enabled !== false;
    if (merged === undefined || previous === undefined || !compatible(previous, pass)) {
      merged = { ...pass, name: `vfx.${phase}.${result.length}.raster`, enabled, draws: [] };
      result.push(merged);
    }
    merged.enabled ||= enabled;
    for (const draw of pass.draws) merged.draws.push(enabled ? draw : { ...draw, enabled: false });
    previous = pass;
  }
  return result;
}
