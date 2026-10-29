export interface GltfTextureIr {
  readonly sampler?: number;
  readonly source: number;
  readonly name?: string;
}

export interface GltfSamplerIr {
  readonly magFilter?: number;
  readonly minFilter?: number;
  readonly wrapS: number;
  readonly wrapT: number;
  readonly name?: string;
}

export interface GltfTextureTransformIr {
  readonly offset?: readonly [number, number];
  readonly rotation?: number;
  readonly scale?: readonly [number, number];
}

export interface GltfTextureInfoIr {
  readonly texture: number;
  readonly sampler?: number;
  readonly texCoord?: number;
  readonly transform?: GltfTextureTransformIr;
}

export interface GltfNormalTextureInfoIr extends GltfTextureInfoIr {
  readonly scale?: number;
}

export interface GltfOcclusionTextureInfoIr extends GltfTextureInfoIr {
  readonly strength?: number;
}

export interface TextureTransformJson {
  readonly offset?: readonly number[];
  readonly rotation?: number;
  readonly scale?: readonly number[];
  readonly texCoord?: number;
}

export interface TextureInfoJson {
  readonly index: number;
  readonly texCoord?: number;
  readonly extensions?: {
    readonly KHR_texture_transform?: TextureTransformJson;
  };
}

export interface NormalTextureInfoJson extends TextureInfoJson {
  readonly scale?: number;
}

export interface OcclusionTextureInfoJson extends TextureInfoJson {
  readonly strength?: number;
}

export interface GltfMaterialJson {
  readonly name?: string;
  readonly pbrMetallicRoughness?: {
    readonly baseColorFactor?: readonly number[];
    readonly baseColorTexture?: TextureInfoJson;
    readonly metallicFactor?: number;
    readonly roughnessFactor?: number;
    readonly metallicRoughnessTexture?: TextureInfoJson;
  };
  readonly normalTexture?: NormalTextureInfoJson;
  readonly emissiveFactor?: readonly number[];
  readonly emissiveTexture?: TextureInfoJson;
  readonly occlusionTexture?: OcclusionTextureInfoJson;
  readonly alphaMode?: string;
  readonly alphaCutoff?: number;
  readonly doubleSided?: boolean;
  readonly extensions?: {
    readonly KHR_materials_unlit?: Record<string, never>;
    readonly KHR_materials_emissive_strength?: { readonly emissiveStrength?: number };
    readonly KHR_materials_transmission?: {
      readonly transmissionFactor?: number;
      readonly transmissionTexture?: TextureInfoJson;
    };
    readonly KHR_materials_ior?: {
      readonly ior?: number;
    };
    readonly KHR_materials_volume?: {
      readonly thicknessFactor?: number;
      readonly thicknessTexture?: TextureInfoJson;
      readonly attenuationColor?: readonly number[];
      readonly attenuationDistance?: number;
    };
    readonly KHR_materials_clearcoat?: {
      readonly clearcoatFactor?: number;
      readonly clearcoatTexture?: TextureInfoJson;
      readonly clearcoatRoughnessFactor?: number;
      readonly clearcoatRoughnessTexture?: TextureInfoJson;
      readonly clearcoatNormalTexture?: NormalTextureInfoJson;
    };
    readonly KHR_materials_anisotropy?: {
      readonly anisotropyStrength?: number;
      readonly anisotropyRotation?: number;
      readonly anisotropyTexture?: TextureInfoJson;
    };
    readonly KHR_materials_sheen?: {
      readonly sheenColorFactor?: readonly number[];
      readonly sheenColorTexture?: TextureInfoJson;
      readonly sheenRoughnessFactor?: number;
      readonly sheenRoughnessTexture?: TextureInfoJson;
    };
    readonly KHR_materials_iridescence?: {
      readonly iridescenceFactor?: number;
      readonly iridescenceIor?: number;
      readonly iridescenceThicknessMinimum?: number;
      readonly iridescenceThicknessMaximum?: number;
      readonly iridescenceTexture?: TextureInfoJson;
      readonly iridescenceThicknessTexture?: TextureInfoJson;
    };
    readonly KHR_materials_specular?: {
      readonly specularFactor?: number;
      readonly specularTexture?: TextureInfoJson;
      readonly specularColorFactor?: readonly number[];
      readonly specularColorTexture?: TextureInfoJson;
    };
    readonly KHR_materials_diffuse_transmission?: {
      readonly diffuseTransmissionFactor?: number;
      readonly diffuseTransmissionTexture?: TextureInfoJson;
      readonly diffuseTransmissionColorFactor?: readonly number[];
      readonly diffuseTransmissionColorTexture?: TextureInfoJson;
    };
  };
}

export interface GltfMaterialIr {
  readonly name?: string;
  readonly baseColorFactor: readonly [number, number, number, number];
  /** glTF emissiveFactor; omitted means the glTF default [0, 0, 0]. */
  readonly emissiveFactor?: readonly [number, number, number];
  readonly emissiveStrength?: number;
  readonly unlit?: boolean;
  readonly baseColorTexture?: GltfTextureInfoIr | number;
  readonly emissiveTexture?: GltfTextureInfoIr | number;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly metallicRoughnessTexture?: GltfTextureInfoIr | number;
  readonly normalTexture?: GltfNormalTextureInfoIr | number;
  readonly occlusionTexture?: GltfOcclusionTextureInfoIr | number;
  readonly transmissionFactor?: number;
  readonly transmissionTexture?: GltfTextureInfoIr | number;
  /** KHR_materials_transmission uses the red texture channel. */
  readonly transmissionChannel?: number;
  readonly ior?: number;
  readonly thicknessFactor?: number;
  readonly thicknessTexture?: GltfTextureInfoIr | number;
  /** KHR_materials_volume uses the green texture channel. */
  readonly thicknessChannel?: number;
  readonly attenuationColor?: readonly [number, number, number];
  readonly attenuationDistance?: number;
  readonly clearcoatFactor?: number;
  readonly clearcoatChannel?: number;
  readonly clearcoatTexture?: GltfTextureInfoIr | number;
  readonly clearcoatRoughnessFactor?: number;
  readonly clearcoatRoughnessChannel?: number;
  readonly clearcoatRoughnessTexture?: GltfTextureInfoIr | number;
  readonly clearcoatNormalTexture?: GltfNormalTextureInfoIr | number;
  readonly clearcoatNormalChannel?: readonly [number, number];
  readonly anisotropyStrength?: number;
  readonly anisotropyRotation?: number;
  readonly anisotropyTexture?: GltfTextureInfoIr | number;
  /** KHR_materials_anisotropy uses RG direction and B strength. */
  readonly anisotropyChannel?: readonly [number, number, number];
  readonly sheenColorFactor?: readonly [number, number, number];
  readonly sheenColorTexture?: GltfTextureInfoIr | number;
  readonly sheenColorChannel?: readonly [number, number, number];
  readonly sheenRoughnessFactor?: number;
  readonly sheenRoughnessTexture?: GltfTextureInfoIr | number;
  readonly sheenRoughnessChannel?: number;
  readonly iridescenceFactor?: number;
  readonly iridescenceIor?: number;
  readonly iridescenceThicknessMinimum?: number;
  readonly iridescenceThicknessMaximum?: number;
  readonly iridescenceTexture?: GltfTextureInfoIr | number;
  readonly iridescenceChannel?: number;
  readonly iridescenceThicknessTexture?: GltfTextureInfoIr | number;
  readonly iridescenceThicknessChannel?: number;
  readonly specularFactor?: number;
  readonly specularTexture?: GltfTextureInfoIr | number;
  /** KHR_materials_specular specularTexture uses the alpha channel. */
  readonly specularChannel?: number;
  readonly specularColorFactor?: readonly [number, number, number];
  readonly specularColorTexture?: GltfTextureInfoIr | number;
  readonly specularColorChannel?: readonly [number, number, number];
  readonly diffuseTransmissionFactor?: number;
  /** KHR_materials_diffuse_transmission diffuseTransmissionTexture uses the alpha channel. */
  readonly diffuseTransmissionTexture?: GltfTextureInfoIr | number;
  readonly diffuseTransmissionColorFactor?: readonly [number, number, number];
  /** Linear-light RGB after sRGB decode. */
  readonly diffuseTransmissionColorTexture?: GltfTextureInfoIr | number;
  readonly alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly alphaCutoff?: number;
  readonly doubleSided?: boolean;
  readonly baseColorTexCoord?: number;
}

/**
 * Every texture-bearing slot of {@link GltfMaterialIr}, in the order material
 * values, pack refs and their ref-index rewrite share.
 */
export const GLTF_MATERIAL_TEXTURE_SLOTS = [
  { slot: 'baseColorTexture', colorSpace: 'srgb' },
  { slot: 'metallicRoughnessTexture', colorSpace: 'linear' },
  { slot: 'normalTexture', colorSpace: 'linear' },
  { slot: 'occlusionTexture', colorSpace: 'linear' },
  { slot: 'emissiveTexture', colorSpace: 'srgb' },
  { slot: 'transmissionTexture', colorSpace: 'linear' },
  { slot: 'thicknessTexture', colorSpace: 'linear' },
  { slot: 'clearcoatTexture', colorSpace: 'linear' },
  { slot: 'clearcoatRoughnessTexture', colorSpace: 'linear' },
  { slot: 'clearcoatNormalTexture', colorSpace: 'linear' },
  { slot: 'anisotropyTexture', colorSpace: 'linear' },
  { slot: 'sheenColorTexture', colorSpace: 'srgb' },
  { slot: 'sheenRoughnessTexture', colorSpace: 'linear' },
  { slot: 'iridescenceTexture', colorSpace: 'linear' },
  { slot: 'iridescenceThicknessTexture', colorSpace: 'linear' },
  { slot: 'specularTexture', colorSpace: 'linear' },
  { slot: 'specularColorTexture', colorSpace: 'srgb' },
  { slot: 'diffuseTransmissionTexture', colorSpace: 'linear' },
  { slot: 'diffuseTransmissionColorTexture', colorSpace: 'srgb' },
] as const satisfies readonly {
  readonly slot: keyof GltfMaterialIr;
  readonly colorSpace: 'srgb' | 'linear';
}[];

export type GltfMaterialTextureSlot = (typeof GLTF_MATERIAL_TEXTURE_SLOTS)[number]['slot'];

/** Normalize a slot binding; the bare-number form names only the texture. */
export function materialTextureBinding(
  info: GltfTextureInfoIr | number | undefined,
): GltfTextureInfoIr | undefined {
  return info === undefined ? undefined : typeof info === 'number' ? { texture: info } : info;
}

function tuple2(values: readonly number[] | undefined): readonly [number, number] | undefined {
  if (values === undefined || values.length < 2) return undefined;
  return [values[0] ?? 0, values[1] ?? 0];
}

function tuple3(
  values: readonly number[] | undefined,
): readonly [number, number, number] | undefined {
  if (values === undefined || values.length < 3) return undefined;
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}

function parseTextureInfo(
  info: TextureInfoJson,
  textures: readonly GltfTextureIr[],
): GltfTextureInfoIr {
  const transformJson = info.extensions?.KHR_texture_transform;
  const offset = tuple2(transformJson?.offset);
  const scale = tuple2(transformJson?.scale);
  const transform =
    offset === undefined && transformJson?.rotation === undefined && scale === undefined
      ? undefined
      : {
          ...(offset === undefined ? {} : { offset }),
          ...(transformJson?.rotation === undefined ? {} : { rotation: transformJson.rotation }),
          ...(scale === undefined ? {} : { scale }),
        };
  const sampler = textures[info.index]?.sampler;
  return {
    texture: info.index,
    ...(sampler === undefined ? {} : { sampler }),
    ...(info.texCoord === undefined && transformJson?.texCoord === undefined
      ? {}
      : { texCoord: transformJson?.texCoord ?? info.texCoord }),
    ...(transform === undefined ? {} : { transform }),
  };
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

type TransmissionExtension = GltfMaterialTransmissionInvalidDetail['extension'];
type PhysicalExtension = GltfMaterialPhysicalInvalidDetail['extension'];
type MaterialExtensionsJson = NonNullable<GltfMaterialJson['extensions']>;
type AlphaMode = NonNullable<GltfMaterialIr['alphaMode']>;
type AlphaFields = Pick<GltfMaterialIr, 'alphaMode' | 'alphaCutoff'>;

function transmissionInvalid(
  extension: TransmissionExtension,
  field: string,
  reason: GltfMaterialTransmissionInvalidDetail['reason'],
  actual?: unknown,
): GltfError {
  return gltfErr('gltf-material-transmission-invalid', {
    extension,
    field,
    reason,
    ...(actual === undefined ? {} : { actual }),
  });
}

function physicalInvalid(
  extension: PhysicalExtension,
  field: string,
  reason: GltfMaterialPhysicalInvalidDetail['reason'],
  actual?: unknown,
): GltfError {
  return gltfErr('gltf-material-physical-invalid', {
    extension,
    field,
    reason,
    ...(actual === undefined ? {} : { actual }),
  });
}

function validateUnit(
  extension: PhysicalExtension,
  field: string,
  value: number | undefined,
): GltfError | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    return physicalInvalid(extension, field, 'non-finite', value);
  if (value < 0 || value > 1) return physicalInvalid(extension, field, 'range', value);
  return undefined;
}

function validateFinite(
  extension: PhysicalExtension,
  field: string,
  value: number | undefined,
  minimum?: number,
): GltfError | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    return physicalInvalid(extension, field, 'non-finite', value);
  if (minimum !== undefined && value < minimum)
    return physicalInvalid(extension, field, 'range', value);
  return undefined;
}

function validateColor(
  extension: PhysicalExtension,
  field: string,
  value: readonly number[] | undefined,
): GltfError | undefined {
  if (value === undefined) return undefined;
  if (
    value.length < 3 ||
    value.slice(0, 3).some((channel) => typeof channel !== 'number' || !Number.isFinite(channel))
  ) {
    return physicalInvalid(extension, field, 'type', value);
  }
  if (value.slice(0, 3).some((channel) => channel < 0 || channel > 1)) {
    return physicalInvalid(extension, field, 'range', value);
  }
  return undefined;
}

function validateTransmission(
  transmission: MaterialExtensionsJson['KHR_materials_transmission'],
): GltfError | undefined {
  const factor = transmission?.transmissionFactor;
  if (factor === undefined) return undefined;
  if (typeof factor !== 'number' || !Number.isFinite(factor))
    return transmissionInvalid(
      'KHR_materials_transmission',
      'transmissionFactor',
      'non-finite',
      factor,
    );
  if (factor < 0 || factor > 1)
    return transmissionInvalid('KHR_materials_transmission', 'transmissionFactor', 'range', factor);
  return undefined;
}

function validateIor(ior: MaterialExtensionsJson['KHR_materials_ior']): GltfError | undefined {
  const value = ior?.ior;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    return transmissionInvalid('KHR_materials_ior', 'ior', 'non-finite', value);
  if (value < 1) return transmissionInvalid('KHR_materials_ior', 'ior', 'range', value);
  return undefined;
}

function validateVolume(
  volume: MaterialExtensionsJson['KHR_materials_volume'],
): GltfError | undefined {
  if (volume === undefined) return undefined;
  const { thicknessFactor, attenuationDistance } = volume;
  if (thicknessFactor !== undefined && !Number.isFinite(thicknessFactor))
    return transmissionInvalid(
      'KHR_materials_volume',
      'thicknessFactor',
      'non-finite',
      thicknessFactor,
    );
  if (thicknessFactor !== undefined && thicknessFactor < 0)
    return transmissionInvalid('KHR_materials_volume', 'thicknessFactor', 'range', thicknessFactor);
  const attenuationColor = tuple3(volume.attenuationColor);
  if (
    volume.attenuationColor !== undefined &&
    (attenuationColor === undefined ||
      attenuationColor.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
  ) {
    return transmissionInvalid(
      'KHR_materials_volume',
      'attenuationColor',
      'range',
      volume.attenuationColor,
    );
  }
  return validateAttenuationDistance(attenuationDistance);
}

function validateAttenuationDistance(distance: number | undefined): GltfError | undefined {
  if (distance === undefined) return undefined;
  if (!Number.isFinite(distance) && distance !== Number.POSITIVE_INFINITY)
    return transmissionInvalid(
      'KHR_materials_volume',
      'attenuationDistance',
      'non-finite',
      distance,
    );
  if (Number.isFinite(distance) && distance <= 0)
    return transmissionInvalid('KHR_materials_volume', 'attenuationDistance', 'range', distance);
  return undefined;
}

function validateTransmissionBlend(
  transmission: MaterialExtensionsJson['KHR_materials_transmission'],
  alphaMode: AlphaMode | undefined,
): GltfError | undefined {
  if (alphaMode === 'BLEND' && (transmission?.transmissionFactor ?? 0) > 0)
    return transmissionInvalid('KHR_materials_transmission', 'alphaMode', 'blend', alphaMode);
  return undefined;
}

function validateClearcoat(
  clearcoat: MaterialExtensionsJson['KHR_materials_clearcoat'],
): GltfError | undefined {
  const scale = clearcoat?.clearcoatNormalTexture?.scale;
  return (
    validateUnit('KHR_materials_clearcoat', 'clearcoatFactor', clearcoat?.clearcoatFactor) ??
    validateUnit(
      'KHR_materials_clearcoat',
      'clearcoatRoughnessFactor',
      clearcoat?.clearcoatRoughnessFactor,
    ) ??
    (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0)
      ? physicalInvalid('KHR_materials_clearcoat', 'clearcoatNormalTexture.scale', 'range', scale)
      : undefined)
  );
}

function validateSurfaceLobes(extensions: MaterialExtensionsJson): GltfError | undefined {
  const anisotropy = extensions.KHR_materials_anisotropy;
  const sheen = extensions.KHR_materials_sheen;
  const iridescence = extensions.KHR_materials_iridescence;
  return (
    validateUnit(
      'KHR_materials_anisotropy',
      'anisotropyStrength',
      anisotropy?.anisotropyStrength,
    ) ??
    validateFinite(
      'KHR_materials_anisotropy',
      'anisotropyRotation',
      anisotropy?.anisotropyRotation,
    ) ??
    validateUnit('KHR_materials_sheen', 'sheenRoughnessFactor', sheen?.sheenRoughnessFactor) ??
    validateColor('KHR_materials_sheen', 'sheenColorFactor', sheen?.sheenColorFactor) ??
    validateUnit(
      'KHR_materials_iridescence',
      'iridescenceFactor',
      iridescence?.iridescenceFactor,
    ) ??
    validateFinite('KHR_materials_iridescence', 'iridescenceIor', iridescence?.iridescenceIor, 1) ??
    validateFinite(
      'KHR_materials_iridescence',
      'iridescenceThicknessMinimum',
      iridescence?.iridescenceThicknessMinimum,
      0,
    ) ??
    validateFinite(
      'KHR_materials_iridescence',
      'iridescenceThicknessMaximum',
      iridescence?.iridescenceThicknessMaximum,
      0,
    )
  );
}

function validateSpecularLobes(extensions: MaterialExtensionsJson): GltfError | undefined {
  const specular = extensions.KHR_materials_specular;
  const diffuseTransmission = extensions.KHR_materials_diffuse_transmission;
  return (
    validateUnit('KHR_materials_specular', 'specularFactor', specular?.specularFactor) ??
    validateColor('KHR_materials_specular', 'specularColorFactor', specular?.specularColorFactor) ??
    validateUnit(
      'KHR_materials_diffuse_transmission',
      'diffuseTransmissionFactor',
      diffuseTransmission?.diffuseTransmissionFactor,
    ) ??
    validateColor(
      'KHR_materials_diffuse_transmission',
      'diffuseTransmissionColorFactor',
      diffuseTransmission?.diffuseTransmissionColorFactor,
    )
  );
}

function validateEmissiveStrength(strength: number | undefined): GltfError | undefined {
  if (
    strength !== undefined &&
    (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0)
  )
    return physicalInvalid(
      'KHR_materials_emissive_strength',
      'emissiveStrength',
      'range',
      strength,
    );
  return undefined;
}

/** Validation order is the error precedence: first failing field wins. */
function validateMaterialExtensions(
  extensions: MaterialExtensionsJson | undefined,
  alphaMode: AlphaMode | undefined,
): GltfError | undefined {
  if (extensions === undefined) return undefined;
  return (
    validateTransmission(extensions.KHR_materials_transmission) ??
    validateIor(extensions.KHR_materials_ior) ??
    validateVolume(extensions.KHR_materials_volume) ??
    validateTransmissionBlend(extensions.KHR_materials_transmission, alphaMode) ??
    validateClearcoat(extensions.KHR_materials_clearcoat) ??
    validateSurfaceLobes(extensions) ??
    validateSpecularLobes(extensions) ??
    validateEmissiveStrength(extensions.KHR_materials_emissive_strength?.emissiveStrength)
  );
}

function baseColorFactorOf(
  factor: readonly number[] | undefined,
): readonly [number, number, number, number] {
  const baseColor = factor ?? [1, 1, 1, 1];
  return [baseColor[0] ?? 1, baseColor[1] ?? 1, baseColor[2] ?? 1, baseColor[3] ?? 1];
}

function alphaFields(matJson: GltfMaterialJson): AlphaFields {
  const alphaMode =
    matJson.alphaMode === 'MASK' || matJson.alphaMode === 'BLEND' ? matJson.alphaMode : undefined;
  const alphaCutoff = alphaMode === 'MASK' ? (matJson.alphaCutoff ?? 0.5) : undefined;
  return {
    ...(alphaMode === undefined ? {} : { alphaMode }),
    ...(alphaCutoff === undefined ? {} : { alphaCutoff }),
  };
}

function normalTextureInfo(
  info: NormalTextureInfoJson,
  textures: readonly GltfTextureIr[],
): GltfNormalTextureInfoIr {
  return {
    ...parseTextureInfo(info, textures),
    ...(info.scale === undefined ? {} : { scale: info.scale }),
  };
}

function unlitMaterial(
  matJson: GltfMaterialJson,
  textures: readonly GltfTextureIr[],
  baseColorFactor: readonly [number, number, number, number],
  alpha: AlphaFields,
): GltfMaterialIr {
  const baseColorTexture = matJson.pbrMetallicRoughness?.baseColorTexture;
  return {
    ...(matJson.name === undefined ? {} : { name: matJson.name }),
    unlit: true,
    baseColorFactor,
    metallicFactor: 0,
    roughnessFactor: 1,
    ...(baseColorTexture === undefined
      ? {}
      : { baseColorTexture: parseTextureInfo(baseColorTexture, textures) }),
    ...alpha,
    ...(matJson.doubleSided === undefined ? {} : { doubleSided: matJson.doubleSided }),
  };
}

function coreTextureFields(
  matJson: GltfMaterialJson,
  textures: readonly GltfTextureIr[],
): Partial<GltfMaterialIr> {
  const pbr = matJson.pbrMetallicRoughness;
  return {
    ...(pbr?.baseColorTexture === undefined
      ? {}
      : { baseColorTexture: parseTextureInfo(pbr.baseColorTexture, textures) }),
    ...(pbr?.metallicRoughnessTexture === undefined
      ? {}
      : { metallicRoughnessTexture: parseTextureInfo(pbr.metallicRoughnessTexture, textures) }),
    ...(matJson.normalTexture === undefined
      ? {}
      : { normalTexture: normalTextureInfo(matJson.normalTexture, textures) }),
    ...(matJson.occlusionTexture === undefined
      ? {}
      : {
          occlusionTexture: {
            ...parseTextureInfo(matJson.occlusionTexture, textures),
            ...(matJson.occlusionTexture.strength === undefined
              ? {}
              : { strength: matJson.occlusionTexture.strength }),
          },
        }),
    ...(matJson.emissiveTexture === undefined
      ? {}
      : { emissiveTexture: parseTextureInfo(matJson.emissiveTexture, textures) }),
  };
}

function transmissionFields(
  transmission: MaterialExtensionsJson['KHR_materials_transmission'],
  textures: readonly GltfTextureIr[],
): Partial<GltfMaterialIr> {
  if (transmission === undefined) return {};
  return {
    transmissionFactor: transmission.transmissionFactor ?? 0,
    transmissionChannel: 0,
    ...(transmission.transmissionTexture === undefined
      ? {}
      : { transmissionTexture: parseTextureInfo(transmission.transmissionTexture, textures) }),
  };
}

function volumeFields(
  volume: MaterialExtensionsJson['KHR_materials_volume'],
  textures: readonly GltfTextureIr[],
): Partial<GltfMaterialIr> {
  if (volume === undefined) return {};
  const attenuationColor = tuple3(volume.attenuationColor);
  return {
    thicknessFactor: volume.thicknessFactor ?? 0,
    thicknessChannel: 1,
    ...(volume.thicknessTexture === undefined
      ? {}
      : { thicknessTexture: parseTextureInfo(volume.thicknessTexture, textures) }),
    ...(attenuationColor === undefined ? {} : { attenuationColor }),
    ...(finiteOrUndefined(volume.attenuationDistance) === undefined
      ? {}
      : { attenuationDistance: volume.attenuationDistance }),
  };
}

function clearcoatFields(
  clearcoat: MaterialExtensionsJson['KHR_materials_clearcoat'],
  textures: readonly GltfTextureIr[],
): Partial<GltfMaterialIr> {
  if (clearcoat === undefined) return {};
  return {
    clearcoatFactor: clearcoat.clearcoatFactor ?? 0,
    clearcoatChannel: 0,
    clearcoatRoughnessFactor: clearcoat.clearcoatRoughnessFactor ?? 0,
    clearcoatRoughnessChannel: 1,
    clearcoatNormalChannel: [0, 1] as const,
    ...(clearcoat.clearcoatTexture === undefined
      ? {}
      : { clearcoatTexture: parseTextureInfo(clearcoat.clearcoatTexture, textures) }),
    ...(clearcoat.clearcoatRoughnessTexture === undefined
      ? {}
      : {
          clearcoatRoughnessTexture: parseTextureInfo(
            clearcoat.clearcoatRoughnessTexture,
            textures,
          ),
        }),
    ...(clearcoat.clearcoatNormalTexture === undefined
      ? {}
      : { clearcoatNormalTexture: normalTextureInfo(clearcoat.clearcoatNormalTexture, textures) }),
  };
}

function anisotropyFields(
  anisotropy: MaterialExtensionsJson['KHR_materials_anisotropy'],
  textures: readonly GltfTextureIr[],
): Partial<GltfMaterialIr> {
  if (anisotropy === undefined) return {};
  return {
    anisotropyStrength: anisotropy.anisotropyStrength ?? 0,
    anisotropyRotation: anisotropy.anisotropyRotation ?? 0,
    anisotropyChannel: [0, 1, 2] as const,
    ...(anisotropy.anisotropyTexture === undefined
      ? {}
      : { anisotropyTexture: parseTextureInfo(anisotropy.anisotropyTexture, textures) }),
  };
}

function sheenFields(
  sheen: MaterialExtensionsJson['KHR_materials_sheen'],
  textures: readonly GltfTextureIr[],
): Partial<GltfMaterialIr> {
  if (sheen === undefined) return {};
  return {
    sheenColorFactor: tuple3(sheen.sheenColorFactor) ?? [0, 0, 0],
    sheenColorChannel: [0, 1, 2] as const,
    sheenRoughnessFactor: sheen.sheenRoughnessFactor ?? 0,
    sheenRoughnessChannel: 3,
    ...(sheen.sheenColorTexture === undefined
      ? {}
      : { sheenColorTexture: parseTextureInfo(sheen.sheenColorTexture, textures) }),
    ...(sheen.sheenRoughnessTexture === undefined
      ? {}
      : { sheenRoughnessTexture: parseTextureInfo(sheen.sheenRoughnessTexture, textures) }),
  };
}

function iridescenceFields(
  iridescence: MaterialExtensionsJson['KHR_materials_iridescence'],
  textures: readonly GltfTextureIr[],
): Partial<GltfMaterialIr> {
  if (iridescence === undefined) return {};
  return {
    iridescenceFactor: iridescence.iridescenceFactor ?? 0,
    iridescenceIor: iridescence.iridescenceIor ?? 1.3,
    iridescenceThicknessMinimum: iridescence.iridescenceThicknessMinimum ?? 100,
    iridescenceThicknessMaximum: iridescence.iridescenceThicknessMaximum ?? 400,
    iridescenceChannel: 0,
    iridescenceThicknessChannel: 1,
    ...(iridescence.iridescenceTexture === undefined
      ? {}
      : { iridescenceTexture: parseTextureInfo(iridescence.iridescenceTexture, textures) }),
    ...(iridescence.iridescenceThicknessTexture === undefined
      ? {}
      : {
          iridescenceThicknessTexture: parseTextureInfo(
            iridescence.iridescenceThicknessTexture,
            textures,
          ),
        }),
  };
}

function specularFields(
  specular: MaterialExtensionsJson['KHR_materials_specular'],
  textures: readonly GltfTextureIr[],
): Partial<GltfMaterialIr> {
  if (specular === undefined) return {};
  return {
    specularFactor: specular.specularFactor ?? 1,
    specularChannel: 3,
    specularColorFactor: tuple3(specular.specularColorFactor) ?? [1, 1, 1],
    specularColorChannel: [0, 1, 2] as const,
    ...(specular.specularTexture === undefined
      ? {}
      : { specularTexture: parseTextureInfo(specular.specularTexture, textures) }),
    ...(specular.specularColorTexture === undefined
      ? {}
      : { specularColorTexture: parseTextureInfo(specular.specularColorTexture, textures) }),
  };
}

function diffuseTransmissionFields(
  diffuseTransmission: MaterialExtensionsJson['KHR_materials_diffuse_transmission'],
  textures: readonly GltfTextureIr[],
): Partial<GltfMaterialIr> {
  if (diffuseTransmission === undefined) return {};
  return {
    diffuseTransmissionFactor: diffuseTransmission.diffuseTransmissionFactor ?? 0,
    diffuseTransmissionColorFactor: tuple3(diffuseTransmission.diffuseTransmissionColorFactor) ?? [
      1, 1, 1,
    ],
    ...(diffuseTransmission.diffuseTransmissionTexture === undefined
      ? {}
      : {
          diffuseTransmissionTexture: parseTextureInfo(
            diffuseTransmission.diffuseTransmissionTexture,
            textures,
          ),
        }),
    ...(diffuseTransmission.diffuseTransmissionColorTexture === undefined
      ? {}
      : {
          diffuseTransmissionColorTexture: parseTextureInfo(
            diffuseTransmission.diffuseTransmissionColorTexture,
            textures,
          ),
        }),
  };
}

export function parseMaterial(
  matJson: GltfMaterialJson,
  textures: readonly GltfTextureIr[],
): Result<GltfMaterialIr, GltfError> {
  const pbr = matJson.pbrMetallicRoughness;
  const baseColorFactor = baseColorFactorOf(pbr?.baseColorFactor);
  const alpha = alphaFields(matJson);
  const extensions = matJson.extensions;
  if (extensions?.KHR_materials_unlit !== undefined)
    return ok(unlitMaterial(matJson, textures, baseColorFactor, alpha));
  const invalid = validateMaterialExtensions(extensions, alpha.alphaMode);
  if (invalid !== undefined) return err(invalid);
  const emissiveFactor = tuple3(matJson.emissiveFactor);
  const emissiveStrength = extensions?.KHR_materials_emissive_strength?.emissiveStrength;
  const ior = extensions?.KHR_materials_ior;
  const baseColorTexCoord = pbr?.baseColorTexture?.texCoord;
  return ok({
    ...(matJson.name === undefined ? {} : { name: matJson.name }),
    baseColorFactor,
    ...(emissiveFactor === undefined ? {} : { emissiveFactor }),
    ...(emissiveStrength === undefined ? {} : { emissiveStrength }),
    metallicFactor: pbr?.metallicFactor ?? 1.0,
    roughnessFactor: pbr?.roughnessFactor ?? 1.0,
    ...coreTextureFields(matJson, textures),
    ...transmissionFields(extensions?.KHR_materials_transmission, textures),
    ...(ior === undefined ? {} : { ior: ior.ior ?? 1.5 }),
    ...volumeFields(extensions?.KHR_materials_volume, textures),
    ...clearcoatFields(extensions?.KHR_materials_clearcoat, textures),
    ...anisotropyFields(extensions?.KHR_materials_anisotropy, textures),
    ...sheenFields(extensions?.KHR_materials_sheen, textures),
    ...iridescenceFields(extensions?.KHR_materials_iridescence, textures),
    ...specularFields(extensions?.KHR_materials_specular, textures),
    ...diffuseTransmissionFields(extensions?.KHR_materials_diffuse_transmission, textures),
    ...alpha,
    ...(matJson.doubleSided === true ? { doubleSided: true } : {}),
    ...(baseColorTexCoord === undefined || baseColorTexCoord === 0 ? {} : { baseColorTexCoord }),
  });
}

import {
  err,
  type GltfError,
  type GltfMaterialPhysicalInvalidDetail,
  type GltfMaterialTransmissionInvalidDetail,
  gltfErr,
  ok,
  type Result,
} from '../errors.js';
