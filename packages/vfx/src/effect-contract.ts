import { err, ok, type Result } from '@forgeax/engine-types';
import type { VfxDataInterfaceRequirement } from './data-interface.js';
import type { VfxCustomLayout, VfxParticleCoreLayout } from './particle-layout.js';

export type VfxValue = number | readonly number[];
export type VfxValueMap = Readonly<Record<string, VfxValue>>;

export interface VfxReflectedField {
  readonly name: string;
  readonly type: VfxValueType;
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
  readonly defaultValue?: VfxValue;
}

export interface VfxReflectedStruct {
  readonly name: string;
  readonly fields: readonly VfxReflectedField[];
  readonly size: number;
  readonly alignment: number;
}

export interface VfxEffectReflection {
  /** The single executable particle data ABI. */
  readonly version: 3;
  readonly parameters: VfxReflectedStruct;
  readonly custom: VfxReflectedStruct;
  readonly core: VfxParticleCoreLayout;
  readonly customLayout: VfxCustomLayout;
  readonly dataInterfaces?: readonly VfxDataInterfaceRequirement[];
  readonly fingerprint: string;
}

export interface VfxEffectContractErrorDetail {
  readonly path: string;
  readonly actual?: unknown;
}

export interface VfxEffectContractError {
  readonly code:
    | 'vfx-value-unknown-field'
    | 'vfx-value-type-mismatch'
    | 'vfx-value-not-finite'
    | 'vfx-reflection-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: VfxEffectContractErrorDetail;
}

export interface VfxEffectContract<Values extends VfxValueMap = VfxValueMap> {
  readonly reflection: VfxEffectReflection;
  readonly fingerprint: string;
  readonly packedSize: number;
  /** Bytes in the effect-instance Parameters uniform. */
  readonly parameterSize: number;
  /** Bytes in one persistent per-particle Custom record. */
  readonly customStride: number;
  readonly defaults: Values;
  createValues(initial?: Partial<Values>): Result<Values, VfxEffectContractError>;
  validateValues(values: VfxValueMap): Result<Values, VfxEffectContractError>;
  pack(values: Values): Result<Uint8Array, VfxEffectContractError>;
  packParameters(values: Values): Result<Uint8Array, VfxEffectContractError>;
  packCustom(values: VfxValueMap): Result<Uint8Array, VfxEffectContractError>;
}

const VECTOR_LENGTH = {
  f32: 1,
  i32: 1,
  u32: 1,
  'vec2<f32>': 2,
  'vec3<f32>': 3,
  'vec4<f32>': 4,
};

export type VfxValueType = keyof typeof VECTOR_LENGTH;

function fieldList(
  reflection: VfxEffectReflection,
  includeCustom = false,
): readonly VfxReflectedField[] {
  return includeCustom
    ? [...reflection.parameters.fields, ...reflection.custom.fields]
    : reflection.parameters.fields;
}

function zeroValue(type: VfxValueType): VfxValue {
  const length = VECTOR_LENGTH[type];
  return length === 1 ? 0 : Array.from({ length }, () => 0);
}

function valueMatches(type: VfxValueType, value: unknown): boolean {
  const length = VECTOR_LENGTH[type];
  if (length === 1) return typeof value === 'number' && Number.isFinite(value);
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((component) => typeof component === 'number' && Number.isFinite(component))
  );
}

function fail(
  code: VfxEffectContractError['code'],
  path: string,
  expected: string,
  hint: string,
  actual?: unknown,
): Result<never, VfxEffectContractError> {
  return err({
    code,
    expected,
    hint,
    detail: actual === undefined ? { path } : { path, actual },
  });
}

function validateReflection(reflection: VfxEffectReflection): Result<true, VfxEffectContractError> {
  if (
    reflection.version !== 3 ||
    typeof reflection.fingerprint !== 'string' ||
    !reflection.fingerprint.startsWith('sha256:')
  ) {
    return fail(
      'vfx-reflection-invalid',
      'reflection',
      'a version 3 reflection with a sha256 fingerprint',
      'recook the effect with the current VFX compiler',
    );
  }
  if (
    reflection.core.name !== 'VfxParticle' ||
    reflection.core.stride !== 112 ||
    reflection.core.fields.length === 0 ||
    reflection.customLayout.name !== 'VfxCustom' ||
    reflection.customLayout.stride < 0 ||
    reflection.customLayout.lanes < 0
  ) {
    return fail(
      'vfx-reflection-invalid',
      'reflection.core',
      'Program v3 Core and Custom layouts derived from the particle schema',
      'recook the effect with the current VFX compiler',
    );
  }
  const names = new Set<string>();
  for (const field of fieldList(reflection)) {
    if (names.has(field.name)) {
      return fail(
        'vfx-reflection-invalid',
        field.name,
        'unique field names across parameters and custom data',
        'rename the duplicate WGSL field and recook',
      );
    }
    names.add(field.name);
  }
  return ok(true);
}

function defaultsFor<Values extends VfxValueMap>(reflection: VfxEffectReflection): Values {
  const defaults: Record<string, VfxValue> = {};
  for (const field of fieldList(reflection)) {
    defaults[field.name] =
      field.defaultValue === undefined ? zeroValue(field.type) : field.defaultValue;
  }
  return Object.freeze(defaults) as Values;
}

function validateMap<Values extends VfxValueMap>(
  reflection: VfxEffectReflection,
  values: VfxValueMap,
): Result<Values, VfxEffectContractError> {
  return validateMapAgainstFields<Values>(fieldList(reflection), values);
}

function validateMapAgainstFields<Values extends VfxValueMap>(
  reflectedFields: readonly VfxReflectedField[],
  values: VfxValueMap,
): Result<Values, VfxEffectContractError> {
  const fields = new Map(reflectedFields.map((field) => [field.name, field]));
  for (const name of Object.keys(values)) {
    const field = fields.get(name);
    if (field === undefined) {
      return fail(
        'vfx-value-unknown-field',
        name,
        'a field declared by the selected VFX data scope',
        `remove ${name} or declare it in the authored WGSL struct`,
        values[name],
      );
    }
    if (!valueMatches(field.type, values[name])) {
      return fail(
        'vfx-value-type-mismatch',
        name,
        field.type,
        `provide ${name} as ${field.type}`,
        values[name],
      );
    }
  }
  return ok(Object.freeze({ ...values }) as Values);
}

function writeValue(view: DataView, offset: number, type: VfxValueType, value: VfxValue): void {
  const values = typeof value === 'number' ? [value] : value;
  for (let index = 0; index < values.length; index += 1) {
    const component = values[index] ?? 0;
    if (type === 'i32') view.setInt32(offset + index * 4, component, true);
    else if (type === 'u32') view.setUint32(offset + index * 4, component, true);
    else view.setFloat32(offset + index * 4, component, true);
  }
}

export function createVfxEffectContract<Values extends VfxValueMap = VfxValueMap>(
  reflection: VfxEffectReflection,
): VfxEffectContract<Values> {
  const checked = validateReflection(reflection);
  if (!checked.ok) throw new TypeError(checked.error.hint);
  const defaults = defaultsFor<Values>(reflection);
  const customBase = reflection.parameters.size;
  const parameterSize = reflection.parameters.size;
  const customStride = reflection.customLayout.stride;
  const packedSize = customBase;
  const packFields = (
    values: VfxValueMap,
    selected: readonly VfxReflectedField[],
    size: number,
    baseOffset: number,
  ): Result<Uint8Array, VfxEffectContractError> => {
    const checkedValues = validateMapAgainstFields<Values>(selected, values);
    if (!checkedValues.ok) return checkedValues;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    for (const field of selected) {
      const value = checkedValues.value[field.name];
      if (value === undefined) continue;
      writeValue(view, baseOffset + field.offset, field.type, value);
    }
    return ok(bytes);
  };
  return {
    reflection,
    fingerprint: reflection.fingerprint,
    packedSize,
    parameterSize: reflection.parameters.size,
    customStride,
    defaults,
    createValues(initial = {} as Partial<Values>) {
      const merged = { ...defaults, ...initial };
      return validateMap<Values>(reflection, merged);
    },
    validateValues(values) {
      return validateMap<Values>(reflection, values);
    },
    pack(values) {
      return packFields(values, reflection.parameters.fields, parameterSize, 0);
    },
    packParameters(values) {
      return packFields(values, reflection.parameters.fields, parameterSize, 0);
    },
    packCustom(values) {
      return packFields(values, reflection.custom.fields, customStride, 0);
    },
  };
}

export function validateVfxEffectValues(
  reflection: VfxEffectReflection,
  values: VfxValueMap,
): Result<VfxValueMap, VfxEffectContractError> {
  return validateMap(reflection, values);
}
