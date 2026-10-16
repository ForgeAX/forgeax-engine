import type { MaterialPass } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { toMaterialAsset } from '../bridge.js';
import type { GltfMaterialIr } from '../parse-gltf.js';

const base: GltfMaterialIr = {
  baseColorFactor: [1, 1, 1, 1],
  metallicFactor: 0,
  roughnessFactor: 0.7,
};
const role = (pass: MaterialPass) =>
  (pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined)?.LightMode;
const roles = (material: ReturnType<typeof toMaterialAsset>) => material.passes?.map(role);

describe('imported Standard render paths', () => {
  it.each([
    'OPAQUE',
    'MASK',
  ] as const)('admits %s to direct, deferred and shadow rendering', (alphaMode) => {
    const material = toMaterialAsset({ ...base, alphaMode, alphaCutoff: 0.37, doubleSided: true });
    expect(roles(material)).toEqual(['Forward', 'Deferred', 'ShadowCaster']);
    for (const pass of material.passes ?? []) {
      expect(pass.renderState?.cullMode).toBe('none');
      expect(pass.renderState?.blend).toBeUndefined();
    }
    if (alphaMode === 'MASK') expect(material.values?.alphaCutoff).toBe(0.37);
  });

  it('keeps blending outside the opaque G-buffer and makes shadow depth independent', () => {
    const material = toMaterialAsset({ ...base, alphaMode: 'BLEND' });
    expect(roles(material)).toEqual(['Forward', 'ShadowCaster']);
    expect(material.passes?.[0]?.renderState?.depthWriteEnabled).toBe(false);
    const shadow = material.passes?.find((pass) => role(pass) === 'ShadowCaster');
    expect(shadow?.renderState?.blend).toBeUndefined();
    expect(shadow?.renderState?.depthWriteEnabled).not.toBe(false);
  });

  it.each([
    { clearcoatFactor: 0.4 },
    { transmissionFactor: 0.5 },
  ])('keeps physical layers on their supported Forward path: %j', (extension) => {
    expect(roles(toMaterialAsset({ ...base, ...extension }))).toEqual(['Forward', 'ShadowCaster']);
  });

  it('retains skinned geometry selection for the deferred material pass', () => {
    const material = toMaterialAsset(base, { skinned: true });
    expect(material.passes?.find((pass) => role(pass) === 'Deferred')?.program.module).toBe(
      'forgeax::pbr-skin',
    );
  });
});
