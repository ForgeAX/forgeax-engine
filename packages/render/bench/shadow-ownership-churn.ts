import { mat4 } from '@forgeax/engine-math';
import { ShadowCasterOwnershipProjection } from '../src/gpu-driven/shadow-ownership';
import type { DispatchEntry, RenderableSnapshot } from '../src/render-system-extract';

export const modes = ['stable', 'one-dirty', 'tail-churn', 'front-churn', 'all-dirty'] as const;

/** Pure CPU owner diagnostic; inputs are prepared before timing, with no GPU claims. */
export function createCase(mode: (typeof modes)[number], count = 775) {
  const caster = (entityKey: number, materialHandle = 20): RenderableSnapshot => ({
    worldId: 0,
    entityKey,
    assetHandle: 1,
    transform: { world: mat4.identity(mat4.create()) },
    material: {} as never,
    materials: [],
    materialBindingSources: [],
    shadowCasterPasses: [
      { drawItemIndex: 0, materialHandle, passIndex: 1, gpuDrivenEligible: true },
      { drawItemIndex: 1, materialHandle, passIndex: 1, gpuDrivenEligible: true },
    ],
  });
  const first = Array.from({ length: count }, (_, index) => caster(index + 1));
  const second = first.slice();
  if (mode === 'one-dirty') second[Math.floor(count / 2)] = caster(Math.floor(count / 2) + 1, 21);
  if (mode === 'tail-churn') second.push(caster(count + 1));
  if (mode === 'front-churn') second.shift();
  if (mode === 'all-dirty')
    for (let index = 0; index < count; index++) second[index] = caster(index + 1, 21);
  const dispatch = (rows: readonly RenderableSnapshot[]) => rows.map((_, renderableIndex) => ({
    renderableIndex,
    tags: { LightMode: 'ShadowCaster' },
  } as DispatchEntry));
  const frames = [
    { renderables: first, dispatch: dispatch(first) },
    { renderables: second, dispatch: dispatch(second) },
  ];
  const owner = new ShadowCasterOwnershipProjection();
  owner.project(first, frames[0]?.dispatch ?? []);
  let step = 0;
  return {
    run(iterations: number) {
      let result;
      for (let index = 0; index < iterations; index++) {
        step = 1 - step;
        const frame = frames[step];
        if (frame === undefined) throw Error('Missing benchmark frame');
        result = owner.project(frame.renderables, frame.dispatch);
      }
      return result;
    },
    inspect: () => ({ builds: owner.buildCount(), rowBuilds: typeof Reflect.get(owner, 'rowBuildCount') === 'function' ? owner.rowBuildCount() : undefined }),
  };
}
