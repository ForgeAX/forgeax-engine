import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { decompressZstd } from '@forgeax/engine-codec';
import { withClipping } from '@forgeax/engine-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookThreeSurface } from '../build/surface';
import { projectMaterial, validateMaterial } from '../material';
import { prepareMaterialPrograms } from '../material-programs';
import { MeshStandardNodeMaterial } from '../node-materials';
import { bindThreeSurface, normalizeThreeSurface } from '../node-surface';
import { MATERIAL_PUBLICATION_V1, readMaterialPublication } from '../program-publication';
import { float, mix, uniform } from '../tsl';

describe('compiled Three roughness graph', () => {
  const material = new MeshStandardNodeMaterial();
  const amount = uniform(0.7);
  let cooked: Awaited<ReturnType<typeof cookThreeSurface>>;

  beforeAll(async () => {
    material.roughnessNode = mix(float(0.1), amount.mul(0.8), float(0.5));
    cooked = await cookThreeSurface(material, { planarReflection: true });
  }, 120000);

  afterAll(() => material.dispose());

  it('keeps the publication identity when only a uniform changes', {
    timeout: 120000,
  }, async () => {
    amount.value = 0.9;
    try {
      expect(normalizeThreeSurface(material).unwrap().graphKey).toBe(cooked.recipe.graphKey);
    } finally {
      amount.value = 0.7;
    }
  });

  it('binds only its reflected publication, including after raster-state wrapping', {
    timeout: 120000,
  }, async () => {
    expect(cooked.recipe.programGuid).toMatch(/^forgeax-three-surface-[a-f0-9]{64}$/);
    const decoded = await decompressZstd(Buffer.from(cooked.publication, 'base64'));
    if (!decoded.ok) throw decoded.error;
    expect(new DataView(decoded.value.buffer, decoded.value.byteOffset).getUint32(0)).toBe(
      MATERIAL_PUBLICATION_V1,
    );
    const records = readMaterialPublication(decoded.value);
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error('Missing cooked Surface program');
    expect(record.programs.length).toBeGreaterThan(0);
    expect(
      record.resolved.passes.every(
        (pass) =>
          pass.program.moduleSlots?.surface === `forgeax_three::surface_${cooked.recipe.graphKey}`,
      ),
    ).toBe(true);
    const rebound = new MeshStandardNodeMaterial();
    rebound.roughnessNode = amount.mul(0.5).add(0.2);
    const second = await cookThreeSurface(rebound);
    const assets = new AssetRegistry();
    try {
      const publications = [cooked.publication, second.publication];
      const prepare = await prepareMaterialPrograms(assets, publications);
      await prepareMaterialPrograms(assets, publications);
      publications[0] = 'invalid-publication';
      await expect(prepareMaterialPrograms(assets, publications)).rejects.toThrow();
      publications[0] = cooked.publication;
      const project = () =>
        prepare(
          withClipping(projectMaterial(validateMaterial(material).unwrap(), {}).unwrap(), {
            planes: [],
          }),
        );
      const first = project();
      expect(first.values?.planarReflection).toBe(1);
      expect(Object.getOwnPropertySymbols(first)).toEqual([]);
      expect(assets.create(first).ok).toBe(true);
      expect(first.parameters?.some((parameter) => parameter.name === 'threeInput0')).toBe(true);
      expect(assets.getMaterialProjectionForPayload(first)?.materialGuid).toBe(
        cooked.recipe.programGuid,
      );
      amount.value = 0.8;
      const updated = project();
      expect(updated.values?.threeInput0).toBe(0.8);
      expect(assets.getMaterialProjectionForPayload(updated)?.artifactHash).toBe(
        assets.getMaterialProjectionForPayload(first)?.artifactHash,
      );
      const other = new MeshStandardNodeMaterial();
      try {
        other.roughnessNode = uniform(0.3).add(0.1);
        bindThreeSurface(other, {
          ...cooked.recipe,
          graphKey: normalizeThreeSurface(other).unwrap().graphKey,
        }).unwrap();
        expect(() =>
          prepare(projectMaterial(validateMaterial(other).unwrap(), {}).unwrap()),
        ).toThrow('Missing cooked Three surface program');
      } finally {
        other.dispose();
      }
      material.roughnessNode = rebound.roughnessNode;
      expect(validateMaterial(material).ok).toBe(false);
      bindThreeSurface(material, second.recipe).unwrap();
      const recompiled = project();
      expect(assets.getMaterialProjectionForPayload(recompiled)?.materialGuid).toBe(
        second.recipe.programGuid,
      );
      expect(assets.getMaterialProjectionForPayload(recompiled)?.artifactHash).not.toBe(
        assets.getMaterialProjectionForPayload(first)?.artifactHash,
      );
    } finally {
      assets.dispose();
      rebound.dispose();
    }
  });
});
