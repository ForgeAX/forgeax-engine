import programSource from './vase.program.mjs?raw';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { PackageId } from '@forgeax/engine/pack/guid';
import { definePackageId } from '@forgeax/engine/pack/source';

export const VASE_GENERATOR = definePackageId('019fb7ce-3e00-7000-8000-000000000001');
export const VASE_INSTANCE = definePackageId('019fb7ce-3e00-7000-8000-000000000002');
export const VASE_PLUGIN = definePackageId('019fb7ce-3e00-7000-8000-000000000000');
export const VASE_CHANNEL = 'game-3d/runtime-vase';
export const VASE_PARAMETERS = [
  { name: 'height', type: 'f32', default: 2.4, minimum: 1, maximum: 4 },
  { name: 'radius', type: 'f32', default: 0.75, minimum: 0.4, maximum: 1.3 },
  { name: 'sides', type: 'u32', default: 32, minimum: 8, maximum: 64 },
] as const;
export type VaseValues = Record<(typeof VASE_PARAMETERS)[number]['name'], number>;
export const VASE_DEFAULTS = Object.fromEntries(
  VASE_PARAMETERS.map((parameter) => [parameter.name, parameter.default]),
) as VaseValues;
export interface VaseState {
  readonly busy: boolean;
  readonly guid: string;
  readonly values: VaseValues;
  readonly generation?: number;
  readonly entity?: EntityHandle;
  readonly vertexCount?: number;
  readonly aabb?: number[];
  readonly error?: string;
}

/** Native JS is admitted and executed only after the game starts. No variant is cooked. */
export function vaseContent(imports: Readonly<Record<string, string>>, material: string, digest: string) {
  return {
    source: {
      schemaVersion: '2.0.0' as const,
      kind: 'scriptable-pack-source' as const,
      source: 'Runtime vase.js',
      packageId: PackageId.format(VASE_GENERATOR),
      program: 'game-3d/vase',
      runtime: { dependencies: [material] },
      parameters: [...VASE_PARAMETERS, { name: 'material', type: 'string' as const, default: material }],
    },
    dependencies: { [material]: digest },
    programs: {
      'game-3d/vase': {
        artifact: preparePackProgram({
          entry: 'vase.program.mjs',
          export: 'build',
          imports: Object.fromEntries(
            ['@forgeax/engine/geometry', '@forgeax/engine/pack/source'].map((name) => [name, imports[name]]),
          ),
          modules: {
            'vase.program.mjs': programSource,
          },
        }).unwrap(),
      },
    },
  };
}
