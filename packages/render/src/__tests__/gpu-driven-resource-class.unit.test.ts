import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { gpuDrivenMaterialResourceClass } from '../extract/gpu-driven';
import { defaultMaterialSnapshot } from '../render-system-extract';

it('keeps absent and empty resource bindings in the same canonical batch class', () => {
  const material = defaultMaterialSnapshot(1);
  const absent = gpuDrivenMaterialResourceClass(material);
  expect(absent).toBe(JSON.stringify({ textures: [], samplers: [] }));
  expect(
    gpuDrivenMaterialResourceClass({
      ...material,
      textureHandles: new Map(),
      samplerHandles: new Map(),
    }),
  ).toBe(absent);
});

it('observes transitions out of and back into the empty class without retaining mutable resource facts', () => {
  const textures = new Map<string, AssetHandle<'texture'>>([
    ['normal', 12 as AssetHandle<'texture'>],
    ['albedo', 4 as AssetHandle<'texture'>],
  ]);
  const samplers = new Map<string, AssetHandle<'sampler'>>([
    ['surfaceSampler', 9 as AssetHandle<'sampler'>],
  ]);
  const material = {
    ...defaultMaterialSnapshot(1),
    textureHandles: textures,
    samplerHandles: samplers,
  };
  expect(gpuDrivenMaterialResourceClass(material)).toBe(
    JSON.stringify({
      textures: [
        ['albedo', 4],
        ['normal', 12],
      ],
      samplers: [['surfaceSampler', 9]],
    }),
  );
  textures.clear();
  expect(gpuDrivenMaterialResourceClass(material)).toBe(
    JSON.stringify({
      textures: [],
      samplers: [['surfaceSampler', 9]],
    }),
  );
  samplers.clear();
  expect(gpuDrivenMaterialResourceClass(material)).toBe(
    JSON.stringify({ textures: [], samplers: [] }),
  );
  textures.set('normal', 21 as AssetHandle<'texture'>);
  expect(gpuDrivenMaterialResourceClass(material)).toBe(
    JSON.stringify({
      textures: [['normal', 21]],
      samplers: [],
    }),
  );
});
