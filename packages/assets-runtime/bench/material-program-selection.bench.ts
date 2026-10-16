import type { MaterialCookProgramContext } from '@forgeax/engine-pack/material-cook';
import { bench } from 'vitest';
import {
  type MaterialRenderProjection,
  selectMaterialPassProgram,
} from '../src/material/runtime-shader';

const contexts: MaterialCookProgramContext[] = Array.from({ length: 32 }, (_, index) => ({
  backend: index & 1 ? 'wgpu-native' : 'webgpu',
  capability: index & 2 ? 'storage-buffer-atmosphere' : 'storage-buffer',
  pipeline: index & 4 ? 'deferred' : 'forward',
  geometry: index & 8 ? 'skinned' : 'mesh',
  instrumentation: index & 16 ? 'validation' : 'none',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
}));
const projection: MaterialRenderProjection = {
  materialGuid: 'bench',
  publicationGeneration: 1,
  specializationKey: 'bench',
  artifactHash: 'bench',
  runtimeValues: {},
  staticSelection: [],
  passes: ['Forward', 'Shadow', 'Overlay'].map((name) => ({
    name,
    module: name,
    programs: contexts.flatMap((context, index) =>
      (['direct', 'scene-index'] as const).map((address) => ({
        context,
        address,
        entry: 'vs_main',
        specializationKey: name + index + address,
        artifactHash: 'bench',
      })),
    ),
  })),
};

bench('material program selection: 32 contexts, 3 passes, 2 addresses', () => {
  for (const context of contexts)
    for (const address of ['direct', 'scene-index'] as const)
      selectMaterialPassProgram(projection, 'Forward', { ...context }, address);
});
