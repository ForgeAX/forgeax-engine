import type { AssetGuid } from '../index.js';
import type { ParamSchemaEntry } from '../material-contracts.js';
import { isMaterialProgramBindingContract } from '../material-program-abi.js';
import { err, ok, type Result } from '../result.js';
import type { MaterialColorSpace } from './color-space.js';
import {
  createMaterialError,
  MATERIAL_ERROR_EXPECTED,
  MATERIAL_ERROR_HINTS,
  type MaterialChildContractInvalidDetail,
  type MaterialError,
} from './errors.js';
import type { MaterialParticleInput } from './particle-input.js';
import {
  MATERIAL_STATIC_SWITCH_NAMES,
  type MaterialStaticSwitches,
  standardMaterialParameterEnabled,
} from './static-switches.js';
import {
  deriveMaterialDynamicInputLayout,
  type MaterialDynamicInputSchema,
  type MaterialSurfaceDeclaration,
} from './surface-model.js';

export type MaterialParameterType =
  | 'bool'
  | 'f32'
  | 'i32'
  | 'u32'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'color'
  | MaterialTextureParameterType;

/**
 * Texture parameter view dimensions. `texture` is a 2D view; the others name
 * their WGSL view (`texture_2d_array`, `texture_3d`, `texture_cube`).
 * `texture_external` declares a `texture_external` WGSL slot sampled with
 * `textureSampleBaseClampToEdge`; it binds an imported video frame (zero-copy)
 * or a 2D texture view.
 */
export type MaterialTextureParameterType =
  | 'texture'
  | 'texture_2d_array'
  | 'texture_3d'
  | 'texture_cube'
  | 'texture_external';

/** Narrow a parameter type to the texture family. */
export function isMaterialTextureParameterType(
  type: unknown,
): type is MaterialTextureParameterType {
  return (
    type === 'texture' ||
    type === 'texture_2d_array' ||
    type === 'texture_3d' ||
    type === 'texture_cube' ||
    type === 'texture_external'
  );
}

/** The derived binding type of one texture parameter. */
export function materialTextureBindingType(
  type: MaterialTextureParameterType,
): 'texture2d' | 'texture2d_array' | 'texture3d' | 'texture_cube' | 'texture_external' {
  switch (type) {
    case 'texture':
      return 'texture2d';
    case 'texture_2d_array':
      return 'texture2d_array';
    case 'texture_3d':
      return 'texture3d';
    case 'texture_cube':
      return 'texture_cube';
    case 'texture_external':
      return 'texture_external';
  }
}

export interface MaterialParameter {
  readonly name: string;
  readonly type: MaterialParameterType;
  /**
   * Asset-side transfer function for an authored color value. `color`
   * parameters default to `srgb`; numeric vectors default to linear unless
   * explicitly tagged. An asset-level `colorSpace` overrides this schema
   * default. Runtime material values are always linear.
   */
  readonly colorSpace?: MaterialColorSpace;
  /** Texture binding contract; load-only float data can omit filtering support. */
  readonly sampleType?: 'float' | 'unfilterable-float';
  readonly default?: MaterialValue;
  readonly optional?: boolean;
}

/**
 * Lower authored MaterialParameter declarations to the generic ParamSchema ABI.
 * `bool` has no uniform ABI and fails at the first offending declaration.
 */
export function projectMaterialParameterSchema(
  parameters: readonly MaterialParameter[],
  material: string,
  stage: 'cook' | 'runtime',
  staticSwitches?: MaterialStaticSwitches,
): Result<readonly ParamSchemaEntry[], MaterialError> {
  const schema: ParamSchemaEntry[] = [];
  for (const parameter of parameters) {
    if (!standardMaterialParameterEnabled(parameter, staticSwitches)) continue;
    if (parameter.type === 'bool') {
      return err(
        createMaterialError('material-parameter-type-unsupported', {
          code: 'material-parameter-type-unsupported',
          stage,
          material,
          parameter: parameter.name,
          type: parameter.type,
          action: 'use-supported-type',
        }),
      );
    }
    if (isMaterialTextureParameterType(parameter.type)) {
      schema.push({
        name: parameter.name,
        type: materialTextureBindingType(parameter.type),
        ...(parameter.sampleType === undefined ? {} : { sampleType: parameter.sampleType }),
      });
      continue;
    }
    const value = parameter.default;
    schema.push({
      name: parameter.name,
      type: parameter.type,
      ...(parameter.colorSpace === undefined ? {} : { colorSpace: parameter.colorSpace }),
      ...(typeof value === 'number' ||
      (Array.isArray(value) && value.every((item) => typeof item === 'number'))
        ? { default: value }
        : {}),
    });
  }
  return ok(schema);
}

export interface MaterialTextureCoordinates {
  readonly set?: number;
  /** Producer-owned logical-to-physical texture extent correction. */
  readonly physicalUvScale?: readonly [number, number];
  readonly transform?: {
    readonly offset?: readonly [number, number];
    readonly scale?: readonly [number, number];
    readonly rotation?: number;
  };
}

export interface ResolvedMaterialTextureCoordinates {
  readonly set: number;
  readonly transform: {
    readonly offset: readonly [number, number];
    readonly scale: readonly [number, number];
    readonly rotation: number;
  };
}

export function resolveMaterialTextureCoordinates(
  coordinates?: MaterialTextureCoordinates,
): ResolvedMaterialTextureCoordinates {
  return {
    set: coordinates?.set ?? 0,
    transform: {
      offset: coordinates?.transform?.offset ?? [0, 0],
      scale: coordinates?.transform?.scale ?? [1, 1],
      rotation: coordinates?.transform?.rotation ?? 0,
    },
  };
}

export type MaterialTextureReference = AssetGuid | number | string;

export interface MaterialTextureValue {
  readonly texture: MaterialTextureReference;
  readonly sampler?: MaterialTextureReference;
  readonly coordinates?: MaterialTextureCoordinates;
  readonly occlusionStrength?: number;
}

export type MaterialValue = boolean | number | readonly number[] | string | MaterialTextureValue;

export interface MaterialProgram {
  /** Defaults to the ordinary Render material interface. Cook checks reflected resources. */
  readonly bindings?: import('../material-program-abi.js').MaterialProgramBindingContract;
  readonly sceneDepth?: import('../material-program-abi.js').MaterialSceneDepth;
  readonly module: string;
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
  readonly moduleSlots?: Readonly<Record<string, string>>;
}

/** Ordered fragment outputs: array index is WGSL @location(index). */
export interface MaterialColorOutput {
  readonly name: string;
  readonly format: GPUTextureFormat;
  /** Omitted means replacement, independently of the pass-wide blend. */
  readonly blend?: GPUBlendState;
  readonly writeMask?: GPUColorWriteFlags;
}

export interface MaterialPass {
  readonly name: string;
  readonly program: MaterialProgram;
  readonly outputs?: readonly MaterialColorOutput[];
  readonly renderState?: Readonly<Record<string, unknown>>;
}

export type MaterialPassList = readonly [MaterialPass, ...MaterialPass[]];

/**
 * Root-owned material contract. A root owns the pass and parameter schema;
 * descendants select it through `parent` and may only author runtime values.
 */
export interface MaterialRootAsset {
  readonly kind: 'material';
  /**
   * Transfer function override for all authored color parameters. Omitted
   * parameters ultimately default to sRGB.
   * Explicit `linear` is reserved for physical/imported data such as glTF
   * factors. Numeric values are never rewritten when this metadata changes.
   */
  readonly colorSpace?: MaterialColorSpace;
  readonly parent?: never;
  readonly passes?: MaterialPassList;
  readonly parameters?: readonly MaterialParameter[];
  readonly staticSwitches?: MaterialStaticSwitches;
  readonly values?: Readonly<Record<string, MaterialValue | null>>;
  /** Typed values exposed by a VFX material to the particle instance stream. */
  readonly particleInputs?: readonly MaterialParticleInput[];
  /** Engine-owned Surface model and imported implementation. */
  readonly surface?: MaterialSurfaceDeclaration;
}

/**
 * Minimal parent-bearing material contract. The root supplies color space,
 * passes, and parameters during resolution; a child can only override values.
 */
export interface MaterialChildAsset {
  readonly kind: 'material';
  readonly parent: AssetGuid;
  readonly colorSpace?: never;
  readonly passes?: never;
  readonly parameters?: never;
  readonly staticSwitches?: MaterialStaticSwitches;
  readonly values?: Readonly<Record<string, MaterialValue | null>>;
  readonly particleInputs?: readonly MaterialParticleInput[];
  readonly surface?: never;
}

/**
 * One authored material subject. Pack publishes the resolved contract;
 * runtime and render consume read-only projections. Values and module slots
 * are runtime data with a closed compiler context. Static switches select
 * compiled features; compiler macros are derived from that selection.
 */
export type MaterialAsset = MaterialRootAsset | MaterialChildAsset;

export const MATERIAL_CHILD_FORBIDDEN_FIELDS = [
  'colorSpace',
  'passes',
  'parameters',
  'surface',
] as const;
export type MaterialChildForbiddenField = (typeof MATERIAL_CHILD_FORBIDDEN_FIELDS)[number];

function hasOwn(value: object, field: PropertyKey): boolean {
  return Object.hasOwn(value, field);
}

/** Return the root-owned fields that make a parent-bearing child invalid. */
export function materialChildForbiddenFields(
  asset: MaterialAsset,
): readonly MaterialChildForbiddenField[] {
  if (asset.parent === undefined) return [];
  return MATERIAL_CHILD_FORBIDDEN_FIELDS.filter((field) => hasOwn(asset, field));
}

function materialParentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return String(value);
}

export interface MaterialAuthoringErrorDetail {
  readonly code: 'material-authoring-field-forbidden';
  readonly owner: 'material-runtime' | 'material-authoring';
  readonly field: string;
  readonly actual: unknown;
  readonly action: 'remove-field';
}

export class MaterialAssetContractError extends Error {
  readonly code = 'material-authoring-field-forbidden' as const;
  readonly expected =
    'material authoring contains only runtime values and source-owned module selection';
  readonly hint =
    'remove the compiler macro field and use a runtime value, module slot, or compiler context';
  readonly detail: MaterialAuthoringErrorDetail;

  constructor(detail: Omit<MaterialAuthoringErrorDetail, 'code'>) {
    super(`${detail.field}: material compiler macro fields are not supported`);
    this.name = 'MaterialAssetContractError';
    this.detail = { code: 'material-authoring-field-forbidden', ...detail };
  }
}

/** Structured loading-boundary failure for a non-minimal derived material. */
export class MaterialChildContractError extends Error {
  readonly code = 'material-child-contract-invalid' as const;
  readonly expected = MATERIAL_ERROR_EXPECTED['material-child-contract-invalid'];
  readonly hint = MATERIAL_ERROR_HINTS['material-child-contract-invalid'];
  readonly detail: MaterialChildContractInvalidDetail;

  constructor(detail: Omit<MaterialChildContractInvalidDetail, 'code'>) {
    super(`${detail.material}: parent-bearing material contains forbidden fields`);
    this.name = 'MaterialChildContractError';
    this.detail = { code: 'material-child-contract-invalid', ...detail };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate JSON-authored material descriptors at their loading boundary. */
export function assertMaterialAsset(
  value: unknown,
  context = 'material',
): asserts value is MaterialAsset {
  if (!isRecord(value) || value.kind !== 'material') {
    throw new Error(`${context}: expected a material asset`);
  }
  for (const field of Object.keys(value)) {
    if (
      ![
        'kind',
        'colorSpace',
        'parent',
        'passes',
        'parameters',
        'staticSwitches',
        'values',
        'particleInputs',
        'surface',
      ].includes(field)
    ) {
      throw new MaterialAssetContractError({
        owner:
          field === 'features' || field === 'defines' ? 'material-authoring' : 'material-runtime',
        field,
        actual: value[field],
        action: 'remove-field',
      });
    }
  }
  const forbidden = materialChildForbiddenFields(value as unknown as MaterialAsset);
  if (value.staticSwitches !== undefined) {
    if (!isRecord(value.staticSwitches))
      throw new MaterialAssetContractError({
        owner: 'material-authoring',
        field: 'staticSwitches',
        actual: value.staticSwitches,
        action: 'remove-field',
      });
    for (const [name, enabled] of Object.entries(value.staticSwitches)) {
      if (
        !(MATERIAL_STATIC_SWITCH_NAMES as readonly string[]).includes(name) ||
        typeof enabled !== 'boolean'
      )
        throw new MaterialAssetContractError({
          owner: 'material-authoring',
          field: `staticSwitches.${name}`,
          actual: enabled,
          action: 'remove-field',
        });
    }
  }
  if (forbidden.length > 0) {
    throw new MaterialChildContractError({
      material: context,
      parent: materialParentText(value.parent),
      forbidden,
      action: 'remove-forbidden-fields',
    });
  }
  if (
    value.colorSpace !== undefined &&
    value.colorSpace !== 'srgb' &&
    value.colorSpace !== 'linear'
  ) {
    throw new Error(`${context}: invalid colorSpace`);
  }
  if (value.passes !== undefined) {
    if (!Array.isArray(value.passes) || value.passes.length === 0) {
      throw new Error(`${context}: passes must be a non-empty array`);
    }
    for (const [index, pass] of value.passes.entries()) {
      if (!isRecord(pass) || typeof pass.name !== 'string' || !isRecord(pass.program)) {
        throw new Error(`${context}: pass ${index} is malformed`);
      }
      const outputs = validateMaterialOutputs(pass.outputs, context, pass.name);
      if (!outputs.ok) throw Object.assign(new Error(outputs.error.expected), outputs.error);
      if (typeof pass.program.module !== 'string' || pass.program.module.length === 0) {
        throw new Error(`${context}: pass ${index} has no module identity`);
      }
      if (
        pass.program.bindings !== undefined &&
        !isMaterialProgramBindingContract(pass.program.bindings)
      )
        throw new Error(`${context}: pass ${index} has an invalid binding contract`);
      if (
        pass.program.sceneDepth !== undefined &&
        pass.program.sceneDepth !== 'read-only' &&
        pass.program.sceneDepth !== 'before-pass'
      )
        throw new Error(`${context}: pass ${index} has an invalid scene-depth version`);
      if (
        (pass.program.vertexEntry !== undefined && typeof pass.program.vertexEntry !== 'string') ||
        (pass.program.fragmentEntry !== undefined && typeof pass.program.fragmentEntry !== 'string')
      ) {
        throw new Error(`${context}: pass ${index} has malformed entry points`);
      }
      if (pass.program.moduleSlots !== undefined) {
        if (!isRecord(pass.program.moduleSlots)) {
          throw new Error(`${context}: pass ${index} has malformed module slots`);
        }
        for (const [name, slot] of Object.entries(pass.program.moduleSlots)) {
          if (typeof slot !== 'string')
            throw new Error(`${context}: module slot ${name} is not a string`);
        }
      }
    }
  }
  if (value.parameters !== undefined) {
    if (!Array.isArray(value.parameters))
      throw new Error(`${context}: parameters must be an array`);
    for (const [index, parameter] of value.parameters.entries()) {
      if (
        !isRecord(parameter) ||
        typeof parameter.name !== 'string' ||
        typeof parameter.type !== 'string'
      ) {
        throw new Error(`${context}: parameter ${index} is malformed`);
      }
      if (
        parameter.colorSpace !== undefined &&
        parameter.colorSpace !== 'srgb' &&
        parameter.colorSpace !== 'linear'
      ) {
        throw new Error(`${context}: parameter ${index} has invalid colorSpace`);
      }
      if (
        parameter.sampleType !== undefined &&
        (!isMaterialTextureParameterType(parameter.type) ||
          (parameter.sampleType !== 'float' && parameter.sampleType !== 'unfilterable-float') ||
          (parameter.type === 'texture_external' && parameter.sampleType !== 'float'))
      ) {
        throw new Error(`${context}: parameter ${index} has invalid sampleType`);
      }
      if ('static' in parameter) {
        throw new MaterialAssetContractError({
          owner: 'material-authoring',
          field: 'parameters.static',
          actual: parameter.static,
          action: 'remove-field',
        });
      }
    }
  }
  if (value.particleInputs !== undefined) {
    if (!Array.isArray(value.particleInputs) || value.particleInputs.length > 4) {
      throw new Error(`${context}: particleInputs must contain at most four entries`);
    }
    const names = new Set<string>();
    const lanes = new Set<number>();
    for (const [index, input] of value.particleInputs.entries()) {
      if (
        !isRecord(input) ||
        typeof input.name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name) ||
        !['f32', 'vec2<f32>', 'vec3<f32>', 'vec4<f32>'].includes(String(input.type)) ||
        !['vertex', 'fragment', 'vertex-fragment'].includes(String(input.visibility)) ||
        !Number.isInteger(input.lane) ||
        (input.lane as number) < 0 ||
        (input.lane as number) >= 4
      ) {
        throw new Error(`${context}: particle input ${index} is malformed`);
      }
      if (names.has(input.name) || lanes.has(input.lane as number)) {
        throw new Error(`${context}: duplicate particle input ${input.name}`);
      }
      names.add(input.name);
      lanes.add(input.lane as number);
    }
  }
  if (value.surface !== undefined) {
    if (!isRecord(value.surface)) throw new Error(`${context}: surface must be an object`);
    if (value.surface.model !== 'standard' && value.surface.model !== 'single-layer-medium') {
      throw new Error(`${context}: invalid Surface model`);
    }
    if (typeof value.surface.module !== 'string' || value.surface.module.length === 0) {
      throw new Error(`${context}: Surface module must be a non-empty string`);
    }
    if (value.surface.dynamicInput !== undefined) {
      const dynamic = value.surface.dynamicInput;
      if (!isRecord(dynamic)) {
        throw new Error(`${context}: dynamicInput must be an object`);
      }
      const layout = deriveMaterialDynamicInputLayout(
        dynamic as unknown as MaterialDynamicInputSchema,
      );
      if (!layout.ok) {
        throw new Error(`${context}: dynamicInput ${layout.error.code}: ${layout.error.expected}`);
      }
    }
  }
}

/** Validate the asset declaration before shader publication or GPU allocation. */
export function validateMaterialOutputs(
  outputs: unknown,
  material: string,
  pass: string,
): Result<void, MaterialError> {
  const fail = (location: number, reason: string) =>
    err(
      createMaterialError('material-output-contract-invalid', {
        code: 'material-output-contract-invalid',
        material,
        pass,
        location,
        reason,
      }),
    );
  if (outputs === undefined) return ok(undefined);
  if (!Array.isArray(outputs) || outputs.length === 0) return fail(-1, 'outputs must be non-empty');
  const names = new Set<string>();
  for (const [location, output] of outputs.entries()) {
    if (
      !isRecord(output) ||
      typeof output.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(output.name)
    )
      return fail(location, 'output name must be an identifier');
    if (names.has(output.name)) return fail(location, 'output names must be unique');
    names.add(output.name);
    if (
      typeof output.format !== 'string' ||
      !/^(?:(?:r|rg|rgba)(?:8(?:unorm|snorm|uint|sint)|16(?:uint|sint|float)|32(?:uint|sint|float))|rgba8unorm-srgb|bgra8unorm(?:-srgb)?|rgb10a2(?:uint|unorm)|rg11b10ufloat)$/.test(
        output.format,
      )
    )
      return fail(location, 'output format must be a color attachment format');
    if (output.blend !== undefined && /(?:uint|sint)$/.test(output.format))
      return fail(location, 'integer outputs cannot blend');
    if (
      output.writeMask !== undefined &&
      (!Number.isInteger(output.writeMask) ||
        Number(output.writeMask) < 0 ||
        Number(output.writeMask) > 15)
    )
      return fail(location, 'writeMask must contain only RGBA bits');
  }
  return ok(undefined);
}
