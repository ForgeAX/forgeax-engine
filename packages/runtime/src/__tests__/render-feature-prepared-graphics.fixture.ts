import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type {
  RenderFeature,
  RenderFeatureWork,
  RenderFrameInput,
  RenderWorldLease,
} from '@forgeax/engine-render';
import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';

export type PreparedFeatureMode =
  | 'accepted'
  | 'empty'
  | 'mismatch'
  | 'recovery'
  | 'missing-material';

export function preparedFeature(
  identity: string,
  mode: PreparedFeatureMode = 'accepted',
): RenderFeature<{ readonly draw: boolean }> {
  let firstPlan = true;

  return {
    identity,
    extract: () => ok({ draw: mode !== 'empty' }),
    plan: (data, context) => {
      if (!data.draw) return ok({ work: [] });
      const mismatch = mode === 'mismatch' || (mode === 'recovery' && firstPlan);
      firstPlan = false;
      const work = context.views
        .filter((view) => view.render)
        .map((view): RenderFeatureWork => {
          const target = view.targets.find((candidate) => candidate.kind === 'color');
          const targetName = target?.name ?? 'swapchain';
          return {
            scope: { view: view.identity },
            resources: [
              {
                kind: 'graphics-program',
                name: 'forward-program',
                program: {
                  shader:
                    mode === 'missing-material'
                      ? 'test::missing-particle-material'
                      : 'forgeax::tonemap',
                  vertexLayout:
                    mode === 'missing-material' ? 'billboard-material-instance' : 'position',
                  colorFormats: [target?.format ?? 'rgba16float'],
                },
              },
              {
                kind: 'graphics-bindings',
                name: 'forward-bindings',
                program: 'forward-program',
                values: {},
              },
              {
                kind: 'graphics-bindings',
                name: 'input-bindings',
                program: 'forward-program',
                values: { group: 1 },
              },
              {
                kind: 'vertex-data',
                name: 'triangle-vertices',
                layout: 'position',
                data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
              },
            ],
            passes: [
              {
                kind: 'raster',
                name: 'forward',
                colorAttachments: [{ target: targetName, loadOp: 'load', storeOp: 'store' }],
                draws: [
                  {
                    program: mismatch ? 'forged-program' : 'forward-program',
                    bindings: ['forward-bindings', 'input-bindings'],
                    vertexData: [{ slot: 0, resource: 'triangle-vertices' }],
                    draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                  },
                ],
              },
            ],
          };
        });
      return ok({ work });
    },
  };
}

export function preparedWorld(assets?: AssetRegistry): World {
  const world = new World(assets === undefined ? {} : { assets });
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
  );
  return world;
}

export function frameRequest(lease: RenderWorldLease): RenderFrameInput {
  return { source: lease };
}
