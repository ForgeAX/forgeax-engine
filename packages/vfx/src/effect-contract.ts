import { err, ok, type Result, WGSL_NUMERIC_LAYOUT } from '@forgeax/engine-types';
import type { VfxDataInterfaceRequirement } from './data-interface.js';
import type { VfxCustomLayout, VfxParticleCoreLayout } from './particle-layout.js';
import { deriveVfxCustomLayout, VFX_PARTICLE_CORE_LAYOUT } from './particle-layout.js';

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

export type VfxValueType = keyof typeof WGSL_NUMERIC_LAYOUT;

function fieldList(
  reflection: VfxEffectReflection,
  includeCustom = false,
): readonly VfxReflectedField[] {
  return includeCustom
    ? [...reflection.parameters.fields, ...reflection.custom.fields]
    : reflection.parameters.fields;
}

function zeroValue(type: VfxValueType): VfxValue {
  const length = WGSL_NUMERIC_LAYOUT[type].size / 4;
  return length === 1 ? 0 : Array.from({ length }, () => 0);
}

function valueMatches(type: VfxValueType, value: unknown): boolean {
  const length = WGSL_NUMERIC_LAYOUT[type].size / 4;
  if (length === 1)
    return (
      typeof value === 'number' &&
      Number.isFinite(Math.fround(value)) &&
      (type === 'f32' ||
        (Number.isInteger(value) &&
          (type === 'u32'
            ? value >= 0 && value <= 0xffffffff
            : value >= -0x80000000 && value <= 0x7fffffff)))
    );
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(
      (component) => typeof component === 'number' && Number.isFinite(Math.fround(component)),
    )
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

/** Validate the executable byte layout before any CPU pack or GPU allocation. */
export function validateVfxEffectReflection(
  input: unknown,
): Result<VfxEffectReflection, VfxEffectContractError> {
  const invalid = (path: string) =>
    fail(
      'vfx-reflection-invalid',
      path,
      'a bounded Program v3 layout consistent with its field offsets and types',
      'recook the effect with the current VFX compiler',
    );
  if (input === null || typeof input !== 'object') return invalid('reflection');
  const reflection = input as VfxEffectReflection;
  if (
    reflection.version !== 3 ||
    typeof reflection.fingerprint !== 'string' ||
    !reflection.fingerprint.startsWith('sha256:')
  )
    return invalid('reflection');
  for (const [name, struct] of [
    ['VfxParameters', reflection.parameters],
    ['VfxCustom', reflection.custom],
  ] as const) {
    if (
      struct?.name !== name ||
      !Array.isArray(struct.fields) ||
      !Number.isSafeInteger(struct.size) ||
      struct.size < 0 ||
      struct.size > 65536 ||
      ![1, 4, 8, 16].includes(struct.alignment) ||
      struct.size % struct.alignment !== 0
    )
      return invalid(name);
    const names = new Set<string>();
    let end = 0;
    for (const field of struct.fields) {
      if (
        field === null ||
        typeof field !== 'object' ||
        typeof field.name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) ||
        names.has(field.name) ||
        !Object.hasOwn(WGSL_NUMERIC_LAYOUT, field.type)
      )
        return invalid(name);
      const { size, alignment } = WGSL_NUMERIC_LAYOUT[field.type as VfxValueType];
      if (
        field.size !== size ||
        field.alignment !== alignment ||
        !Number.isSafeInteger(field.offset) ||
        field.offset < end ||
        field.offset % alignment !== 0 ||
        field.offset + field.size > struct.size ||
        alignment > struct.alignment
      )
        return invalid(`${name}.${field.name}`);
      if (field.defaultValue !== undefined && !valueMatches(field.type, field.defaultValue))
        return invalid(`${name}.${field.name}.defaultValue`);
      names.add(field.name);
      end = field.offset + field.size;
    }
  }
  const core = reflection.core,
    expected = VFX_PARTICLE_CORE_LAYOUT;
  if (
    core?.name !== expected.name ||
    core.stride !== expected.stride ||
    core.size !== expected.size ||
    core.alignment !== expected.alignment ||
    !Array.isArray(core.fields) ||
    core.fields.length !== expected.fields.length ||
    core.fields.some((field, index) => {
      const canonical = expected.fields[index];
      return (
        canonical === undefined ||
        field.name !== canonical.name ||
        field.type !== canonical.type ||
        field.offset !== canonical.offset ||
        field.size !== canonical.size ||
        field.alignment !== canonical.alignment
      );
    })
  )
    return invalid('reflection.core');
  let custom: ReturnType<typeof deriveVfxCustomLayout>;
  try {
    custom = deriveVfxCustomLayout(reflection.custom);
  } catch {
    return invalid('reflection.customLayout');
  }
  if (
    reflection.customLayout?.name !== custom.name ||
    reflection.customLayout.stride !== custom.stride ||
    reflection.customLayout.lanes !== custom.lanes ||
    reflection.customLayout.size !== custom.size ||
    reflection.customLayout.alignment !== custom.alignment ||
    !Array.isArray(reflection.customLayout.fields) ||
    reflection.customLayout.fields.length !== custom.fields.length ||
    custom.fields.some((field, index) => {
      const actual = reflection.customLayout.fields[index];
      return (
        actual === undefined ||
        actual.name !== field.name ||
        actual.type !== field.type ||
        actual.offset !== field.offset ||
        actual.size !== field.size ||
        actual.alignment !== field.alignment
      );
    })
  )
    return invalid('reflection.customLayout');
  return ok(reflection);
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
  const checked = validateVfxEffectReflection(reflection);
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
