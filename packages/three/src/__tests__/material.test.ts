import { AssetRegistry, findMaterialPassProgram } from '@forgeax/engine-assets-runtime';
import {
  AdditiveBlending,
  BackSide,
  DataTexture,
  DoubleSide,
  FrontSide,
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Texture,
} from 'three/src/Three.Core.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookPhysicalMaterials, physicalTextureRecipe } from '../build/materials';
import { ThreeCompatibilityError } from '../errors';
import { materialTextures, materialValues, projectMaterial, validateMaterial } from '../material';
import { prepareMaterialPrograms } from '../material-programs';
import { projectTexture } from '../texture';

describe('Three material projection', () => {
  it('returns a precise migration diagnostic for custom onBeforeCompile hooks', () => {
    const source = new MeshStandardMaterial();
    expect(validateMaterial(source).unwrap()).toBe(source);
    const hook = () => {};
    source.onBeforeCompile = hook;
    const result = validateMaterial(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('custom hook was silently accepted');
    expect(result.error).toBeInstanceOf(ThreeCompatibilityError);
    expect(result.error).toMatchObject({
      code: 'three-migration-required',
      detail: { subject: 'Material.onBeforeCompile', uuid: source.uuid },
      hint: expect.stringContaining('WGSL'),
    });
    expect(source.onBeforeCompile).toBe(hook);
    source.onBeforeCompile = Material.prototype.onBeforeCompile;
    expect(validateMaterial(source).unwrap()).toBe(source);
  });

  it('detects inherited onBeforeCompile overrides without rejecting ordinary subclasses', () => {
    class Ordinary extends MeshStandardMaterial {}
    class Customized extends MeshStandardMaterial {
      override onBeforeCompile() {}
    }
    expect(validateMaterial(new Ordinary()).ok).toBe(true);
    expect(() => validateMaterial(new Customized()).unwrap()).toThrow('Material.onBeforeCompile');
  });

  it('projects r187 iridescence thickness fields and later direct edits', () => {
    const material = new MeshPhysicalMaterial({ iridescence: 1 });
    material.iridescenceThicknessMinimum = 125;
    material.iridescenceThicknessMaximum = 375;
    const projected = projectMaterial(material, {}).unwrap();
    expect(projected.values?.iridescenceThicknessMinimum).toBe(125);
    expect(projected.values?.iridescenceThicknessMaximum).toBe(375);
    const before = materialValues(material);
    material.iridescenceThicknessMinimum = 200;
    expect(materialValues(material)).not.toEqual(before);
    expect(projectMaterial(material, {}).unwrap().values?.iridescenceThicknessMinimum).toBe(200);
  });
  it('invalidates fog participation edits without requiring needsUpdate', () => {
    const material = new MeshBasicMaterial();
    const previous = materialValues(material);
    material.fog = false;
    expect(materialValues(material)).not.toEqual(previous);
    expect(
      projectMaterial(material, {})
        .unwrap()
        .passes?.find((pass) => pass.name === 'forward')?.renderState?.fog,
    ).toBe(false);
    material.fog = true;
    expect(materialValues(material)).toEqual(previous);
  });
  it('discovers exact build recipes with the same normal-map priority as the player', () => {
    const material = new MeshPhysicalMaterial();
    material.normalMap = new Texture();
    material.bumpMap = new Texture();
    material.clearcoatMap = new Texture();
    expect(physicalTextureRecipe(material)).toEqual(['clearcoatMap', 'normalMap']);
    material.normalMap = null;
    expect(physicalTextureRecipe(material)).toEqual(['bumpMap', 'clearcoatMap']);
    material.bumpMap = material.clearcoatMap = null;
    expect(physicalTextureRecipe(material)).toEqual([]);
  });
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
  it('admits Matcap alpha maps through the existing independent coverage slot', () => {
    const source = new MeshMatcapMaterial({ alphaMap: new Texture(), opacity: 0.6 });
    expect(validateMaterial(source).ok).toBe(true);
    const alpha = textureHandle();
    const matcap = textureHandle();
    const projected = projectMaterial(source, {
      baseColorTexture: { texture: matcap },
      alphaTexture: { texture: alpha },
    }).unwrap();
    const baseline = projectMaterial(new MeshMatcapMaterial(), {
      baseColorTexture: { texture: matcap },
    }).unwrap();
    expect(projected.parameters).toEqual(baseline.parameters);
    expect(projected.passes?.map((pass) => pass.program)).toEqual(
      baseline.passes?.map((pass) => pass.program),
    );
    expect(projected.values).toMatchObject({
      shading: 2,
      alphaChannel: 0,
      alphaTexture: { texture: alpha },
    });
    expect(
      projected.parameters?.filter((parameter) => parameter.type.startsWith('texture')),
    ).toHaveLength(2);
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

  it('admits both stock Physical shapes from one source and compiles only a selected pass', async () => {
    const assets = new AssetRegistry();
    owners.push(assets);
    const install = vi.spyOn(assets.materialArtifactRegistry, 'register');
    const admit = vi.spyOn(assets.shaderRegistry, 'prepareMaterialTemplateFromInitializedCompiler');
    const project = await prepareMaterialPrograms(assets);
    const basic = projectMaterial(new MeshBasicMaterial(), {}).unwrap();
    expect(project(basic)).toBe(basic);
    expect(admit).not.toHaveBeenCalled();
    const source = new MeshPhysicalMaterial({ clearcoat: 0.5 });
    const plain = project(projectMaterial(source, {}).unwrap());
    expect(admit).toHaveBeenCalledOnce();
    const texture = assets
      .create(projectTexture(new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1)).unwrap())
      .unwrap();
    const mapped = project(projectMaterial(source, { baseColorTexture: { texture } }).unwrap());
    const plainProgram = assets.materialPayloadProjections.get(plain);
    const mappedProgram = assets.materialPayloadProjections.get(mapped);
    if (!plainProgram || !mappedProgram) throw new Error('Missing stock Physical projection');
    expect(plainProgram.sourceTemplate?.sources).toBe(mappedProgram.sourceTemplate?.sources);
    expect(admit).toHaveBeenCalledTimes(2);
    expect(mapped.values?.baseColorTexture).toEqual({ texture });
    expect(plain.values?.baseColorTexture).toBeUndefined();
    expect(install).not.toHaveBeenCalled();
    const context = {
      pipeline: 'forward',
      backend: 'webgpu',
      capability: 'storage-buffer',
      geometry: 'mesh',
      pass: 'forward',
      instrumentation: 'none',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
    } as const;
    const program = findMaterialPassProgram(mappedProgram, 'forward', context);
    expect(program).toBeDefined();
    expect(install).toHaveBeenCalledTimes(1);
    const admittedBeforeProjection = admit.mock.calls.length;
    const next = (await prepareMaterialPrograms(assets))(
      projectMaterial(source, { baseColorTexture: { texture } }).unwrap(),
    );
    expect(admit).toHaveBeenCalledTimes(admittedBeforeProjection);
    const nextProgram = assets.materialPayloadProjections.get(next);
    if (!nextProgram) throw new Error('Missing stock Physical projection');
    expect(findMaterialPassProgram(nextProgram, 'forward', context)).toBe(program);
    expect(install).toHaveBeenCalledTimes(1);
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

  it.each([
    [FrontSide, null, 'front'],
    [BackSide, null, 'back'],
    [DoubleSide, null, 'none'],
    [FrontSide, FrontSide, 'back'],
    [FrontSide, BackSide, 'front'],
    [BackSide, DoubleSide, 'none'],
  ] as const)('owns Three shadow sidedness: side=%s override=%s', (side, shadowSide, expected) => {
    for (const Material of [MeshBasicMaterial, MeshStandardMaterial]) {
      const material = new Material({ side });
      material.shadowSide = shadowSide;
      const asset = projectMaterial(material, {}).unwrap();
      expect(
        asset.passes?.find((pass) => pass.name === 'shadow-caster')?.renderState?.cullMode,
      ).toBe(expected);
    }
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
