import { ShaderRegistry } from '@forgeax/engine/shader';
import { AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import {
  AdditiveBlending,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhysicalMaterial,
  Texture,
} from 'three/src/Three.Core.js';
import { describe, expect, it } from 'vitest';
import { materialTextures, materialValues, projectMaterial, validateMaterial } from '../material';
import { prepareMaterialPrograms } from '../material-programs';

describe('Three material projection', () => {
  it('uses current native program admission instead of a retained loader result', {
    timeout: 30000,
  }, async () => {
    const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    try {
      const prepare = await prepareMaterialPrograms(assets);
      const source = projectMaterial(new MeshBasicMaterial(), {}).unwrap();
      const material = prepare(source);
      expect(assets.guidOf(material)).toBe('forgeax-three-unlit');
      const failed = await createMaterialLoader({ loadPublication: async () => undefined }).load({
        guid: 'forgeax-three-unlit',
        specializationKey: '',
      });
      if (failed.status === 'Ready') throw new Error('missing publication unexpectedly loaded');
      assets.recordMaterialReadiness('forgeax-three-unlit', failed);
      let observed: unknown;
      try {
        prepare(source);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(failed.error);
    } finally {
      assets.invalidateAll();
    }
  });

  it('uses dedicated native diffuse/normal/matcap modes', () => {
    const lambert = projectMaterial(new MeshLambertMaterial({ emissive: 0x303030 }), {}).unwrap();
    expect(lambert.values).toMatchObject({ metallic: 0, roughness: 1, specular: 0 });
    expect(
      projectMaterial(new MeshNormalMaterial({ opacity: 0.4 }), {}).unwrap().values,
    ).toMatchObject({ shading: 1, baseColor: [1, 1, 1, 0.4] });
    const texture = new Texture();
    const source = new MeshMatcapMaterial({ matcap: texture });
    expect(materialTextures(source)).toEqual([['baseColorTexture', texture]]);
    expect(
      projectMaterial(source, { baseColorTexture: { texture: 7 } }).unwrap().values,
    ).toMatchObject({ shading: 2, baseColorTexture: { texture: 7 } });
  });

  it('retains physical layer factors, textures and finite/infinite absorption edits', () => {
    const material = new MeshPhysicalMaterial({
      clearcoat: 0.8,
      clearcoatRoughness: 0.3,
      anisotropy: 0.4,
      anisotropyRotation: 0.7,
      sheen: 0.5,
      sheenColor: 0xffffff,
      sheenRoughness: 0.6,
      iridescence: 0.2,
      iridescenceIOR: 1.4,
      specularIntensity: 0.6,
      transmission: 0.7,
      thickness: 0.5,
      ior: 1.3,
      depthWrite: false,
    });
    material.transmissionMap = new Texture();
    material.clearcoatMap = new Texture();
    expect(validateMaterial(material).ok).toBe(true);
    const before = materialValues(material);
    const native = projectMaterial(material, { transmissionTexture: { texture: 4 } }).unwrap();
    expect(native.values).toMatchObject({
      clearcoat: 0.8,
      clearcoatRoughness: 0.3,
      anisotropyStrength: 0.4,
      anisotropyRotation: 0.7,
      sheenColor: [0.5, 0.5, 0.5],
      sheenRoughness: 0.6,
      iridescence: 0.2,
      iridescenceIor: 1.4,
      specular: 0.6,
      transmission: 0.7,
      thickness: 0.5,
      ior: 1.3,
      transmissionTexture: { texture: 4 },
    });
    expect(native.values?.attenuationDistance).toBeUndefined();
    expect(materialTextures(material)).toContainEqual(['clearcoatTexture', material.clearcoatMap]);
    material.attenuationDistance = 4;
    material.sheenColor.r = 0.3;
    expect(materialValues(material)).not.toEqual(before);
    expect(projectMaterial(material, {}).unwrap().values).toMatchObject({
      attenuationDistance: 4,
      sheenColor: [0.15, 0.5, 0.5],
    });
  });

  it('enables explicitly selected additive blending without the transparent flag', () => {
    const material = new MeshBasicMaterial({
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetUnits: 2,
      polygonOffsetFactor: 3,
    });
    const pass = projectMaterial(material, {}).unwrap().passes?.[0];
    expect(pass?.renderState).toMatchObject({
      depthBias: 2,
      depthBiasSlopeScale: 3,
      blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one' } },
    });
  });

  it('distinguishes migration exceptions from pending ordinary features', () => {
    const material = new MeshPhysicalMaterial();
    material.dispersion = 0.1;
    expect(() => validateMaterial(material).unwrap()).toThrow('three-unsupported');
    material.dispersion = 0;
    material.onBeforeCompile = () => {};
    expect(() => validateMaterial(material).unwrap()).toThrow('three-migration-required');
  });
});
