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
  AdditiveBlending,
  AlwaysDepth,
  BackSide,
  DoubleSide,
  EqualDepth,
  FrontSide,
  GreaterDepth,
  GreaterEqualDepth,
  LessDepth,
  LessEqualDepth,
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MultiplyBlending,
  NeverDepth,
  NoBlending,
  NormalBlending,
  NotEqualDepth,
  ObjectSpaceNormalMap,
  SubtractiveBlending,
  type Texture,
} from 'three/src/Three.Core.js';
import { invalid, migration, unsupported } from './errors';

export type SupportedMaterial =
  | MeshBasicMaterial
  | MeshStandardMaterial
  | MeshLambertMaterial
  | MeshMatcapMaterial
  | MeshNormalMaterial;

const TEXTURE_SLOTS = {
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
    if (texture != null) result.push([parameter, texture]);
  }
  return result;
}

export function validateMaterial(material: Material): Result<SupportedMaterial, Error> {
  if (material.type === 'ShaderMaterial' || material.type === 'RawShaderMaterial')
    return migration(material.type, material.uuid);
  if (
    ![
      'MeshBasicMaterial',
      'MeshStandardMaterial',
      'MeshPhysicalMaterial',
      'MeshLambertMaterial',
      'MeshNormalMaterial',
      'MeshMatcapMaterial',
    ].includes(material.type)
  )
    return unsupported(material.type, material.uuid);
  if (
    material.onBeforeCompile !== Material.prototype.onBeforeCompile ||
    material.customProgramCacheKey !== Material.prototype.customProgramCacheKey
  )
    return migration('Material shader callbacks', material.uuid);
  if (material.onBeforeRender !== Material.prototype.onBeforeRender)
    return unsupported('Material.onBeforeRender', material.uuid);
  const source = material as SupportedMaterial;
  if (
    source.wireframe ||
    source.stencilWrite ||
    source.premultipliedAlpha ||
    source.clippingPlanes?.length ||
    (source.transparent && source.side === DoubleSide && !source.forceSinglePass) ||
    source.alphaHash
  )
    return unsupported(
      'Material wireframe/stencil/clipping/premultiplication/alphaHash/two-pass transparency',
      source.uuid,
    );
  if (
    ('envMap' in source && source.envMap !== null) ||
    ('lightMap' in source && source.lightMap !== null) ||
    ('flatShading' in source && source.flatShading)
  )
    return unsupported('Material environment/lightmap/flatShading', source.uuid);
  if (
    source instanceof MeshBasicMaterial &&
    (source.alphaMap !== null || source.aoMap !== null || source.specularMap !== null)
  )
    return unsupported('MeshBasicMaterial alpha/AO/specular maps', source.uuid);
  if (source instanceof MeshMatcapMaterial || source instanceof MeshNormalMaterial) {
    if (source.normalMap !== null || source.bumpMap !== null || source.displacementMap !== null)
      return unsupported('Normal/Matcap bump/normal/displacement maps', source.uuid);
    if (source instanceof MeshMatcapMaterial && (source.map !== null || source.alphaMap !== null))
      return unsupported('MeshMatcapMaterial color/alpha map', source.uuid);
    if (source instanceof MeshMatcapMaterial && source.matcap === null)
      return unsupported('MeshMatcapMaterial default procedural matcap', source.uuid);
  }
  if (source instanceof MeshLambertMaterial && source.specularMap !== null)
    return unsupported('MeshLambertMaterial.specularMap', source.uuid);
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
  if (
    source instanceof MeshPhysicalMaterial &&
    source.transmission > 0 &&
    (source.depthWrite || (source.transparent && source.blending !== NoBlending))
  )
    return unsupported(
      'MeshPhysicalMaterial transmission with depthWrite or blending',
      source.uuid,
    );
  if (
    ![FrontSide, BackSide, DoubleSide].includes(source.side) ||
    ![NoBlending, NormalBlending, AdditiveBlending, SubtractiveBlending, MultiplyBlending].some(
      (value) => value === source.blending,
    )
  )
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

export function materialValues(material: SupportedMaterial): unknown[] {
  return [
    material.version,
    material.toneMapped,
    material.type,
    material.transparent,
    material.alphaTest,
    material.side,
    material.blending,
    material.depthTest,
    material.depthWrite,
    material.depthFunc,
    material.colorWrite,
    material.vertexColors,
    material.polygonOffset,
    material.polygonOffsetFactor,
    material.polygonOffsetUnits,
    material.alphaToCoverage,
    ...Object.values(surfaceValues(material)).flat(),
  ];
}

function projectSurface(
  material: SupportedMaterial,
  textures: Readonly<Record<string, MaterialTextureValue>>,
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
  const blending =
    material.blending !== NoBlending &&
    (material.transparent || material.blending !== NormalBlending);
  const blends: Partial<Record<number, GPUBlendState>> = {
    [NormalBlending]: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    },
    [AdditiveBlending]: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
    },
    [SubtractiveBlending]: {
      color: { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    },
    [MultiplyBlending]: {
      color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'src-alpha', operation: 'add' },
    },
  };
  const renderState: MaterialRenderState = {
    cullMode: material.side === DoubleSide ? 'none' : material.side === BackSide ? 'front' : 'back',
    depthCompare,
    depthWriteEnabled: material.depthTest && material.depthWrite,
    colorWriteMask: material.colorWrite ? 15 : 0,
    alphaToCoverageEnabled: material.alphaToCoverage,
    ...(material.polygonOffset
      ? {
          depthBias: Math.trunc(material.polygonOffsetUnits),
          depthBiasSlopeScale: material.polygonOffsetFactor,
        }
      : {}),
    ...(blending ? { blend: blends[material.blending] as GPUBlendState } : {}),
  };
  const values = surfaceValues(material);
  const opts = {
    renderState,
    queue: material.transparent ? 3000 : 2000,
    alphaCutoff: material.alphaTest,
  };
  try {
    if (material instanceof MeshNormalMaterial)
      return ok(Materials.normal({ ...opts, opacity: material.opacity }));
    if (material instanceof MeshMatcapMaterial) {
      if (textures.baseColorTexture === undefined)
        return unsupported('MeshMatcapMaterial default procedural matcap', material.uuid);
      return ok(Materials.matcap(textures.baseColorTexture, { ...opts, color: values.baseColor }));
    }
    if (material instanceof MeshBasicMaterial)
      return ok(Materials.unlit(values.baseColor, { ...opts, ...textures }));
    const options = {
      ...values,
      ...opts,
      ...textures,
      ...(material instanceof MeshPhysicalMaterial
        ? {
            staticSwitches: {
              clearcoat: true,
              sheen: true,
              anisotropy: true,
              iridescence: true,
            },
          }
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

/** Destination conversion is sampled per render and runs before attachment blending. */
export function projectMaterial(
  material: SupportedMaterial,
  textures: Readonly<Record<string, MaterialTextureValue>>,
  output: readonly [number, number, number, number] = [0, 1, 1, 0],
): Result<MaterialAsset, Error> {
  const surface = projectSurface(material, textures);
  if (!surface.ok) return surface;
  if (surface.value.parent !== undefined)
    throw new Error('built-in material factory returned a child instead of a root');
  const data = material instanceof MeshNormalMaterial;
  return ok({
    ...surface.value,
    parameters: [
      ...(surface.value.parameters ?? []),
      {
        name: 'fragmentOutput',
        type: 'vec4',
        default: [0, 1, 0, 0],
      },
    ],
    values: {
      ...surface.value.values,
      fragmentOutput: [
        data || !material.toneMapped ? 0 : output[0],
        output[1],
        data ? 0 : output[2],
        output[3],
      ],
    },
  });
}
