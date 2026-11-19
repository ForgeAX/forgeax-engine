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
  type LineBasicMaterial,
  Material,
  type MeshBasicMaterial,
  type MeshLambertMaterial,
  type MeshMatcapMaterial,
  type MeshNormalMaterial,
  type MeshStandardMaterial,
  NeverDepth,
  NormalBlending,
  NotEqualDepth,
  ObjectSpaceNormalMap,
  type PointsMaterial,
  type SpriteMaterial,
  type Texture,
  VideoTexture,
} from 'three/src/Three.Core.js';
import { projectBlending } from './blending';
import { defaultMatcap } from './default-matcap';
import { invalid, migration, ThreeCompatibilityError, unsupported } from './errors';
import {
  isBasicMaterial,
  isLambertMaterial,
  isLineMaterial,
  isMatcapMaterial,
  isNormalMaterial,
  isPhysicalMaterial,
  isPointsMaterial,
  isSpriteMaterial,
  isStandardMaterial,
} from './material-kinds';
import {
  replacesTexture,
  surfaceColor,
  surfaceInput,
  surfaceRgb,
  surfaceScalar,
  surfaceTexture,
  usesTransmission,
} from './node-inputs';
import { admitNodeMaterial } from './node-materials';
import {
  boundSurfaceRoot,
  hasSurfaceBinding,
  projectThreeSurface,
  threeSurfaceRevisions,
  threeSurfaceTextures,
} from './node-surface';
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
    if (replacesTexture(material, field)) continue;
    const texture = (material as unknown as Record<string, Texture | null>)[field];
    // WebGPU normal maps take priority over bump maps.
    if (field === 'bumpMap' && 'normalMap' in material && material.normalMap !== null) continue;
    if (texture instanceof VideoTexture) texture.update();
    if (texture != null) result.push([parameter, texture]);
  }
  const colorTexture = surfaceTexture(material, 'colorNode'),
    opacityTexture = surfaceTexture(material, 'opacityNode');
  if (colorTexture !== null) result.push(['baseColorTexture', colorTexture]);
  if (opacityTexture !== null) result.push(['alphaTexture', opacityTexture]);
  if (isMatcapMaterial(material) && material.matcap === null)
    result.push(['baseColorTexture', defaultMatcap]);
  result.push(...threeSurfaceTextures(material));
  return result;
}

function admitMaterialKind(material: Material): Result<SupportedMaterial, Error> {
  if (
    material.type === 'NodeMaterialInstance' ||
    ('isNodeMaterial' in material && material.isNodeMaterial === true)
  ) {
    const admitted = admitNodeMaterial(material);
    if (!admitted.ok) return admitted;
  }
  if (material.type === 'ShaderMaterial' || material.type === 'RawShaderMaterial')
    return migration(material.type, material.uuid);
  if (
    ![
      'NodeMaterialInstance',
      'MeshBasicMaterial',
      'LineBasicNodeMaterial',
      'LineDashedNodeMaterial',
      'MeshLambertNodeMaterial',
      'MeshMatcapNodeMaterial',
      'MeshNormalNodeMaterial',
      'PointsNodeMaterial',
      'SpriteNodeMaterial',
      'MeshBasicNodeMaterial',
      'MeshStandardNodeMaterial',
      'MeshPhysicalNodeMaterial',
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
  if (material.onBeforeCompile !== Material.prototype.onBeforeCompile)
    return err(
      new ThreeCompatibilityError(
        'three-migration-required',
        'Material.onBeforeCompile',
        'Forgeax does not execute WebGL GLSL compile hooks. Move surface edits to cooked Forgeax WGSL/MaterialAsset authoring and lighting or pass edits to their native owners before rendering this material.',
        material.uuid,
      ),
    );
  return ok(material as SupportedMaterial);
}

function validCoverage(material: SupportedMaterial): boolean {
  return [
    boundSurfaceRoot(material, 'opacityNode') ? 1 : material.opacity,
    boundSurfaceRoot(material, 'alphaTestNode') ? 1 : material.alphaTest,
  ].every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}

export function validateMaterial(material: Material): Result<SupportedMaterial, Error> {
  const admitted = admitMaterialKind(material);
  if (!admitted.ok) return admitted;
  const source = admitted.value;
  if ('wireframe' in source && source.wireframe && !isBasicMaterial(source))
    return unsupported('Lit wireframe needs native line attributes', source.uuid);
  if (
    ('envMap' in source && source.envMap !== null) ||
    ('lightMap' in source && source.lightMap !== null)
  )
    return unsupported('Material environment/lightmap', source.uuid);
  if (isBasicMaterial(source) && source.aoMap !== null)
    return unsupported('MeshBasicMaterial AO map', source.uuid);
  if (unsupportedNormalMaps(source))
    return unsupported('Normal/Matcap bump/normal/displacement maps', source.uuid);
  if (isMatcapMaterial(source) && source.map !== null)
    return unsupported('MeshMatcapMaterial color map', source.uuid);
  if (unsupportedPhysicalOptions(source))
    return unsupported(
      'MeshPhysicalMaterial dispersion/diffuseRoughness/retroreflectivity/anisotropic clearcoat normal scale',
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
  if (!validCoverage(source)) return invalid('Material.opacity/alphaTest', source.uuid);
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
  return admitted;
}

function unsupportedNormalMaps(source: SupportedMaterial): boolean {
  return (
    (isMatcapMaterial(source) || isNormalMaterial(source)) &&
    (source.normalMap !== null || source.bumpMap !== null || source.displacementMap !== null)
  );
}

function unsupportedPhysicalOptions(source: SupportedMaterial): boolean {
  return (
    isPhysicalMaterial(source) &&
    (source.dispersion !== 0 ||
      ('diffuseRoughness' in source && source.diffuseRoughness !== 0) ||
      ('retroreflectivity' in source && source.retroreflectivity !== 0) ||
      (source.clearcoatNormalMap !== null &&
        source.clearcoatNormalScale.x !== source.clearcoatNormalScale.y))
  );
}

function surfaceValues(material: SupportedMaterial) {
  const attenuationDistance = isPhysicalMaterial(material)
    ? surfaceScalar(material, 'attenuationDistanceNode', material.attenuationDistance)
    : Infinity;
  return {
    baseColor: surfaceColor(material),
    ...('emissive' in material
      ? {
          emissive: surfaceRgb(material, 'emissiveNode', material.emissive),
          emissiveIntensity:
            surfaceInput(material, 'emissiveNode') === null ? material.emissiveIntensity : 1,
          normalScale: [material.normalScale.x, material.normalScale.y] as const,
          normalMapSpace:
            material.normalMapType === ObjectSpaceNormalMap
              ? ('object' as const)
              : ('tangent' as const),
          bumpScale: material.bumpScale,
          occlusionStrength: material.aoMapIntensity,
        }
      : {}),
    ...(isStandardMaterial(material)
      ? {
          roughness: surfaceScalar(material, 'roughnessNode', material.roughness),
          metallic: surfaceScalar(material, 'metalnessNode', material.metalness),
          displacementScale: material.displacementScale,
          displacementBias: material.displacementBias,
        }
      : {}),
    ...(isPhysicalMaterial(material)
      ? {
          clearcoat: surfaceScalar(material, 'clearcoatNode', material.clearcoat),
          clearcoatRoughness: surfaceScalar(
            material,
            'clearcoatRoughnessNode',
            material.clearcoatRoughness,
          ),
          clearcoatNormalScale: material.clearcoatNormalScale.x,
          anisotropyStrength: material.anisotropy,
          anisotropyRotation: material.anisotropyRotation,
          sheenColor: surfaceRgb(material, 'sheenNode', material.sheenColor, material.sheen),
          sheenRoughness: surfaceScalar(material, 'sheenRoughnessNode', material.sheenRoughness),
          iridescence: surfaceScalar(material, 'iridescenceNode', material.iridescence),
          iridescenceIor: surfaceScalar(material, 'iridescenceIORNode', material.iridescenceIOR),
          iridescenceThicknessMinimum: surfaceScalar(
            material,
            'iridescenceThicknessNode',
            material.iridescenceThicknessMinimum,
          ),
          iridescenceThicknessMaximum: surfaceScalar(
            material,
            'iridescenceThicknessNode',
            material.iridescenceThicknessMaximum,
          ),
          specular: surfaceScalar(material, 'specularIntensityNode', material.specularIntensity),
          specularColor: surfaceRgb(material, 'specularColorNode', material.specularColor),
          transmission: surfaceScalar(material, 'transmissionNode', material.transmission),
          ior: surfaceScalar(material, 'iorNode', material.ior),
          thickness: surfaceScalar(material, 'thicknessNode', material.thickness),
          attenuationColor: surfaceRgb(material, 'attenuationColorNode', material.attenuationColor),
          // An absent native attenuation distance disables absorption, matching Three's Infinity.
          ...(attenuationDistance === Infinity ? {} : { attenuationDistance }),
        }
      : {}),
  };
}

/** r187 WebGPU infers flat shading when the geometry has no normal attribute. */
export function usesFlatShading(material: Material, hasNormal = true): boolean {
  return (
    !(
      isBasicMaterial(material) ||
      isLineMaterial(material) ||
      isPointsMaterial(material) ||
      isSpriteMaterial(material)
    ) &&
    (!hasNormal || ('flatShading' in material && material.flatShading === true))
  );
}

export function materialValues(material: SupportedMaterial): unknown[] {
  return [
    material.version,
    material.type,
    material.transparent,
    boundSurfaceRoot(material, 'alphaTestNode') ? 1 : material.alphaTest,
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
    'fog' in material ? material.fog : undefined,
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
    ...threeSurfaceRevisions(material),
  ];
}

function projectFog(material: Material): { readonly fog?: false } {
  return 'fog' in material && material.fog === false ? { fog: false } : {};
}

function projectSurfaceState(material: SupportedMaterial): Result<MaterialRenderState, Error> {
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
  return ok(renderState);
}

function surfaceAlphaMode(material: SupportedMaterial): 'opaque' | 'premultiplied' | 'preserve' {
  if (!material.transparent && material.blending === NormalBlending && !material.alphaToCoverage)
    return 'opaque';
  return material.premultipliedAlpha ? 'premultiplied' : 'preserve';
}

function projectSurface(
  material: SupportedMaterial,
  textures: Readonly<Record<string, MaterialTextureValue>>,
  flatShading: boolean,
  planarReflection: boolean,
): Result<MaterialAsset, Error> {
  const state = projectSurfaceState(material);
  if (!state.ok) return state;
  const renderState = state.value;
  const values = surfaceValues(material);
  const opts = {
    renderState,
    queue: material.transparent || usesTransmission(material) ? 3000 : 2000,
    alphaCutoff: boundSurfaceRoot(material, 'alphaTestNode') ? 1 : material.alphaTest,
    // r187 MaterialNode.OPACITY converts its texture expression to float (red).
    alphaChannel: 0,
    alphaHash: material.alphaHash,
    shadowAlphaMode: 'texture' as const,
    alphaMode: surfaceAlphaMode(material),
  };
  try {
    if (isNormalMaterial(material))
      return ok(Materials.normal({ ...opts, opacity: material.opacity, encoding: 'display' }));
    if (isMatcapMaterial(material))
      return projectMatcap(material, textures, { ...opts, color: values.baseColor });
    if (
      isBasicMaterial(material) ||
      isLineMaterial(material) ||
      isPointsMaterial(material) ||
      isSpriteMaterial(material)
    )
      return ok(
        hasSurfaceBinding(material)
          ? Materials.standard({ ...opts, baseColor: values.baseColor, specular: 0, ...textures })
          : Materials.unlit(values.baseColor, { ...opts, ...textures }),
      );
    const options = {
      ...values,
      flatShading,
      ...opts,
      ...textures,
      ...(isPhysicalMaterial(material)
        ? { staticSwitches: { clearcoat: true, sheen: true, anisotropy: true, iridescence: true } }
        : {}),
    };
    return ok(
      isLambertMaterial(material)
        ? Materials.lambert(options)
        : Materials.standard({ ...options, ...(planarReflection ? { planarReflection } : {}) }),
    );
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

/** Matcap keeps its sphere image and independent coverage binding in one native layout. */
function projectMatcap(
  source: MeshMatcapMaterial,
  textures: Readonly<Record<string, MaterialTextureValue>>,
  options: NonNullable<Parameters<typeof Materials.matcap>[1]>,
): Result<MaterialAsset, Error> {
  if (textures.baseColorTexture === undefined)
    return unsupported('MeshMatcapMaterial default procedural matcap', source.uuid);
  return ok(
    Materials.matcap(textures.baseColorTexture, {
      ...options,
      ...(textures.alphaTexture === undefined ? {} : { alphaTexture: textures.alphaTexture }),
    }),
  );
}

/** Three owns its shadow-side defaults independently of native caster policy. */
function shadowCullMode(
  material: SupportedMaterial,
  varianceShadow: boolean,
): NonNullable<MaterialRenderState['cullMode']> {
  let side = material.shadowSide ?? material.side;
  if (material.shadowSide === null && !varianceShadow) {
    if (side === FrontSide) side = BackSide;
    else if (side === BackSide) side = FrontSide;
  }
  return side === DoubleSide ? 'none' : side === BackSide ? 'front' : 'back';
}

/** WebGPU output conversion belongs to the camera's finishing pass. */
export function projectMaterial(
  material: SupportedMaterial,
  textures: Readonly<Record<string, MaterialTextureValue>>,
  flatShading = usesFlatShading(material),
  varianceShadow = false,
  planarReflection = false,
): Result<MaterialAsset, Error> {
  const projected = projectSurface(material, textures, flatShading, planarReflection);
  if (!projected.ok || projected.value.passes === undefined) return projected;
  const passes = projected.value.passes.flatMap((pass) => {
    const shadow = pass.name === 'shadow-caster';
    const state = {
      ...pass.renderState,
      ...(material.stencilWrite ? { stencilReference: material.stencilRef } : {}),
      ...(shadow ? { cullMode: shadowCullMode(material, varianceShadow) } : {}),
    };
    if (
      isPhysicalMaterial(material) &&
      usesTransmission(material) &&
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
  try {
    return ok(
      projectThreeSurface(material, { ...projected.value, passes: [first, ...rest] }, textures),
    );
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}
