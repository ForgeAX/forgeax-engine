import { PackageId } from '@forgeax/engine/pack/guid';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { definePackageId } from '@forgeax/engine/pack/source';
import type { VaseValues } from '../shared/vase-protocol.ts';
import programSource from './vase.program.mjs?raw';

export const VASE_GENERATOR = definePackageId('019fb7ce-3e00-7000-8000-000000000001');
export const VASE_INSTANCE = definePackageId('019fb7ce-3e00-7000-8000-000000000002');
export const VASE_PLUGIN = definePackageId('019fb7ce-3e00-7000-8000-000000000000');
export const VASE_PARAMETERS: readonly {
  readonly name: keyof VaseValues;
  readonly type: 'f32' | 'u32';
  readonly default: number;
  readonly minimum: number;
  readonly maximum: number;
}[] = [
  { name: 'height', type: 'f32', default: 2.4, minimum: 1, maximum: 4 },
  { name: 'radius', type: 'f32', default: 0.75, minimum: 0.4, maximum: 1.3 },
  { name: 'sides', type: 'u32', default: 32, minimum: 8, maximum: 64 },
];
export const VASE_DEFAULTS = Object.fromEntries(
  VASE_PARAMETERS.map((parameter) => [parameter.name, parameter.default]),
) as VaseValues;

/** Native JS is admitted and executed only after the game starts. No variant is cooked. */
export function vaseContent(
  imports: Readonly<Record<string, string>>,
  material: string,
  digest: string,
) {
  return {
    source: {
      schemaVersion: '2.0.0' as const,
      kind: 'scriptable-pack-source' as const,
      source: 'Runtime vase.js',
      packageId: PackageId.format(VASE_GENERATOR),
      program: 'game-3d/vase',
      runtime: { dependencies: [material] },
      parameters: [
        ...VASE_PARAMETERS,
        { name: 'material', type: 'string' as const, default: material },
      ],
    },
    dependencies: { [material]: digest },
    programs: {
      'game-3d/vase': {
        artifact: preparePackProgram({
          entry: 'vase.program.mjs',
          export: 'build',
          imports: Object.fromEntries(
            ['@forgeax/engine/geometry', '@forgeax/engine/pack/source'].map((name) => [
              name,
              imports[name],
            ]),
          ),
          modules: {
            'vase.program.mjs': programSource,
          },
        }).unwrap(),
      },
    },
  };
}
