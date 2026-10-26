import { Materials } from '@forgeax/engine-render';
import {
  err,
  type MaterialAsset,
  type MaterialRenderState,
  type MaterialTextureValue,
  ok,
  type Result,
} from '@forgeax/engine-types';
import {
  AlwaysDepth,
  BackSide,
  DoubleSide,
  EqualDepth,
  FrontSide,
  GreaterDepth,
  GreaterEqualDepth,
  LessDepth,
  LessEqualDepth,
  LineBasicMaterial,
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeverDepth,
  NormalBlending,
  NotEqualDepth,
  ObjectSpaceNormalMap,
  PointsMaterial,
  SpriteMaterial,
  type Texture,
  VideoTexture,
} from 'three/src/Three.Core.js';
import { projectBlending } from './blending';
import { defaultMatcap } from './default-matcap';
import { invalid, migration, unsupported } from './errors';
import { projectStencil } from './stencil';

export type SupportedMaterial =
  | MeshBasicMaterial
  | MeshStandardMaterial
  | MeshLambertMaterial
  | MeshMatcapMaterial
  | MeshNormalMaterial
  | LineBasicMaterial
  | PointsMaterial
  | SpriteMaterial;

export const TEXTURE_SLOTS = {
  map: 'baseColorTexture',
  normalMap: 'normalTexture',
  roughnessMap: 'roughnessTexture',
  metalnessMap: 'metallicTexture',
  emissiveMap: 'emissiveTexture',
  alphaMap: 'alphaTexture',
  aoMap: 'occlusionTexture',
  bumpMap: 'bumpTexture',
  displacementMap: 'displacementTexture',
  clearcoatMap: 'clearcoatTexture',
  clearcoatRoughnessMap: 'clearcoatRoughnessTexture',
  clearcoatNormalMap: 'clearcoatNormalTexture',
  anisotropyMap: 'anisotropyTexture',
  sheenColorMap: 'sheenColorTexture',
  sheenRoughnessMap: 'sheenRoughnessTexture',
  iridescenceMap: 'iridescenceTexture',
  iridescenceThicknessMap: 'iridescenceThicknessTexture',
  specularIntensityMap: 'specularTexture',
  specularColorMap: 'specularColorTexture',
  transmissionMap: 'transmissionTexture',
  thicknessMap: 'thicknessTexture',
  matcap: 'baseColorTexture',
} as const;

export function materialTextures(material: SupportedMaterial): (readonly [string, Texture])[] {
  const result: (readonly [string, Texture])[] = [];
  for (const [field, parameter] of Object.entries(TEXTURE_SLOTS)) {
    const texture = (material as unknown as Record<string, Texture | null>)[field];
    // WebGPU normal maps take priority over bump maps.
    if (field === 'bumpMap' && 'normalMap' in material && material.normalMap !== null) continue;
    if (texture instanceof VideoTexture) texture.update();
    if (texture != null) result.push([parameter, texture]);
  }
  if (material instanceof MeshMatcapMaterial && material.matcap === null)
    result.push(['baseColorTexture', defaultMatcap]);
  return result;
}

export function validateMaterial(material: Material): Result<SupportedMaterial, Error> {
  if (material.type === 'ShaderMaterial' || material.type === 'RawShaderMaterial')
    return migration(material.type, material.uuid);
  if (
    ![
      'MeshBasicMaterial',
      'LineBasicMaterial',
      'LineDashedMaterial',
      'PointsMaterial',
      'SpriteMaterial',
      'MeshStandardMaterial',
      'MeshPhysicalMaterial',
      'MeshLambertMaterial',
      'MeshNormalMaterial',
      'MeshMatcapMaterial',
    ].includes(material.type)
  )
    return unsupported(material.type, material.uuid);
  if (material.onBeforeRender !== Material.prototype.onBeforeRender)
    return unsupported('Material.onBeforeRender', material.uuid);
  const source = material as SupportedMaterial;
  if ('wireframe' in source && source.wireframe && !(source instanceof MeshBasicMaterial))
    return unsupported('Lit wireframe needs native line attributes', source.uuid);
  if (
    ('envMap' in source && source.envMap !== null) ||
    ('lightMap' in source && source.lightMap !== null)
  )
    return unsupported('Material environment/lightmap', source.uuid);
  if (source instanceof MeshBasicMaterial && source.aoMap !== null)
    return unsupported('MeshBasicMaterial AO map', source.uuid);
  if (source instanceof MeshMatcapMaterial || source instanceof MeshNormalMaterial) {
    if (source.normalMap !== null || source.bumpMap !== null || source.displacementMap !== null)
      return unsupported('Normal/Matcap bump/normal/displacement maps', source.uuid);
    if (source instanceof MeshMatcapMaterial && (source.map !== null || source.alphaMap !== null))
      return unsupported('MeshMatcapMaterial color/alpha map', source.uuid);
  }
  if (
    source instanceof MeshPhysicalMaterial &&
    (source.dispersion !== 0 ||
      (source.clearcoatNormalMap !== null &&
        source.clearcoatNormalScale.x !== source.clearcoatNormalScale.y))
  )
    return unsupported(
      'MeshPhysicalMaterial dispersion/anisotropic clearcoat normal scale',
      source.uuid,
    );
  if (![FrontSide, BackSide, DoubleSide].includes(source.side))
    return unsupported('Material.side/blending', source.uuid);
  if (
    ![
      NeverDepth,
      AlwaysDepth,
      LessDepth,
      LessEqualDepth,
      EqualDepth,
      GreaterEqualDepth,
      GreaterDepth,
      NotEqualDepth,
    ].some((value) => value === source.depthFunc)
  )
    return unsupported('Material.depthFunc', source.uuid);
  if (
    ![source.opacity, source.alphaTest].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    )
  )
    return invalid('Material.opacity/alphaTest', source.uuid);
  if (
    Object.values(surfaceValues(source))
      .flat()
      .some((value) => typeof value === 'number' && !Number.isFinite(value))
  )
    return invalid('Material numeric parameters', source.uuid);
  try {
    projectBlending(source);
  } catch (error) {
    return err(error as Error);
  }
  return ok(source);
}

function surfaceValues(material: SupportedMaterial) {
  const color = 'color' in material ? material.color.toArray() : [1, 1, 1];
  return {
    baseColor: [...color, material.opacity] as [number, number, number, number],
    ...('emissive' in material
      ? {
          emissive: [material.emissive.r, material.emissive.g, material.emissive.b] as const,
          emissiveIntensity: material.emissiveIntensity,
          normalScale: [material.normalScale.x, material.normalScale.y] as const,
          normalMapSpace:
            material.normalMapType === ObjectSpaceNormalMap
              ? ('object' as const)
              : ('tangent' as const),
          bumpScale: material.bumpScale,
          occlusionStrength: material.aoMapIntensity,
        }
      : {}),
    ...(material instanceof MeshStandardMaterial
      ? {
          roughness: material.roughness,
          metallic: material.metalness,
          displacementScale: material.displacementScale,
          displacementBias: material.displacementBias,
        }
      : {}),
    ...(material instanceof MeshPhysicalMaterial
      ? {
          clearcoat: material.clearcoat,
          clearcoatRoughness: material.clearcoatRoughness,
          clearcoatNormalScale: material.clearcoatNormalScale.x,
          anisotropyStrength: material.anisotropy,
          anisotropyRotation: material.anisotropyRotation,
          sheenColor: material.sheenColor.toArray().map((value) => value * material.sheen) as [
            number,
            number,
            number,
          ],
          sheenRoughness: material.sheenRoughness,
          iridescence: material.iridescence,
          iridescenceIor: material.iridescenceIOR,
          iridescenceThicknessMinimum: material.iridescenceThicknessRange[0],
          iridescenceThicknessMaximum: material.iridescenceThicknessRange[1],
          specular: material.specularIntensity,
          specularColor: [
            material.specularColor.r,
            material.specularColor.g,
            material.specularColor.b,
          ] as const,
          transmission: material.transmission,
          ior: material.ior,
          thickness: material.thickness,
          attenuationColor: [
            material.attenuationColor.r,
            material.attenuationColor.g,
            material.attenuationColor.b,
          ] as const,
          // An absent native attenuation distance disables absorption, matching Three's Infinity.
          ...(material.attenuationDistance === Infinity
            ? {}
            : { attenuationDistance: material.attenuationDistance }),
        }
      : {}),
  };
}

/** r184 WebGPU infers flat shading when the geometry has no normal attribute. */
export function usesFlatShading(material: Material, hasNormal = true): boolean {
  return (
    !(
      material instanceof MeshBasicMaterial ||
      material instanceof LineBasicMaterial ||
      material instanceof PointsMaterial ||
      material instanceof SpriteMaterial
    ) &&
    (!hasNormal || ('flatShading' in material && material.flatShading === true))
  );
}

export function materialValues(material: SupportedMaterial): unknown[] {
  return [
    material.version,
    material.type,
    material.transparent,
    material.alphaTest,
    material.side,
    material.shadowSide,
    material.forceSinglePass,
    material.blending,
    material.blendSrc,
    material.blendDst,
    material.blendEquation,
    material.blendSrcAlpha,
    material.blendDstAlpha,
    material.blendEquationAlpha,
    material.depthTest,
    material.depthWrite,
    material.depthFunc,
    material.colorWrite,
    material.vertexColors,
    material.polygonOffset,
    material.polygonOffsetFactor,
    material.polygonOffsetUnits,
    material.alphaToCoverage,
    material.alphaHash,
    material.stencilWrite,
    material.stencilFunc,
    material.stencilFuncMask,
    material.stencilWriteMask,
    material.stencilRef,
    material.stencilFail,
    material.stencilZFail,
    material.stencilZPass,
    ...Object.values(surfaceValues(material)).flat(),
  ];
}

function projectFog(material: Material): { readonly fog?: false } {
  return 'fog' in material && material.fog === false ? { fog: false } : {};
}

function projectSurface(
  material: SupportedMaterial,
  textures: Readonly<Record<string, MaterialTextureValue>>,
  flatShading: boolean,
): Result<MaterialAsset, Error> {
  const comparisons: Readonly<Record<number, GPUCompareFunction>> = {
    [NeverDepth]: 'never',
    [AlwaysDepth]: 'always',
    [LessDepth]: 'less',
    [LessEqualDepth]: 'less-equal',
    [EqualDepth]: 'equal',
    [GreaterEqualDepth]: 'greater-equal',
    [GreaterDepth]: 'greater',
    [NotEqualDepth]: 'not-equal',
  };
  const depthCompare = material.depthTest ? comparisons[material.depthFunc] : 'always';
  if (depthCompare === undefined) return unsupported('Material.depthFunc', material.uuid);
  const blend = projectBlending(material);
  const renderState: MaterialRenderState = {
    cullMode: material.side === DoubleSide ? 'none' : material.side === BackSide ? 'front' : 'back',
    depthCompare,
    depthWriteEnabled: material.depthTest && material.depthWrite,
    colorWriteMask: material.colorWrite ? 15 : 0,
    alphaToCoverageEnabled: material.alphaToCoverage,
    ...projectStencil(material),
    ...(material.polygonOffset
      ? {
          depthBias: Math.trunc(material.polygonOffsetUnits),
          depthBiasSlopeScale: material.polygonOffsetFactor,
        }
      : {}),
    ...(blend === undefined ? {} : { blend }),
    ...projectFog(material),
  };
  const values = surfaceValues(material);
  const opts = {
    renderState,
    queue:
      material.transparent || ('transmission' in material && Number(material.transmission) > 0)
        ? 3000
        : 2000,
    alphaCutoff: material.alphaTest,
    // r184 MaterialNode.OPACITY converts its texture expression to float (red).
    alphaChannel: 0,
    alphaHash: material.alphaHash,
    shadowAlphaMode: 'texture' as const,
    alphaMode: (!material.transparent &&
    material.blending === NormalBlending &&
    !material.alphaToCoverage
      ? 'opaque'
      : material.premultipliedAlpha
        ? 'premultiplied'
        : 'preserve') as 'opaque' | 'premultiplied' | 'preserve',
  };
  try {
    if (material instanceof MeshNormalMaterial)
      return ok(Materials.normal({ ...opts, opacity: material.opacity, encoding: 'display' }));
    if (material instanceof MeshMatcapMaterial) {
      if (textures.baseColorTexture === undefined)
        return unsupported('MeshMatcapMaterial default procedural matcap', material.uuid);
      return ok(Materials.matcap(textures.baseColorTexture, { ...opts, color: values.baseColor }));
    }
    if (
      material instanceof MeshBasicMaterial ||
      material instanceof LineBasicMaterial ||
      material instanceof PointsMaterial ||
      material instanceof SpriteMaterial
    )
      return ok(Materials.unlit(values.baseColor, { ...opts, ...textures }));
    const options = {
      ...values,
      flatShading,
      ...opts,
      ...textures,
      ...(material instanceof MeshPhysicalMaterial
        ? { staticSwitches: { clearcoat: true, sheen: true, anisotropy: true, iridescence: true } }
        : {}),
    };
    return ok(
      material instanceof MeshLambertMaterial
        ? Materials.lambert(options)
        : Materials.standard(options),
    );
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

/** WebGPU output conversion belongs to the camera's finishing pass. */
export function projectMaterial(
  material: SupportedMaterial,
  textures: Readonly<Record<string, MaterialTextureValue>>,
  flatShading = usesFlatShading(material),
  varianceShadow = false,
): Result<MaterialAsset, Error> {
  const projected = projectSurface(material, textures, flatShading);
  if (!projected.ok || projected.value.passes === undefined) return projected;
  const passes = projected.value.passes.flatMap((pass) => {
    const shadow = pass.name === 'shadow-caster';
    const state = {
      ...pass.renderState,
      ...(material.stencilWrite ? { stencilReference: material.stencilRef } : {}),
      ...(shadow && (material.shadowSide !== null || varianceShadow)
        ? {
            cullMode:
              (material.shadowSide ?? material.side) === DoubleSide
                ? ('none' as const)
                : (material.shadowSide ?? material.side) === BackSide
                  ? ('front' as const)
                  : ('back' as const),
          }
        : {}),
    };
    if (
      material instanceof MeshPhysicalMaterial &&
      material.transmission > 0 &&
      material.side === DoubleSide &&
      !material.forceSinglePass &&
      pass.name === 'forward'
    )
      return [
        {
          ...pass,
          name: 'transmission-back',
          renderState: {
            ...state,
            tags: { LightMode: 'TransmissionBack' },
            cullMode: 'front' as const,
          },
        },
        { ...pass, renderState: { ...state, cullMode: 'back' as const } },
      ];
    // Native MaterialPass already preserves multiple Forward draws per submesh.
    // Keep the two faces adjacent within the source object's transparent order.
    if (
      material.transparent &&
      material.side === DoubleSide &&
      !material.forceSinglePass &&
      pass.name === 'forward'
    )
      return [
        { ...pass, name: 'forward-back', renderState: { ...state, cullMode: 'front' as const } },
        { ...pass, renderState: { ...state, cullMode: 'back' as const } },
      ];
    return [{ ...pass, renderState: state }];
  });
  const [first, ...rest] = passes;
  if (first === undefined) return unsupported('Material has no render passes', material.uuid);
  return ok({ ...projected.value, passes: [first, ...rest] });
}
