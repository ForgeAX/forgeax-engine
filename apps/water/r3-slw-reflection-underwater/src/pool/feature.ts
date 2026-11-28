import { type AssetRegistry, selectMaterialPassProgram } from '@forgeax/engine/assets-runtime';
import type { RenderFeature, RenderFeatureWork } from '@forgeax/engine/render';
import { type AssetHandle, ok } from '@forgeax/engine/types';
import {
  WATER_CAUSTICS_ADDITIVE_BLEND,
  type WaterCausticsField,
  waterCausticsFieldPass,
  waterCausticsFieldResource,
} from '@forgeax/engine/water/caustics';
import { POOL_FIELD, POOL_FIELD_SIZE, POOL_GRID } from './identity';

interface PoolPrograms {
  field: string;
  scene: string;
}

/** Cooked MaterialAssets supply programs; the Engine owns every GPU resource and submission. */
export function createPoolFeature() {
  let input:
    | { assets: AssetRegistry; field: AssetHandle<'material'>; scene: AssetHandle<'material'> }
    | undefined;
  const fieldDescription: WaterCausticsField = {
    name: POOL_FIELD,
    resolution: POOL_FIELD_SIZE,
    sourceGrid: POOL_GRID,
    encoding: 'relative-irradiance',
  };
  let submissions = 0;
  const feature: RenderFeature<PoolPrograms | undefined> = {
    identity: 'water-pool',
    placement: 'after-tonemap',
    extract(context) {
      if (input === undefined || context.materialContext === undefined) return ok(undefined);
      const field = input.assets.getMaterialProjection(input.field).unwrap();
      const scene = input.assets.getMaterialProjection(input.scene).unwrap();
      if (field === undefined || scene === undefined) return ok(undefined);
      return ok({
        field: selectMaterialPassProgram(field, 'Forward', context.materialContext)
          .specializationKey,
        scene: selectMaterialPassProgram(scene, 'Forward', context.materialContext)
          .specializationKey,
      });
    },
    assetDependencies: () =>
      input === undefined ? [] : [Number(input.field), Number(input.scene)],
    plan(frame, context) {
      if (frame === undefined || input === undefined) return ok({ work: [] });
      const configured = input;
      const work: RenderFeatureWork[] = [];
      for (const view of context.views) {
        const color = view.targets.find((target) => target.kind === 'color');
        if (!view.render || color === undefined || color.sampleCount !== 1) continue;
        work.push({
          scope: { view: view.identity },
          resources: [
            {
              kind: 'buffer',
              name: 'pass-inputs',
              size: 16,
              usage: ['uniform'],
              data: new Float32Array([1, 0, 0, 0]),
            },
            waterCausticsFieldResource(fieldDescription),
            ...(['field', 'scene'] as const).flatMap((name) => [
              {
                kind: 'graphics-bindings' as const,
                name: `${name}.view`,
                program: `${name}.program`,
                values:
                  name === 'field'
                    ? { group: 0, view: true }
                    : {
                        group: 0,
                        postProcess: true,
                        sceneColor: POOL_FIELD,
                        sceneDepth: 'depth',
                        passInputBuffer: 'pass-inputs',
                        uniformBuffers: ['pass-inputs'],
                      },
                ...(name === 'scene'
                  ? { logicalTargets: { sceneColor: POOL_FIELD, sceneDepth: 'depth' } }
                  : {}),
              },
              {
                kind: 'graphics-program' as const,
                name: `${name}.program`,
                program: {
                  shader: frame[name],
                  vertexLayout: 'none',
                  colorFormats: [name === 'field' ? ('rgba16float' as const) : color.format],
                  preparePipelines: true,
                  renderState: {
                    cullMode: 'none' as const,
                    depthWriteEnabled: false,
                    ...(name === 'field'
                      ? {
                          blend: WATER_CAUSTICS_ADDITIVE_BLEND,
                        }
                      : {}),
                  },
                },
              },
              {
                kind: 'graphics-bindings' as const,
                name: `${name}.material`,
                program: `${name}.program`,
                values: { group: 1, material: { world: 0, handle: Number(configured[name]) } },
              },
            ]),
          ],
          passes: [
            waterCausticsFieldPass({
              field: fieldDescription,
              name: 'pool-caustics',
              program: 'field.program',
              bindings: ['field.view', 'field.material'],
            }),
            {
              kind: 'raster',
              name: 'pool-optical-scene',
              sceneDepth: 'before-pass',
              sampledTargets: [POOL_FIELD, 'depth'],
              colorAttachments: [{ target: color.name, loadOp: 'clear', storeOp: 'store' }],
              draws: [
                {
                  program: 'scene.program',
                  bindings: ['scene.view', 'scene.material'],
                  vertexLayout: 'none',
                  vertexData: [],
                  draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                },
              ],
            },
          ],
        });
      }
      return ok({ work });
    },
    onFrameSubmitted(frame) {
      if (frame !== undefined) submissions++;
    },
  };
  return {
    feature,
    configure(value: NonNullable<typeof input>) {
      input = value;
    },
    readState: () => ({
      submissions,
      field: POOL_FIELD,
      fieldSize: POOL_FIELD_SIZE,
      sourceGrid: POOL_GRID,
    }),
  };
}
