export interface GltfTextureIr {
  readonly sampler?: number;
  readonly source: number;
  readonly name?: string;
}

export interface GltfImageIr {
  readonly uri?: string;
  readonly mimeType?: string;
  readonly bufferView?: number;
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
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
  'transmissionTexture',
  'thicknessTexture',
  'clearcoatTexture',
  'clearcoatRoughnessTexture',
  'clearcoatNormalTexture',
  'anisotropyTexture',
  'sheenColorTexture',
  'sheenRoughnessTexture',
  'iridescenceTexture',
  'iridescenceThicknessTexture',
  'specularTexture',
  'specularColorTexture',
  'diffuseTransmissionTexture',
  'diffuseTransmissionColorTexture',
] as const satisfies readonly (keyof GltfMaterialIr)[];

export type GltfMaterialTextureSlot = (typeof GLTF_MATERIAL_TEXTURE_SLOTS)[number];

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

export function parseTextureInfo(
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

export function parseMaterial(
  matJson: GltfMaterialJson,
  textures: readonly GltfTextureIr[],
): Result<GltfMaterialIr, GltfError> {
  const pbr = matJson.pbrMetallicRoughness;
  const baseColor = pbr?.baseColorFactor ?? [1, 1, 1, 1];
  const baseColor4: readonly [number, number, number, number] = [
    baseColor[0] ?? 1,
    baseColor[1] ?? 1,
    baseColor[2] ?? 1,
    baseColor[3] ?? 1,
  ];
  const alphaMode =
    matJson.alphaMode === 'MASK' || matJson.alphaMode === 'BLEND' ? matJson.alphaMode : undefined;
  const alphaCutoff = alphaMode === 'MASK' ? (matJson.alphaCutoff ?? 0.5) : undefined;
  if (matJson.extensions?.KHR_materials_unlit !== undefined)
    return ok({
      ...(matJson.name === undefined ? {} : { name: matJson.name }),
      unlit: true,
      baseColorFactor: baseColor4,
      metallicFactor: 0,
      roughnessFactor: 1,
      ...(pbr?.baseColorTexture === undefined
        ? {}
        : { baseColorTexture: parseTextureInfo(pbr.baseColorTexture, textures) }),
      ...(alphaMode === undefined ? {} : { alphaMode }),
      ...(alphaCutoff === undefined ? {} : { alphaCutoff }),
      ...(matJson.doubleSided === undefined ? {} : { doubleSided: matJson.doubleSided }),
    });
  const emissiveFactor = tuple3(matJson.emissiveFactor);
  const transmission = matJson.extensions?.KHR_materials_transmission;
  const ior = matJson.extensions?.KHR_materials_ior;
  const volume = matJson.extensions?.KHR_materials_volume;
  const clearcoat = matJson.extensions?.KHR_materials_clearcoat;
  const anisotropy = matJson.extensions?.KHR_materials_anisotropy;
  const sheen = matJson.extensions?.KHR_materials_sheen;
  const iridescence = matJson.extensions?.KHR_materials_iridescence;
  const specular = matJson.extensions?.KHR_materials_specular;
  const diffuseTransmission = matJson.extensions?.KHR_materials_diffuse_transmission;
  const attenuationColor = tuple3(volume?.attenuationColor);
  const invalid = (
    extension: 'KHR_materials_transmission' | 'KHR_materials_ior' | 'KHR_materials_volume',
    field: string,
    reason: 'type' | 'range' | 'non-finite' | 'blend',
    actual?: unknown,
  ): Result<GltfMaterialIr, GltfError> =>
    err(
      gltfErr('gltf-material-transmission-invalid', {
        extension,
        field,
        reason,
        ...(actual === undefined ? {} : { actual }),
      }),
    );
  const physicalInvalid = (
    extension:
      | 'KHR_materials_clearcoat'
      | 'KHR_materials_anisotropy'
      | 'KHR_materials_sheen'
      | 'KHR_materials_iridescence'
      | 'KHR_materials_specular'
      | 'KHR_materials_diffuse_transmission'
      | 'KHR_materials_emissive_strength',
    field: string,
    reason: 'type' | 'range' | 'non-finite',
    actual?: unknown,
  ): Result<GltfMaterialIr, GltfError> =>
    err(
      gltfErr('gltf-material-physical-invalid', {
        extension,
        field,
        reason,
        ...(actual === undefined ? {} : { actual }),
      }),
    );
  if (
    transmission?.transmissionFactor !== undefined &&
    (typeof transmission.transmissionFactor !== 'number' ||
      !Number.isFinite(transmission.transmissionFactor))
  ) {
    return invalid(
      'KHR_materials_transmission',
      'transmissionFactor',
      'non-finite',
      transmission.transmissionFactor,
    );
  }
  if (
    transmission?.transmissionFactor !== undefined &&
    (transmission.transmissionFactor < 0 || transmission.transmissionFactor > 1)
  ) {
    return invalid(
      'KHR_materials_transmission',
      'transmissionFactor',
      'range',
      transmission.transmissionFactor,
    );
  }
  if (ior?.ior !== undefined && (typeof ior.ior !== 'number' || !Number.isFinite(ior.ior))) {
    return invalid('KHR_materials_ior', 'ior', 'non-finite', ior.ior);
  }
  if (ior?.ior !== undefined && ior.ior < 1) {
    return invalid('KHR_materials_ior', 'ior', 'range', ior.ior);
  }
  if (volume?.thicknessFactor !== undefined && !Number.isFinite(volume.thicknessFactor)) {
    return invalid('KHR_materials_volume', 'thicknessFactor', 'non-finite', volume.thicknessFactor);
  }
  if (volume?.thicknessFactor !== undefined && volume.thicknessFactor < 0) {
    return invalid('KHR_materials_volume', 'thicknessFactor', 'range', volume.thicknessFactor);
  }
  if (
    volume?.attenuationColor !== undefined &&
    (attenuationColor === undefined ||
      attenuationColor.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
  ) {
    return invalid('KHR_materials_volume', 'attenuationColor', 'range', volume.attenuationColor);
  }
  if (
    volume?.attenuationDistance !== undefined &&
    !Number.isFinite(volume.attenuationDistance) &&
    volume.attenuationDistance !== Number.POSITIVE_INFINITY
  ) {
    return invalid(
      'KHR_materials_volume',
      'attenuationDistance',
      'non-finite',
      volume.attenuationDistance,
    );
  }
  if (
    volume?.attenuationDistance !== undefined &&
    Number.isFinite(volume.attenuationDistance) &&
    volume.attenuationDistance <= 0
  ) {
    return invalid(
      'KHR_materials_volume',
      'attenuationDistance',
      'range',
      volume.attenuationDistance,
    );
  }
  if (alphaMode === 'BLEND' && (transmission?.transmissionFactor ?? 0) > 0) {
    return invalid('KHR_materials_transmission', 'alphaMode', 'blend', alphaMode);
  }
  if (
    clearcoat?.clearcoatFactor !== undefined &&
    (typeof clearcoat.clearcoatFactor !== 'number' || !Number.isFinite(clearcoat.clearcoatFactor))
  ) {
    return physicalInvalid(
      'KHR_materials_clearcoat',
      'clearcoatFactor',
      'non-finite',
      clearcoat.clearcoatFactor,
    );
  }
  if (
    clearcoat?.clearcoatFactor !== undefined &&
    (clearcoat.clearcoatFactor < 0 || clearcoat.clearcoatFactor > 1)
  ) {
    return physicalInvalid(
      'KHR_materials_clearcoat',
      'clearcoatFactor',
      'range',
      clearcoat.clearcoatFactor,
    );
  }
  if (
    clearcoat?.clearcoatRoughnessFactor !== undefined &&
    (typeof clearcoat.clearcoatRoughnessFactor !== 'number' ||
      !Number.isFinite(clearcoat.clearcoatRoughnessFactor))
  ) {
    return physicalInvalid(
      'KHR_materials_clearcoat',
      'clearcoatRoughnessFactor',
      'non-finite',
      clearcoat.clearcoatRoughnessFactor,
    );
  }
  if (
    clearcoat?.clearcoatRoughnessFactor !== undefined &&
    (clearcoat.clearcoatRoughnessFactor < 0 || clearcoat.clearcoatRoughnessFactor > 1)
  ) {
    return physicalInvalid(
      'KHR_materials_clearcoat',
      'clearcoatRoughnessFactor',
      'range',
      clearcoat.clearcoatRoughnessFactor,
    );
  }
  if (
    clearcoat?.clearcoatNormalTexture?.scale !== undefined &&
    (typeof clearcoat.clearcoatNormalTexture.scale !== 'number' ||
      !Number.isFinite(clearcoat.clearcoatNormalTexture.scale) ||
      clearcoat.clearcoatNormalTexture.scale < 0)
  ) {
    return physicalInvalid(
      'KHR_materials_clearcoat',
      'clearcoatNormalTexture.scale',
      'range',
      clearcoat.clearcoatNormalTexture.scale,
    );
  }
  const validateUnit = (
    extension: Parameters<typeof physicalInvalid>[0],
    field: string,
    value: number | undefined,
  ) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value))
      return physicalInvalid(extension, field, 'non-finite', value);
    if (value < 0 || value > 1) return physicalInvalid(extension, field, 'range', value);
    return undefined;
  };
  const validateFinite = (
    extension: Parameters<typeof physicalInvalid>[0],
    field: string,
    value: number | undefined,
    minimum?: number,
  ) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value))
      return physicalInvalid(extension, field, 'non-finite', value);
    if (minimum !== undefined && value < minimum)
      return physicalInvalid(extension, field, 'range', value);
    return undefined;
  };
  const validateColor = (
    extension: Parameters<typeof physicalInvalid>[0],
    field: string,
    value: readonly number[] | undefined,
  ) => {
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
  };
  const physicalChecks = [
    validateUnit('KHR_materials_anisotropy', 'anisotropyStrength', anisotropy?.anisotropyStrength),
    validateFinite(
      'KHR_materials_anisotropy',
      'anisotropyRotation',
      anisotropy?.anisotropyRotation,
    ),
    validateUnit('KHR_materials_sheen', 'sheenRoughnessFactor', sheen?.sheenRoughnessFactor),
    validateColor('KHR_materials_sheen', 'sheenColorFactor', sheen?.sheenColorFactor),
    validateUnit('KHR_materials_iridescence', 'iridescenceFactor', iridescence?.iridescenceFactor),
    validateFinite('KHR_materials_iridescence', 'iridescenceIor', iridescence?.iridescenceIor, 1),
    validateFinite(
      'KHR_materials_iridescence',
      'iridescenceThicknessMinimum',
      iridescence?.iridescenceThicknessMinimum,
      0,
    ),
    validateFinite(
      'KHR_materials_iridescence',
      'iridescenceThicknessMaximum',
      iridescence?.iridescenceThicknessMaximum,
      0,
    ),
    validateUnit('KHR_materials_specular', 'specularFactor', specular?.specularFactor),
    validateColor('KHR_materials_specular', 'specularColorFactor', specular?.specularColorFactor),
    validateUnit(
      'KHR_materials_diffuse_transmission',
      'diffuseTransmissionFactor',
      diffuseTransmission?.diffuseTransmissionFactor,
    ),
    validateColor(
      'KHR_materials_diffuse_transmission',
      'diffuseTransmissionColorFactor',
      diffuseTransmission?.diffuseTransmissionColorFactor,
    ),
  ];
  for (const check of physicalChecks) if (check !== undefined) return check;
  const emissiveStrength = matJson.extensions?.KHR_materials_emissive_strength?.emissiveStrength;
  if (
    emissiveStrength !== undefined &&
    (typeof emissiveStrength !== 'number' ||
      !Number.isFinite(emissiveStrength) ||
      emissiveStrength < 0)
  )
    return physicalInvalid(
      'KHR_materials_emissive_strength',
      'emissiveStrength',
      'range',
      emissiveStrength,
    );
  return ok({
    ...(matJson.name === undefined ? {} : { name: matJson.name }),
    baseColorFactor: baseColor4,
    ...(emissiveFactor === undefined ? {} : { emissiveFactor }),
    ...(emissiveStrength === undefined ? {} : { emissiveStrength }),
    ...(matJson.extensions?.KHR_materials_unlit === undefined ? {} : { unlit: true }),
    metallicFactor: pbr?.metallicFactor ?? 1.0,
    roughnessFactor: pbr?.roughnessFactor ?? 1.0,
    ...(pbr?.baseColorTexture === undefined
      ? {}
      : { baseColorTexture: parseTextureInfo(pbr.baseColorTexture, textures) }),
    ...(pbr?.metallicRoughnessTexture === undefined
      ? {}
      : { metallicRoughnessTexture: parseTextureInfo(pbr.metallicRoughnessTexture, textures) }),
    ...(matJson.normalTexture === undefined
      ? {}
      : {
          normalTexture: {
            ...parseTextureInfo(matJson.normalTexture, textures),
            ...(matJson.normalTexture.scale === undefined
              ? {}
              : { scale: matJson.normalTexture.scale }),
          },
        }),
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
    ...(transmission === undefined
      ? {}
      : {
          transmissionFactor: transmission.transmissionFactor ?? 0,
          transmissionChannel: 0,
          ...(transmission.transmissionTexture === undefined
            ? {}
            : {
                transmissionTexture: parseTextureInfo(transmission.transmissionTexture, textures),
              }),
        }),
    ...(ior === undefined ? {} : { ior: ior.ior ?? 1.5 }),
    ...(volume === undefined
      ? {}
      : {
          thicknessFactor: volume.thicknessFactor ?? 0,
          thicknessChannel: 1,
          ...(volume.thicknessTexture === undefined
            ? {}
            : { thicknessTexture: parseTextureInfo(volume.thicknessTexture, textures) }),
          ...(attenuationColor === undefined ? {} : { attenuationColor }),
          ...(finiteOrUndefined(volume.attenuationDistance) === undefined
            ? {}
            : { attenuationDistance: volume.attenuationDistance }),
        }),
    ...(clearcoat === undefined
      ? {}
      : {
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
            : {
                clearcoatNormalTexture: {
                  ...parseTextureInfo(clearcoat.clearcoatNormalTexture, textures),
                  ...(clearcoat.clearcoatNormalTexture.scale === undefined
                    ? {}
                    : { scale: clearcoat.clearcoatNormalTexture.scale }),
                },
              }),
        }),
    ...(anisotropy === undefined
      ? {}
      : {
          anisotropyStrength: anisotropy.anisotropyStrength ?? 0,
          anisotropyRotation: anisotropy.anisotropyRotation ?? 0,
          anisotropyChannel: [0, 1, 2] as const,
          ...(anisotropy.anisotropyTexture === undefined
            ? {}
            : { anisotropyTexture: parseTextureInfo(anisotropy.anisotropyTexture, textures) }),
        }),
    ...(sheen === undefined
      ? {}
      : {
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
        }),
    ...(iridescence === undefined
      ? {}
      : {
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
        }),
    ...(specular === undefined
      ? {}
      : {
          specularFactor: specular.specularFactor ?? 1,
          specularChannel: 3,
          specularColorFactor: tuple3(specular.specularColorFactor) ?? [1, 1, 1],
          specularColorChannel: [0, 1, 2] as const,
          ...(specular.specularTexture === undefined
            ? {}
            : { specularTexture: parseTextureInfo(specular.specularTexture, textures) }),
          ...(specular.specularColorTexture === undefined
            ? {}
            : {
                specularColorTexture: parseTextureInfo(specular.specularColorTexture, textures),
              }),
        }),
    ...(diffuseTransmission === undefined
      ? {}
      : {
          diffuseTransmissionFactor: diffuseTransmission.diffuseTransmissionFactor ?? 0,
          diffuseTransmissionColorFactor: tuple3(
            diffuseTransmission.diffuseTransmissionColorFactor,
          ) ?? [1, 1, 1],
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
        }),
    ...(alphaMode === undefined ? {} : { alphaMode }),
    ...(alphaCutoff === undefined ? {} : { alphaCutoff }),
    ...(matJson.doubleSided === true ? { doubleSided: true } : {}),
    ...(pbr?.baseColorTexture?.texCoord === undefined || pbr.baseColorTexture.texCoord === 0
      ? {}
      : { baseColorTexCoord: pbr.baseColorTexture.texCoord }),
  });
}

import { err, type GltfError, gltfErr, ok, type Result } from '../errors.js';
