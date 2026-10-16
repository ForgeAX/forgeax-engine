import type { Handle } from '@forgeax/engine-types';
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
  const textures = new Map<string, Handle<'TextureAsset', 'shared'>>([
    ['normal', 12 as Handle<'TextureAsset', 'shared'>],
    ['albedo', 4 as Handle<'TextureAsset', 'shared'>],
  ]);
  const samplers = new Map<string, Handle<'SamplerAsset', 'shared'>>([
    ['surfaceSampler', 9 as Handle<'SamplerAsset', 'shared'>],
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
  textures.set('normal', 21 as Handle<'TextureAsset', 'shared'>);
  expect(gpuDrivenMaterialResourceClass(material)).toBe(
    JSON.stringify({
      textures: [['normal', 21]],
      samplers: [],
    }),
  );
});
