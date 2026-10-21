import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  AdditiveBlending,
  DataTexture,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhysicalMaterial,
  Texture,
} from 'three/src/Three.Core.js';
import { afterEach, describe, expect, it } from 'vitest';
import { cookPhysicalMaterials } from '../build/materials';
import { materialTextures, materialValues, projectMaterial, validateMaterial } from '../material';
import { prepareMaterialPrograms } from '../material-programs';
import { projectTexture } from '../texture';

describe('Three material projection', () => {
  const owners: AssetRegistry[] = [];
  afterEach(() => {
    for (const assets of owners.splice(0)) assets.dispose();
  });
  function textureHandle() {
    const assets = new AssetRegistry();
    owners.push(assets);
    return assets
      .create(projectTexture(new DataTexture(new Uint8Array(4), 1, 1)).unwrap())
      .unwrap();
  }

  it('uses dedicated native diffuse/normal/matcap modes', () => {
    const lambert = projectMaterial(new MeshLambertMaterial({ emissive: 0x303030 }), {}).unwrap();
    expect(lambert.values).toMatchObject({ metallic: 0, roughness: 1, specular: 0 });
    expect(
      projectMaterial(new MeshNormalMaterial({ opacity: 0.4 }), {}).unwrap().values,
    ).toMatchObject({ shading: 3, baseColor: [1, 1, 1, 0.4], alphaMode: 1 });
    const texture = new Texture();
    const source = new MeshMatcapMaterial({ matcap: texture });
    const handle = textureHandle();
    expect(materialTextures(source)).toEqual([['baseColorTexture', texture]]);
    expect(
      projectMaterial(source, { baseColorTexture: { texture: handle } }).unwrap().values,
    ).toMatchObject({ shading: 2, baseColorTexture: { texture: handle } });
  });
  it('admits Normal through the native display-encoded output mode', () => {
    const source = new MeshNormalMaterial();
    expect(validateMaterial(source).unwrap()).toBe(source);
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
    const handle = textureHandle();
    const native = projectMaterial(material, { transmissionTexture: { texture: handle } }).unwrap();
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
      transmissionTexture: { texture: handle },
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

  it('admits an exact application-cooked texture combination and rejects a missing variant', {
    timeout: 120000,
  }, async () => {
    const publication = await cookPhysicalMaterials([
      ['normalMap', 'roughnessMap', 'clearcoatMap'],
    ]);
    const assets = new AssetRegistry();
    owners.push(assets);
    const project = await prepareMaterialPrograms(assets, [publication]);
    const texture = assets
      .create(projectTexture(new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1)).unwrap())
      .unwrap();
    const material = new MeshPhysicalMaterial({ clearcoat: 0.5 });
    const projected = project(
      projectMaterial(material, {
        normalTexture: { texture },
        roughnessTexture: { texture },
        clearcoatTexture: { texture },
      }).unwrap(),
    );
    expect(
      projected.parameters
        ?.filter((parameter) => parameter.type.startsWith('texture'))
        .map((parameter) => parameter.name)
        .sort(),
    ).toEqual(['clearcoatTexture', 'normalTexture', 'roughnessTexture']);
    expect(assets.create(projected).ok).toBe(true);
    // A superset would execute a normal sample even when the author removed it.
    expect(() =>
      project(
        projectMaterial(material, {
          roughnessTexture: { texture },
          clearcoatTexture: { texture },
        }).unwrap(),
      ),
    ).toThrow('cookPhysicalMaterials');
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
    expect(validateMaterial(material).ok).toBe(true);
  });
});
