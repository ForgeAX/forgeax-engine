import type { RenderFeatureWork } from './plan';

type Pass = RenderFeatureWork['passes'][number];
type Raster = Extract<Pass, { kind: 'raster' }>;

/** The native producer permits raster batching; the Host has certified current
 * prepared pipeline state and actual readiness, including no stencil operations. A
 * read-only depth consumer needs no before-pass snapshot. Sampling demand may
 * therefore be unioned without changing any draw's depth observation. */
export function coalesceNativeReadOnlyDepthPasses(
  passes: readonly Pass[],
  readOnlyPrograms: ReadonlySet<string>,
): readonly Pass[] {
  if (readOnlyPrograms.size === 0 || passes.length < 2) return passes;
  const output: Pass[] = [];
  let pending: (Raster & { draws: Raster['draws'][number][] }) | undefined;
  const eligible = (pass: Pass): pass is Raster => {
    if (pass.kind !== 'raster') return false;
    const depth = pass.depthStencilAttachment;
    return (
      depth !== undefined &&
      depth.depthLoadOp === 'load' &&
      depth.depthStoreOp === 'store' &&
      (pass.sceneDepth === undefined ||
        pass.sceneDepth === 'before-pass' ||
        pass.sceneDepth === 'read-only') &&
      pass.colorAttachments.every((a) => a.loadOp === 'load' && a.storeOp === 'store') &&
      (pass.sampledTargets ?? []).every((target) => target === depth.target) &&
      pass.draws.every((draw) => readOnlyPrograms.has(draw.program))
    );
  };
  const compatible = (left: Raster, right: Raster): boolean =>
    left.depthStencilAttachment?.target === right.depthStencilAttachment?.target &&
    left.colorAttachments.length === right.colorAttachments.length &&
    left.colorAttachments.every((a, i) => a.target === right.colorAttachments[i]?.target);
  for (const pass of passes) {
    if (!eligible(pass)) {
      output.push(pass);
      pending = undefined;
      continue;
    }
    const draws = pass.draws.map((draw) =>
      pass.enabled === false ? { ...draw, enabled: false } : draw,
    );
    if (pending === undefined || !compatible(pending, pass)) {
      pending = { ...pass, draws };
      output.push(pending);
      continue;
    }
    pending.draws.push(...draws);
    const merged: Raster & { draws: Raster['draws'][number][] } = {
      ...pending,
      enabled: pending.enabled !== false || pass.enabled !== false,
      draws: pending.draws,
      ...((pending.sampledTargets?.length ?? 0) > 0 || (pass.sampledTargets?.length ?? 0) > 0
        ? {
            sceneDepth:
              pending.sceneDepth === 'before-pass' || pass.sceneDepth === 'before-pass'
                ? 'before-pass'
                : 'read-only',
          }
        : {}),
      ...((pending.sampledTargets?.length ?? 0) > 0 || (pass.sampledTargets?.length ?? 0) > 0
        ? { sampledTargets: [pass.depthStencilAttachment?.target as string] }
        : {}),
    };
    output[output.length - 1] = merged;
    pending = merged;
  }
  return output;
}
