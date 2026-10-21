import { color } from '@forgeax/engine-math';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '@forgeax/engine-shader';
import type {
  MaterialColorSpace,
  MaterialParameter,
  MaterialPass,
  MaterialRenderState,
  MaterialRootAsset,
  MaterialStaticSwitches,
  MaterialValue,
} from '@forgeax/engine-types';
import {
  deriveStandardLayerPlan,
  STANDARD_MATERIAL_PARAM_SCHEMA,
  standardMaterialStaticSwitches,
  standardSurfaceParameters,
  unlitMaterialParameters,
} from '@forgeax/engine-types';
import {
  DEFAULT_STANDARD_SURFACE_MODULE,
  projectStandardSurfacePasses,
} from './assembly/material/surface-projection';
import { shadowCasterRenderState } from './material-render-state';

export type MaterialTransmissionValidationReason = 'non-finite' | 'range' | 'shape';

export type MaterialAuthoringValidationReason = 'non-finite' | 'range' | 'shape' | 'conflict';

function materialAuthoringHint(
  parameter: MaterialAuthoringContractError['detail']['parameter'],
  reason: MaterialAuthoringValidationReason,
): string {
  if (reason === 'conflict') {
    return parameter === 'triplanar'
      ? `remove triplanar, normalMapSpace 'object', alpha masking (alphaCutoff, alphaHash) or the slots it cannot project (${TRIPLANAR_UNSUPPORTED_SLOTS.join(', ')}); depth, shadow and temporal coverage sample by UV`
      : 'remove normalMapSpace or bumpTexture; an object-space normal map replaces the height-derived normal';
  }
  switch (parameter) {
    case 'subsurfaceRadius':
      return 'set subsurfaceRadius to three finite RGB support radii in [0, 12] presentation pixels';
    case 'subsurfaceWeight':
      return 'set subsurfaceWeight to a finite number in [0, 1] before publishing the material';
    case 'normalScale':
      return 'set normalScale to two finite numbers [x, y] before publishing the material';
    case 'triplanar':
      return "set triplanar to { space: 'world' | 'object', scale > 0, sharpness >= 1 } before publishing the material";
    case 'normalMapSpace':
      return "set normalMapSpace to 'tangent' or 'object' before publishing the material";
    case 'directMultiscattering':
      return "set directMultiscattering to 'fit' or 'lut' before publishing the material";
    case 'alphaCutoff':
      return 'set alphaCutoff to a finite number in [0, 1] before publishing the material';
    default:
      return `set ${parameter} to a finite number before publishing the material`;
  }
}

/**
 * Slots that keep UV sampling: height maps displace/perturb along the UV
 * tangent frame, and the specular/transmission/physical layers are sampled
 * outside the projected base Surface.
 */
const TRIPLANAR_UNSUPPORTED_SLOTS = [
  'bumpTexture',
  'displacementTexture',
  'specularTexture',
  'specularColorTexture',
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
  'diffuseTransmissionTexture',
  'diffuseTransmissionColorTexture',
] as const;

/** Structured authoring failure for a built-in Standard material parameter. */
export class MaterialAuthoringContractError extends Error {
  readonly code = 'material-authoring-contract-invalid' as const;
  readonly expected =
    'Standard material authoring values are finite and within their declared ranges';
  readonly hint: string;
  readonly detail: {
    readonly code: 'material-authoring-contract-invalid';
    readonly material: 'Standard';
    readonly parameter:
      | 'alphaCutoff'
      | 'normalScale'
      | 'bumpScale'
      | 'displacementScale'
      | 'displacementBias'
      | 'triplanar'
      | 'normalMapSpace'
      | 'flatShading'
      | 'directMultiscattering'
      | 'subsurfaceRadius'
      | 'subsurfaceWeight';
    readonly reason: MaterialAuthoringValidationReason;
    readonly actual?: unknown;
  };

  constructor(
    parameter: MaterialAuthoringContractError['detail']['parameter'],
    reason: MaterialAuthoringValidationReason,
    actual?: unknown,
  ) {
    super(`Materials.standard: ${parameter} violates the authoring contract (${reason})`);
    this.name = 'MaterialAuthoringContractError';
    this.hint = materialAuthoringHint(parameter, reason);
    this.detail = {
      code: 'material-authoring-contract-invalid',
      material: 'Standard',
      parameter,
      reason,
      ...(actual === undefined ? {} : { actual }),
    };
  }
}

/** Structured authoring failure for the Standard transmission contract. */
export class MaterialTransmissionContractError extends Error {
  readonly code = 'material-transmission-contract-invalid' as const;
  readonly expected = 'transmission material values satisfy finite ranges and Forward depth rules';
  readonly hint =
    'repair the named transmission value or pass state before publishing the material';
  readonly detail: {
    readonly code: 'material-transmission-contract-invalid';
    readonly material: 'Standard';
    readonly parameter:
      | 'transmission'
      | 'ior'
      | 'thickness'
      | 'attenuationColor'
      | 'attenuationDistance';
    readonly reason: MaterialTransmissionValidationReason;
    readonly actual?: unknown;
  };

  constructor(
    parameter: (typeof MaterialTransmissionContractError.prototype.detail)['parameter'],
    reason: MaterialTransmissionValidationReason,
    actual?: unknown,
  ) {
    super(`Materials.standard: ${parameter} violates the transmission contract (${reason})`);
    this.name = 'MaterialTransmissionContractError';
    this.detail = {
      code: 'material-transmission-contract-invalid',
      material: 'Standard',
      parameter,
      reason,
      ...(actual === undefined ? {} : { actual }),
    };
  }
}

export const SPRITE_PREMULTIPLIED_ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const UNLIT_MODULE = 'forgeax_material::unlit';
const SPRITE_MODULE = 'forgeax_material::sprite';

export type MaterialColorTuple3 = readonly [number, number, number];
export type MaterialColorTuple4 = readonly [number, number, number, number];
export type MaterialColorInput3 = MaterialColorTuple3 | string | number;
export type MaterialColorInput4 = MaterialColorTuple4 | string | number;

function colorHexFromNumber(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`material color number must be an integer in [0, 0xffffff], got ${value}`);
  }
  return `#${value.toString(16).padStart(6, '0')}`;
}

function linearColorFromInput(
  input: MaterialColorInput3 | MaterialColorInput4,
  channels: 3 | 4,
): readonly number[] {
  if (typeof input === 'number' || typeof input === 'string') {
    const parsed = color.create();
    color.fromCss(parsed, typeof input === 'number' ? colorHexFromNumber(input) : input);
    return channels === 3
      ? [parsed[0] as number, parsed[1] as number, parsed[2] as number]
      : Array.from(parsed);
  }
  if (input.length !== channels) {
    throw new Error(`material color tuple must contain ${channels} channels, got ${input.length}`);
  }
  return [...input];
}

/** Convert an explicit sRGB numeric tuple into the linear tuple factories store. */
export function srgb(input: MaterialColorTuple3): MaterialColorTuple3;
export function srgb(input: MaterialColorTuple4): MaterialColorTuple4;
export function srgb(input: readonly number[]): readonly number[] {
  if (input.length !== 3 && input.length !== 4) {
    throw new Error(`sRGB material color tuple must contain 3 or 4 channels, got ${input.length}`);
  }
  const parsed = color.create(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0, input[3] ?? 1);
  color.srgbToLinear(parsed, parsed);
  return input.length === 3
    ? [parsed[0] as number, parsed[1] as number, parsed[2] as number]
    : [parsed[0] as number, parsed[1] as number, parsed[2] as number, parsed[3] as number];
}

/**
 * Convert an explicit Display P3 (sRGB transfer, P3 primaries) tuple into the linear
 * Rec.709 tuple factories store. Colors outside Rec.709 keep negative components so a
 * `display-p3` renderer output re-encodes them exactly; an sRGB output clips them.
 */
export function displayP3(input: MaterialColorTuple3): MaterialColorTuple3;
export function displayP3(input: MaterialColorTuple4): MaterialColorTuple4;
export function displayP3(input: readonly number[]): readonly number[] {
  if (input.length !== 3 && input.length !== 4) {
    throw new Error(
      `Display P3 material color tuple must contain 3 or 4 channels, got ${input.length}`,
    );
  }
  const parsed = color.create(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0, input[3] ?? 1);
  color.displayP3ToLinear(parsed, parsed);
  return input.length === 3
    ? [parsed[0] as number, parsed[1] as number, parsed[2] as number]
    : [parsed[0] as number, parsed[1] as number, parsed[2] as number, parsed[3] as number];
}

function standardParameters(
  colorSpace: MaterialColorSpace,
  opts: StandardOpts,
): readonly MaterialParameter[] {
  const physicalNames = new Set<string>();
  const addPhysical = (...names: readonly string[]) => {
    for (const name of names) physicalNames.add(name);
  };
  if (
    opts.clearcoat !== undefined ||
    opts.clearcoatRoughness !== undefined ||
    opts.clearcoatNormalScale !== undefined ||
    opts.clearcoatTexture !== undefined ||
    opts.clearcoatRoughnessTexture !== undefined ||
    opts.clearcoatNormalTexture !== undefined
  ) {
    addPhysical(
      'clearcoat',
      'clearcoatRoughness',
      'clearcoatNormalScale',
      ...(opts.clearcoatTexture === undefined ? [] : ['clearcoatTexture']),
      ...(opts.clearcoatRoughnessTexture === undefined ? [] : ['clearcoatRoughnessTexture']),
      ...(opts.clearcoatNormalTexture === undefined ? [] : ['clearcoatNormalTexture']),
    );
  }
  if (
    opts.anisotropyStrength !== undefined ||
    opts.anisotropyRotation !== undefined ||
    opts.anisotropyTexture !== undefined
  ) {
    addPhysical('anisotropyStrength', 'anisotropyRotation');
    if (opts.anisotropyTexture !== undefined) addPhysical('anisotropyTexture');
  }
  if (
    opts.sheenColor !== undefined ||
    opts.sheenRoughness !== undefined ||
    opts.sheenColorTexture !== undefined ||
    opts.sheenRoughnessTexture !== undefined
  ) {
    addPhysical('sheenColor', 'sheenRoughness');
    if (opts.sheenColorTexture !== undefined) addPhysical('sheenColorTexture');
    if (opts.sheenRoughnessTexture !== undefined) addPhysical('sheenRoughnessTexture');
  }
  if (
    opts.diffuseTransmission !== undefined ||
    opts.diffuseTransmissionColor !== undefined ||
    opts.diffuseTransmissionTexture !== undefined ||
    opts.diffuseTransmissionColorTexture !== undefined
  ) {
    addPhysical('diffuseTransmission', 'diffuseTransmissionColor');
    if (opts.diffuseTransmissionTexture !== undefined) addPhysical('diffuseTransmissionTexture');
    if (opts.diffuseTransmissionColorTexture !== undefined) {
      addPhysical('diffuseTransmissionColorTexture');
    }
  }
  if (
    opts.iridescence !== undefined ||
    opts.iridescenceIor !== undefined ||
    opts.iridescenceThicknessMinimum !== undefined ||
    opts.iridescenceThicknessMaximum !== undefined ||
    opts.iridescenceTexture !== undefined ||
    opts.iridescenceThicknessTexture !== undefined
  ) {
    addPhysical(
      'iridescence',
      'iridescenceIor',
      'iridescenceThicknessMinimum',
      'iridescenceThicknessMaximum',
      ...(opts.iridescenceTexture === undefined ? [] : ['iridescenceTexture']),
      ...(opts.iridescenceThicknessTexture === undefined ? [] : ['iridescenceThicknessTexture']),
    );
  }
  const baseNames = new Set([
    'baseColor',
    'metallic',
    'roughness',
    'subsurfaceRadius',
    'subsurfaceWeight',
    'metallicChannel',
    'roughnessChannel',
    'aoChannel',
    'extraChannel',
    'emissive',
    'emissiveIntensity',
    'occlusionStrength',
    'alphaCutoff',
    'alphaHash',
    'shadowAlphaMode',
    'alphaMode',
    'alphaToCoverage',
    'normalScale',
    'bumpScale',
    'displacementScale',
    'displacementBias',
    'specular',
    'specularColor',
    'triplanarSpace',
    'triplanarScale',
    'triplanarSharpness',
    'normalMapSpace',
    // IOR is part of the always-present dielectric F0 contract. The
    // transmission layer may be absent, but the Standard shader still
    // consumes this scalar for the base reflection path.
    'ior',
  ]);
  if (opts.flatShading !== undefined) baseNames.add('flatShading');
  if (opts.specularTexture !== undefined) baseNames.add('specularTexture');
  if (opts.directMultiscattering === 'lut') baseNames.add('directMultiscatteringLut');
  if (opts.specularColorTexture !== undefined) baseNames.add('specularColorTexture');
  if (
    opts.transmission !== undefined ||
    opts.ior !== undefined ||
    opts.thickness !== undefined ||
    opts.transmissionTexture !== undefined ||
    opts.thicknessTexture !== undefined ||
    opts.attenuationColor !== undefined ||
    opts.attenuationDistance !== undefined
  ) {
    for (const name of [
      'transmission',
      'ior',
      'thickness',
      'attenuationColor',
      'attenuationDistance',
    ]) {
      baseNames.add(name);
    }
  }
  // A texture declaration selects its compiled sampling path. Loading state
  // does not: an authored but not-yet-resident slot still needs its fallback.
  for (const parameter of DEFAULT_STANDARD_PBR_PARAM_SCHEMA) {
    if (
      parameter.type === 'texture2d' &&
      opts[parameter.name as keyof StandardOpts] !== undefined
    ) {
      baseNames.add(parameter.name);
    }
  }
  // All Standard fields come from one root schema. Physical fields are
  // projected by the authored option membership above; appending a second
  // physical schema would create a parallel ABI authority.
  const availableSchema = STANDARD_MATERIAL_PARAM_SCHEMA;
  // Keep the generated Standard UBO's numeric run contiguous before any
  // texture coordinate records. The built-in WGSL places the complete
  // physical root (including clearcoat scalars) after the base numeric run
  // and before all coordinate pairs; appending physical entries after the
  // base texture records would otherwise derive a different ABI.
  const numericSchema = availableSchema.filter((entry) => !entry.type.startsWith('texture'));
  const textureSchema = availableSchema.filter((entry) => entry.type.startsWith('texture'));
  const orderedSchema = [...numericSchema, ...textureSchema];
  return orderedSchema
    .filter((entry) => baseNames.has(entry.name) || physicalNames.has(entry.name))
    .map((entry) => {
      const type = entry.type.startsWith('texture') ? 'texture' : entry.type;
      const isRequired =
        entry.name === 'baseColor' || entry.name === 'metallic' || entry.name === 'roughness';
      const authoredColor =
        entry.type === 'color' || (entry.type === 'vec3' && entry.name !== 'attenuationColor');
      const schemaColorSpace = 'colorSpace' in entry ? entry.colorSpace : undefined;
      const colorSpaceProjection: { colorSpace?: MaterialColorSpace } = {};
      if (authoredColor && !(type === 'color' && colorSpace === 'srgb')) {
        colorSpaceProjection.colorSpace = colorSpace;
      } else if (!authoredColor && schemaColorSpace !== undefined) {
        colorSpaceProjection.colorSpace = schemaColorSpace;
      }
      return {
        name: entry.name,
        type,
        ...colorSpaceProjection,
        ...('default' in entry && entry.default !== undefined ? { default: entry.default } : {}),
        ...(isRequired ? {} : { optional: true }),
      } as MaterialParameter;
    });
}

function pass(
  name: string,
  module: string,
  renderState: MaterialRenderState | undefined,
  fragmentEntry?: string,
  queue?: number,
): MaterialPass {
  const lightMode =
    name === 'shadow-caster' ? 'ShadowCaster' : name === 'deferred' ? 'Deferred' : 'Forward';
  const authoredState = (renderState ?? {}) as Readonly<Record<string, unknown>>;
  const authoredTags = authoredState.tags as Readonly<Record<string, string>> | undefined;
  return {
    name,
    program: {
      module,
      ...(fragmentEntry === undefined ? {} : { fragmentEntry }),
    },
    renderState: {
      ...authoredState,
      tags: { LightMode: lightMode, ...authoredTags },
      ...(queue === undefined ? {} : { queue }),
    },
  };
}

interface UnlitOpts {
  readonly baseColorTexture?: MaterialValue;
  /** Independent coverage; green by default, like Standard alphaTexture. */
  readonly alphaTexture?: MaterialValue;
  readonly alphaChannel?: number;
  readonly alphaCutoff?: number;
  /** Object-space stochastic coverage. Keep blending disabled and depth writes enabled. */
  readonly alphaHash?: boolean;
  /** Texture-only shadow coverage ignores scalar opacity, vertex alpha and stochastic coverage. */
  readonly shadowAlphaMode?: 'material' | 'texture';
  /** Output alpha is independent of the sampled coverage used by depth/shadows. */
  readonly alphaMode?: 'preserve' | 'opaque' | 'premultiplied';
  readonly renderState?: MaterialRenderState;
  readonly queue?: number;
}

/** Unlit shading modes; the value is the `shading` scalar the unlit module reads. */
const UNLIT_SHADING = { color: 0, normal: 1, matcap: 2, displayNormal: 3 } as const;

function unlit(rgba: MaterialColorInput4, opts?: UnlitOpts): MaterialRootAsset {
  return unlitMaterial('unlit', rgba, UNLIT_SHADING.color, opts);
}

function unlitMaterial(
  factory: 'unlit' | 'matcap' | 'normal',
  rgba: MaterialColorInput4,
  shading: (typeof UNLIT_SHADING)[keyof typeof UNLIT_SHADING],
  opts?: UnlitOpts,
): MaterialRootAsset {
  if (opts?.alphaCutoff !== undefined && (opts.alphaCutoff < 0 || opts.alphaCutoff > 1)) {
    throw new Error(`Materials.${factory}: alphaCutoff must be in [0, 1], got ${opts.alphaCutoff}`);
  }
  const values: Record<string, MaterialValue> = { baseColor: linearColorFromInput(rgba, 4) };
  if (shading !== UNLIT_SHADING.color) values.shading = shading;
  if (opts?.baseColorTexture !== undefined) values.baseColorTexture = opts.baseColorTexture;
  if (opts?.alphaTexture !== undefined) values.alphaTexture = opts.alphaTexture;
  validateChannel('alphaChannel', opts?.alphaChannel);
  if (opts?.alphaChannel !== undefined) values.alphaChannel = opts.alphaChannel;
  values.shadowAlphaMode = opts?.shadowAlphaMode === 'texture' ? 1 : 0;
  if (opts?.alphaCutoff !== undefined) values.alphaCutoff = opts.alphaCutoff;
  if (opts?.alphaHash !== undefined) values.alphaHash = Number(opts.alphaHash);
  values.alphaMode = opts?.alphaMode === 'opaque' ? 1 : opts?.alphaMode === 'premultiplied' ? 2 : 0;
  values.alphaToCoverage = Number(opts?.renderState?.alphaToCoverageEnabled ?? false);
  const passes: [MaterialPass, ...MaterialPass[]] = [
    pass('forward', UNLIT_MODULE, opts?.renderState, undefined, opts?.queue),
  ];
  const shadow = pass('shadow-caster', UNLIT_MODULE, shadowCasterRenderState(opts?.renderState));
  passes.push({ ...shadow, program: { ...shadow.program, vertexEntry: 'vs_shadow' } });
  return {
    kind: 'material',
    colorSpace: 'linear',
    passes,
    parameters: unlitMaterialParameters('linear'),
    values,
  };
}

interface MatcapOpts extends Omit<UnlitOpts, 'baseColorTexture'> {
  /** Tint multiplied with the matcap sample; numeric tuples are linear. */
  readonly color?: MaterialColorInput4;
}

/**
 * Three.js `MeshMatcapMaterial`: the sphere image is looked up by the
 * view-space normal, so shading follows the camera without any light.
 */
function matcap(matcapTexture: MaterialValue, opts?: MatcapOpts): MaterialRootAsset {
  return unlitMaterial('matcap', opts?.color ?? [1, 1, 1, 1], UNLIT_SHADING.matcap, {
    ...opts,
    baseColorTexture: matcapTexture,
  });
}

interface NormalOpts extends Omit<UnlitOpts, 'baseColorTexture'> {
  /** Only alpha is read; the color is the encoded view-space normal. */
  readonly opacity?: number;
  /** Data writes packed values directly; display decodes them before the sRGB finishing pass. */
  readonly encoding?: 'data' | 'display';
}

/**
 * Three.js `MeshNormalMaterial`: writes `viewNormal * 0.5 + 0.5`. Pair it with
 * a camera whose tonemap is `'none'` when the encoded value must read back exactly.
 */
function normal(opts?: NormalOpts): MaterialRootAsset {
  return unlitMaterial(
    'normal',
    [1, 1, 1, opts?.opacity ?? 1],
    opts?.encoding === 'display' ? UNLIT_SHADING.displayNormal : UNLIT_SHADING.normal,
    opts,
  );
}

export interface StandardTriplanarOptions {
  readonly space: 'world' | 'object';
  readonly scale?: number;
  readonly sharpness?: number;
}

interface StandardOpts {
  /** Shade with each triangle's geometric normal; defaults to smooth vertex normals. */
  readonly flatShading?: boolean;
  readonly staticSwitches?: MaterialStaticSwitches;
  /** Numeric tuples are linear; Hex/CSS strings and numbers are sRGB inputs. */
  readonly baseColor: MaterialColorInput4;
  readonly metallic?: number;
  readonly roughness?: number;
  /** Direct-light multiscattering: mobile-friendly fit by default; LUT adds one sampled texture. */
  readonly directMultiscattering?: 'fit' | 'lut';
  /** RGB diffusion support radii in presentation pixels, each finite in [0,12]. */
  readonly subsurfaceRadius?: readonly [number, number, number];
  /** Fraction of diffuse replaced by surface diffusion, finite in [0,1]. */
  readonly subsurfaceWeight?: number;
  /** Texture channel used for the metallic factor; glTF defaults to B (2). */
  readonly metallicChannel?: number;
  /** Texture channel used for the roughness factor; glTF defaults to G (1). */
  readonly roughnessChannel?: number;
  /** Alpha map channel; Three.js defaults to G (1). */
  readonly alphaChannel?: number;
  readonly clearcoat?: number;
  readonly clearcoatRoughness?: number;
  readonly clearcoatTexture?: MaterialValue;
  readonly clearcoatRoughnessTexture?: MaterialValue;
  readonly clearcoatNormalTexture?: MaterialValue;
  readonly clearcoatNormalScale?: number;
  readonly anisotropyStrength?: number;
  readonly anisotropyRotation?: number;
  readonly anisotropyTexture?: MaterialValue;
  readonly sheenColor?: MaterialColorInput3;
  readonly sheenRoughness?: number;
  readonly sheenColorTexture?: MaterialValue;
  readonly sheenRoughnessTexture?: MaterialValue;
  /**
   * Fraction of non-specular light transmitted diffusely through a thin
   * surface (KHR_materials_diffuse_transmission). Foliage and paper lit from
   * behind glow on the viewer side; pair with `renderState.cullMode: 'none'`.
   */
  readonly diffuseTransmission?: number;
  /** Linear tint of the transmitted light; it does not inherit baseColor. */
  readonly diffuseTransmissionColor?: MaterialColorInput3;
  /** Linear A channel multiplies `diffuseTransmission`. */
  readonly diffuseTransmissionTexture?: MaterialValue;
  /** sRGB RGB channels multiply `diffuseTransmissionColor`. */
  readonly diffuseTransmissionColorTexture?: MaterialValue;
  readonly iridescence?: number;
  readonly iridescenceIor?: number;
  readonly iridescenceThicknessMinimum?: number;
  readonly iridescenceThicknessMaximum?: number;
  readonly iridescenceTexture?: MaterialValue;
  readonly iridescenceThicknessTexture?: MaterialValue;
  readonly specular?: number;
  readonly specularColor?: MaterialColorInput3;
  readonly specularTexture?: MaterialValue;
  readonly specularColorTexture?: MaterialValue;
  readonly emissive?: MaterialColorInput3;
  readonly emissiveIntensity?: number;
  readonly emissiveTexture?: MaterialValue;
  readonly baseColorTexture?: MaterialValue;
  readonly metallicRoughnessTexture?: MaterialValue;
  /** Independent map overrides the corresponding packed metallic-roughness channel. */
  readonly metallicTexture?: MaterialValue;
  readonly roughnessTexture?: MaterialValue;
  /** Multiplies base-color and vertex opacity; uses the existing blend/cutoff policy. */
  readonly alphaTexture?: MaterialValue;
  readonly normalTexture?: MaterialValue;
  readonly normalScale?: readonly [number, number];
  /**
   * `'object'` reads `normalTexture` as an object-space normal (RGB * 2 - 1,
   * Three.js `ObjectSpaceNormalMap`); no tangents are needed. Default `'tangent'`.
   */
  readonly normalMapSpace?: 'tangent' | 'object';
  /**
   * Project base color, metallic/roughness, alpha, normal, emissive and
   * occlusion maps along the three axes of `space` instead of mesh UVs.
   * `scale` is texture repeats per unit; `sharpness` (>= 1) narrows the
   * blend between planes. Slot coordinate transforms still apply per plane.
   */
  readonly triplanar?: StandardTriplanarOptions;
  readonly bumpTexture?: MaterialValue;
  readonly bumpScale?: number;
  /** Linear red height in [0, 1], sampled at mip zero. Requires sufficient mesh vertices. */
  readonly displacementTexture?: MaterialValue;
  /** Object-space displacement = height * scale + bias. Defaults to 1 and 0. */
  readonly displacementScale?: number;
  readonly displacementBias?: number;
  readonly occlusionTexture?: MaterialValue;
  readonly occlusionStrength?: number;
  readonly alphaCutoff?: number;
  /** Object-space stochastic coverage. Keep blending disabled and depth writes enabled. */
  readonly alphaHash?: boolean;
  /** Texture-only shadow coverage ignores scalar opacity, vertex alpha and stochastic coverage. */
  readonly shadowAlphaMode?: 'material' | 'texture';
  /** Output alpha is independent of the sampled coverage used by depth/shadows. */
  readonly alphaMode?: 'preserve' | 'opaque' | 'premultiplied';
  readonly transmission?: number;
  readonly transmissionTexture?: MaterialValue;
  readonly ior?: number;
  readonly thickness?: number;
  readonly thicknessTexture?: MaterialValue;
  readonly attenuationColor?: readonly [number, number, number];
  readonly attenuationDistance?: number;
  readonly renderState?: MaterialRenderState;
  readonly queue?: number;
}

/** Built-in Standard authoring surface with engine-owned parameter defaults. */
export interface DefaultStandardOptions extends StandardOpts {
  readonly surfaceModule?: never;
  readonly parameters?: never;
  readonly values?: never;
}

/** Import-first Standard Surface authoring; the root parameter contract stays caller-owned. */
export interface CustomStandardSurfaceOptions {
  readonly staticSwitches?: MaterialStaticSwitches;
  readonly surfaceModule: string;
  readonly parameters: readonly MaterialParameter[];
  readonly values: Readonly<Record<string, MaterialValue>>;
  readonly alphaClip?: boolean;
  readonly colorSpace?: MaterialColorSpace;
  readonly renderState?: MaterialRenderState;
  readonly queue?: number;
  readonly baseColor?: never;
  readonly metallic?: never;
  readonly roughness?: never;
  readonly directMultiscattering?: never;
  readonly subsurfaceRadius?: never;
  readonly subsurfaceWeight?: never;
  readonly metallicChannel?: never;
  readonly roughnessChannel?: never;
  readonly clearcoat?: never;
  readonly clearcoatRoughness?: never;
  readonly clearcoatTexture?: never;
  readonly clearcoatRoughnessTexture?: never;
  readonly clearcoatNormalTexture?: never;
  readonly clearcoatNormalScale?: never;
  readonly anisotropyStrength?: never;
  readonly anisotropyRotation?: never;
  readonly anisotropyTexture?: never;
  readonly sheenColor?: never;
  readonly sheenRoughness?: never;
  readonly sheenColorTexture?: never;
  readonly sheenRoughnessTexture?: never;
  readonly diffuseTransmission?: never;
  readonly diffuseTransmissionColor?: never;
  readonly diffuseTransmissionTexture?: never;
  readonly diffuseTransmissionColorTexture?: never;
  readonly iridescence?: never;
  readonly iridescenceIor?: never;
  readonly iridescenceThicknessMinimum?: never;
  readonly iridescenceThicknessMaximum?: never;
  readonly iridescenceTexture?: never;
  readonly iridescenceThicknessTexture?: never;
  readonly specular?: never;
  readonly specularColor?: never;
  readonly specularTexture?: never;
  readonly specularColorTexture?: never;
  readonly emissive?: never;
  readonly emissiveIntensity?: never;
  readonly emissiveTexture?: never;
  readonly baseColorTexture?: never;
  readonly metallicRoughnessTexture?: never;
  readonly metallicTexture?: never;
  readonly roughnessTexture?: never;
  readonly alphaTexture?: never;
  readonly alphaChannel?: never;
  readonly normalTexture?: never;
  readonly normalScale?: never;
  readonly normalMapSpace?: never;
  readonly triplanar?: never;
  readonly bumpTexture?: never;
  readonly bumpScale?: never;
  readonly displacementTexture?: never;
  readonly displacementScale?: never;
  readonly displacementBias?: never;
  readonly occlusionTexture?: never;
  readonly occlusionStrength?: never;
  readonly alphaCutoff?: never;
  readonly alphaHash?: never;
  readonly transmission?: never;
  readonly transmissionTexture?: never;
  readonly ior?: never;
  readonly thickness?: never;
  readonly thicknessTexture?: never;
  readonly attenuationColor?: never;
  readonly attenuationDistance?: never;
}

export type StandardOptions = DefaultStandardOptions | CustomStandardSurfaceOptions;

function validateChannel(
  name: 'metallicChannel' | 'roughnessChannel' | 'alphaChannel',
  value: number | undefined,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 3)) {
    throw new Error(`Materials.standard: ${name} must be an integer in [0, 3], got ${value}`);
  }
}

function validateFiniteRange(
  name: 'transmission' | 'ior' | 'thickness' | 'attenuationDistance',
  value: number | undefined,
  minimum: number,
  maximum?: number,
): void {
  if (value === undefined || !Number.isFinite(value)) {
    if (value === undefined) return;
    throw new MaterialTransmissionContractError(name, 'non-finite', value);
  }
  if (value < minimum || (maximum !== undefined && value > maximum)) {
    throw new MaterialTransmissionContractError(name, 'range', value);
  }
}

function validateProjection(opts: StandardOpts): void {
  const normalSpace = opts.normalMapSpace;
  if (normalSpace !== undefined && normalSpace !== 'tangent' && normalSpace !== 'object') {
    throw new MaterialAuthoringContractError('normalMapSpace', 'range', normalSpace);
  }
  if (normalSpace === 'object' && opts.bumpTexture !== undefined) {
    throw new MaterialAuthoringContractError('normalMapSpace', 'conflict', 'bumpTexture');
  }
  const triplanar = opts.triplanar;
  if (triplanar === undefined) return;
  if (triplanar.space !== 'world' && triplanar.space !== 'object') {
    throw new MaterialAuthoringContractError('triplanar', 'range', triplanar);
  }
  const scale = triplanar.scale ?? 1;
  const sharpness = triplanar.sharpness ?? 1;
  if (!Number.isFinite(scale) || !Number.isFinite(sharpness)) {
    throw new MaterialAuthoringContractError('triplanar', 'non-finite', triplanar);
  }
  if (scale <= 0 || sharpness < 1) {
    throw new MaterialAuthoringContractError('triplanar', 'range', triplanar);
  }
  if (normalSpace === 'object') {
    throw new MaterialAuthoringContractError('triplanar', 'conflict', 'normalMapSpace');
  }
  if ((opts.alphaCutoff ?? 0) > 0) {
    throw new MaterialAuthoringContractError('triplanar', 'conflict', 'alphaCutoff');
  }
  if (opts.alphaHash === true) {
    throw new MaterialAuthoringContractError('triplanar', 'conflict', 'alphaHash');
  }
  const conflict = TRIPLANAR_UNSUPPORTED_SLOTS.find((name) => opts[name] !== undefined);
  if (conflict !== undefined) {
    throw new MaterialAuthoringContractError('triplanar', 'conflict', conflict);
  }
}

function standardDefault(opts: DefaultStandardOptions): MaterialRootAsset {
  if (
    opts.directMultiscattering !== undefined &&
    opts.directMultiscattering !== 'fit' &&
    opts.directMultiscattering !== 'lut'
  ) {
    throw new MaterialAuthoringContractError(
      'directMultiscattering',
      'range',
      opts.directMultiscattering,
    );
  }
  const subsurfaceRadius = opts.subsurfaceRadius ?? [0, 0, 0];
  const subsurfaceWeight = opts.subsurfaceWeight ?? 0;
  if (!Array.isArray(subsurfaceRadius) || subsurfaceRadius.length !== 3) {
    throw new MaterialAuthoringContractError('subsurfaceRadius', 'shape', subsurfaceRadius);
  }
  if (subsurfaceRadius.some((r) => !Number.isFinite(r))) {
    throw new MaterialAuthoringContractError('subsurfaceRadius', 'non-finite', subsurfaceRadius);
  }
  if (subsurfaceRadius.some((r) => r < 0 || r > 12)) {
    throw new MaterialAuthoringContractError('subsurfaceRadius', 'range', subsurfaceRadius);
  }
  if (!Number.isFinite(subsurfaceWeight)) {
    throw new MaterialAuthoringContractError('subsurfaceWeight', 'non-finite', subsurfaceWeight);
  }
  if (subsurfaceWeight < 0 || subsurfaceWeight > 1) {
    throw new MaterialAuthoringContractError('subsurfaceWeight', 'range', subsurfaceWeight);
  }

  const occlusionStrength = opts.occlusionStrength ?? 1;
  if (occlusionStrength < 0 || occlusionStrength > 1) {
    throw new Error(
      `Materials.standard: occlusionStrength must be in [0, 1], got ${occlusionStrength}`,
    );
  }
  if (opts.alphaCutoff !== undefined && !Number.isFinite(opts.alphaCutoff)) {
    throw new MaterialAuthoringContractError('alphaCutoff', 'non-finite', opts.alphaCutoff);
  }
  if (opts.alphaCutoff !== undefined && (opts.alphaCutoff < 0 || opts.alphaCutoff > 1)) {
    throw new MaterialAuthoringContractError('alphaCutoff', 'range', opts.alphaCutoff);
  }
  if (opts.normalScale !== undefined) {
    if (!Array.isArray(opts.normalScale) || opts.normalScale.length !== 2) {
      throw new MaterialAuthoringContractError('normalScale', 'shape', opts.normalScale);
    }
    if (!Number.isFinite(opts.normalScale[0]) || !Number.isFinite(opts.normalScale[1])) {
      throw new MaterialAuthoringContractError('normalScale', 'non-finite', opts.normalScale);
    }
  }
  if (opts.bumpScale !== undefined && !Number.isFinite(opts.bumpScale)) {
    throw new MaterialAuthoringContractError('bumpScale', 'non-finite', opts.bumpScale);
  }
  for (const name of ['displacementScale', 'displacementBias'] as const) {
    if (opts[name] !== undefined && !Number.isFinite(opts[name])) {
      throw new MaterialAuthoringContractError(name, 'non-finite', opts[name]);
    }
  }
  validateProjection(opts);
  validateChannel('metallicChannel', opts.metallicChannel);
  validateChannel('roughnessChannel', opts.roughnessChannel);
  validateChannel('alphaChannel', opts.alphaChannel);
  const transmission = opts.transmission ?? 0;
  const ior = opts.ior ?? 1.5;
  const thickness = opts.thickness ?? 0;
  const attenuationColor = opts.attenuationColor ?? [1, 1, 1];
  validateFiniteRange('transmission', transmission, 0, 1);
  validateFiniteRange('ior', ior, 1);
  validateFiniteRange('thickness', thickness, 0);
  validateFiniteRange('attenuationDistance', opts.attenuationDistance, Number.MIN_VALUE);
  if (
    attenuationColor.length !== 3 ||
    attenuationColor.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new MaterialTransmissionContractError('attenuationColor', 'shape', attenuationColor);
  }
  const values: Record<string, MaterialValue> = {
    subsurfaceRadius: [...subsurfaceRadius],
    subsurfaceWeight,
    baseColor: linearColorFromInput(opts.baseColor, 4),
    metallic: opts.metallic ?? 0,
    roughness: opts.roughness ?? 1,
    occlusionStrength,
    displacementScale: opts.displacementScale ?? 1,
    displacementBias: opts.displacementBias ?? 0,
    specular: opts.specular ?? 1,
    specularColor:
      opts.specularColor === undefined ? [1, 1, 1] : linearColorFromInput(opts.specularColor, 3),
    transmission,
    ior,
    thickness,
    attenuationColor,
  };
  if (opts.flatShading !== undefined) values.flatShading = Number(opts.flatShading);
  if (opts.metallicChannel !== undefined) values.metallicChannel = opts.metallicChannel;
  if (opts.roughnessChannel !== undefined) values.roughnessChannel = opts.roughnessChannel;
  if (opts.clearcoat !== undefined) values.clearcoat = opts.clearcoat;
  if (opts.clearcoatRoughness !== undefined) values.clearcoatRoughness = opts.clearcoatRoughness;
  if (opts.clearcoatTexture !== undefined) values.clearcoatTexture = opts.clearcoatTexture;
  if (opts.clearcoatRoughnessTexture !== undefined) {
    values.clearcoatRoughnessTexture = opts.clearcoatRoughnessTexture;
  }
  if (opts.clearcoatNormalTexture !== undefined) {
    values.clearcoatNormalTexture = opts.clearcoatNormalTexture;
  }
  if (opts.clearcoatNormalScale !== undefined)
    values.clearcoatNormalScale = opts.clearcoatNormalScale;
  if (opts.anisotropyStrength !== undefined) values.anisotropyStrength = opts.anisotropyStrength;
  if (opts.anisotropyRotation !== undefined) values.anisotropyRotation = opts.anisotropyRotation;
  if (opts.anisotropyTexture !== undefined) values.anisotropyTexture = opts.anisotropyTexture;
  if (opts.sheenColor !== undefined) values.sheenColor = linearColorFromInput(opts.sheenColor, 3);
  if (opts.sheenRoughness !== undefined) values.sheenRoughness = opts.sheenRoughness;
  if (opts.sheenColorTexture !== undefined) values.sheenColorTexture = opts.sheenColorTexture;
  if (opts.sheenRoughnessTexture !== undefined) {
    values.sheenRoughnessTexture = opts.sheenRoughnessTexture;
  }
  if (opts.diffuseTransmission !== undefined) {
    values.diffuseTransmission = opts.diffuseTransmission;
  }
  if (opts.diffuseTransmissionColor !== undefined) {
    values.diffuseTransmissionColor = linearColorFromInput(opts.diffuseTransmissionColor, 3);
  }
  if (opts.diffuseTransmissionTexture !== undefined) {
    values.diffuseTransmissionTexture = opts.diffuseTransmissionTexture;
  }
  if (opts.diffuseTransmissionColorTexture !== undefined) {
    values.diffuseTransmissionColorTexture = opts.diffuseTransmissionColorTexture;
  }
  if (opts.iridescence !== undefined) values.iridescence = opts.iridescence;
  if (opts.iridescenceIor !== undefined) values.iridescenceIor = opts.iridescenceIor;
  if (opts.iridescenceThicknessMinimum !== undefined) {
    values.iridescenceThicknessMinimum = opts.iridescenceThicknessMinimum;
  }
  if (opts.iridescenceThicknessMaximum !== undefined) {
    values.iridescenceThicknessMaximum = opts.iridescenceThicknessMaximum;
  }
  if (opts.iridescenceTexture !== undefined) values.iridescenceTexture = opts.iridescenceTexture;
  if (opts.iridescenceThicknessTexture !== undefined) {
    values.iridescenceThicknessTexture = opts.iridescenceThicknessTexture;
  }
  if (opts.emissive !== undefined) values.emissive = linearColorFromInput(opts.emissive, 3);
  if (opts.emissiveIntensity !== undefined) values.emissiveIntensity = opts.emissiveIntensity;
  if (opts.emissiveTexture !== undefined) values.emissiveTexture = opts.emissiveTexture;
  if (opts.baseColorTexture !== undefined) values.baseColorTexture = opts.baseColorTexture;
  if (opts.metallicRoughnessTexture !== undefined) {
    values.metallicRoughnessTexture = opts.metallicRoughnessTexture;
  }
  if (opts.metallicTexture !== undefined) values.metallicTexture = opts.metallicTexture;
  if (opts.roughnessTexture !== undefined) values.roughnessTexture = opts.roughnessTexture;
  if (opts.alphaTexture !== undefined) values.alphaTexture = opts.alphaTexture;
  if (opts.alphaChannel !== undefined) values.alphaChannel = opts.alphaChannel;
  if (opts.normalTexture !== undefined) values.normalTexture = opts.normalTexture;
  if (opts.normalScale !== undefined) values.normalScale = [...opts.normalScale];
  if (opts.normalMapSpace === 'object') values.normalMapSpace = 1;
  if (opts.triplanar !== undefined) {
    values.triplanarSpace = opts.triplanar.space === 'world' ? 1 : 2;
    values.triplanarScale = opts.triplanar.scale ?? 1;
    values.triplanarSharpness = opts.triplanar.sharpness ?? 1;
  }
  if (opts.bumpTexture !== undefined) values.bumpTexture = opts.bumpTexture;
  if (opts.bumpScale !== undefined) values.bumpScale = opts.bumpScale;
  if (opts.displacementTexture !== undefined) values.displacementTexture = opts.displacementTexture;
  if (opts.occlusionTexture !== undefined) values.occlusionTexture = opts.occlusionTexture;
  if (opts.specularTexture !== undefined) values.specularTexture = opts.specularTexture;
  if (opts.specularColorTexture !== undefined) {
    values.specularColorTexture = opts.specularColorTexture;
  }
  if (opts.alphaCutoff !== undefined) values.alphaCutoff = opts.alphaCutoff;
  if (opts.alphaHash !== undefined) values.alphaHash = Number(opts.alphaHash);
  values.shadowAlphaMode = opts.shadowAlphaMode === 'texture' ? 1 : 0;
  values.alphaMode = opts.alphaMode === 'opaque' ? 1 : opts.alphaMode === 'premultiplied' ? 2 : 0;
  values.alphaToCoverage = Number(opts.renderState?.alphaToCoverageEnabled ?? false);
  if (opts.directMultiscattering === 'lut') values.directMultiscatteringLut = 1;
  if (opts.transmissionTexture !== undefined) values.transmissionTexture = opts.transmissionTexture;
  if (opts.thicknessTexture !== undefined) values.thicknessTexture = opts.thicknessTexture;
  if (opts.attenuationDistance !== undefined) values.attenuationDistance = opts.attenuationDistance;
  const forwardRenderState =
    transmission > 0 ? { depthWriteEnabled: false, ...opts.renderState } : opts.renderState;
  const parameters = standardSurfaceParameters(standardParameters('linear', opts));
  const declaredNames = new Set(parameters.map((parameter) => parameter.name));
  for (const name of Object.keys(values)) {
    if (!declaredNames.has(name)) delete values[name];
  }
  const layerPlan = deriveStandardLayerPlan(
    parameters,
    undefined,
    standardMaterialStaticSwitches(opts.staticSwitches),
  );
  const projected = projectStandardSurfacePasses({
    surfaceModule: DEFAULT_STANDARD_SURFACE_MODULE,
    values,
    ...(forwardRenderState === undefined ? {} : { renderState: forwardRenderState }),
    ...(opts.queue === undefined ? {} : { queue: opts.queue }),
    layerPlan,
  });
  const passes = (
    transmission > 0 ? projected.filter((entry) => entry.name !== 'deferred') : projected
  ) as [MaterialPass, ...MaterialPass[]];
  return {
    kind: 'material',
    colorSpace: 'linear',
    ...(opts.staticSwitches === undefined ? {} : { staticSwitches: opts.staticSwitches }),
    passes,
    parameters,
    values,
  };
}

function standardCustom(opts: CustomStandardSurfaceOptions): MaterialRootAsset {
  const layerPlan = deriveStandardLayerPlan(
    opts.parameters.filter((parameter) => parameter.optional !== true),
    undefined,
    standardMaterialStaticSwitches(opts.staticSwitches),
  );
  return {
    kind: 'material',
    ...(opts.staticSwitches === undefined ? {} : { staticSwitches: opts.staticSwitches }),
    ...(opts.colorSpace === undefined || opts.colorSpace === 'srgb'
      ? {}
      : { colorSpace: opts.colorSpace }),
    passes: projectStandardSurfacePasses({
      surfaceModule: opts.surfaceModule,
      values: opts.values,
      ...(opts.alphaClip === undefined ? {} : { alphaClip: opts.alphaClip }),
      ...(opts.renderState === undefined ? {} : { renderState: opts.renderState }),
      ...(opts.queue === undefined ? {} : { queue: opts.queue }),
      layerPlan,
    }),
    parameters: standardSurfaceParameters(opts.parameters),
    values: opts.values,
  };
}

export function standard(options: StandardOptions): MaterialRootAsset {
  return options.surfaceModule === undefined ? standardDefault(options) : standardCustom(options);
}

/** Diffuse-only authoring inputs; specular and physical layers stay Standard-owned. */
export type LambertOptions = Pick<
  StandardOpts,
  | 'baseColor'
  | 'baseColorTexture'
  | 'alphaTexture'
  | 'alphaChannel'
  | 'normalTexture'
  | 'normalScale'
  | 'normalMapSpace'
  | 'flatShading'
  | 'bumpTexture'
  | 'bumpScale'
  | 'emissive'
  | 'emissiveIntensity'
  | 'emissiveTexture'
  | 'occlusionTexture'
  | 'occlusionStrength'
  | 'alphaCutoff'
  | 'alphaHash'
  | 'triplanar'
  | 'renderState'
  | 'queue'
>;

/**
 * Three.js `MeshLambertMaterial` / Unreal Substrate F0 = 0: the Standard
 * lighting path with metallic 0, roughness 1 and no specular. F90 is derived
 * from F0, so the grazing Fresnel lobe vanishes and only diffuse remains;
 * shadows, IBL irradiance, clustered lights and deferred shading stay shared.
 */
function lambert(options: LambertOptions): MaterialRootAsset {
  return standardDefault({ ...options, metallic: 0, roughness: 1, specular: 0 });
}

export const Materials = { unlit, matcap, normal, lambert, standard, srgb } as const;

export { SPRITE_MODULE };
