import { err, ok, type Result } from '../result.js';

/** Built-in Surface model templates. Content still owns the imported Surface. */
export const MATERIAL_SURFACE_MODELS = ['standard', 'single-layer-medium'] as const;
export type MaterialSurfaceModel = (typeof MATERIAL_SURFACE_MODELS)[number];

/** The first non-Standard model; its name deliberately describes the model. */
export const SINGLE_LAYER_MEDIUM_SURFACE_MODEL = 'single-layer-medium' as const;

/** POD scalar/vector shapes accepted by a read-only dynamic record. */
export type MaterialDynamicFieldType = 'f32' | 'u32' | 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>';

export interface MaterialDynamicInputField {
  readonly name: string;
  readonly type: MaterialDynamicFieldType;
}

/**
 * Root-authored declaration for a bounded, read-only runtime record page.
 * Values in the page are supplied by Render; no live handles or queues cross
 * the asset boundary.
 */
export interface MaterialDynamicInputSchema {
  readonly name: string;
  readonly fields: readonly MaterialDynamicInputField[];
  /** Maximum records addressable by one declared page. */
  readonly maxRecords: number;
  /** Maximum independent producer domains sharing this declaration. */
  readonly maxDomains: number;
  /** Maximum bytes resident for this declaration. */
  readonly maxPageBytes: number;
  /** Maximum bindings the producer may consume for this declaration. */
  readonly maxBindings: number;
  /** Maximum records a Surface may inspect for one covered sample. */
  readonly maxEventsPerSample: number;
}

export interface MaterialDynamicInputLayoutField extends MaterialDynamicInputField {
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
}

/** Compiler-derived record layout shared by CPU encoding and WGSL accessors. */
export interface MaterialDynamicInputLayout {
  readonly name: string;
  readonly stride: number;
  readonly fields: readonly MaterialDynamicInputLayoutField[];
  readonly maxRecords: number;
  readonly maxDomains: number;
  readonly maxPageBytes: number;
  readonly maxBindings: number;
  readonly maxEventsPerSample: number;
  readonly identity: string;
}

export type MaterialDynamicInputLayoutErrorCode =
  | 'invalid-name'
  | 'duplicate-field'
  | 'invalid-field'
  | 'invalid-limit'
  | 'page-too-small';

export interface MaterialDynamicInputLayoutError {
  readonly code: MaterialDynamicInputLayoutErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly field?: string;
  readonly actual?: unknown;
}

function isMaterialDynamicFieldType(value: unknown): value is MaterialDynamicFieldType {
  return (
    value === 'f32' ||
    value === 'u32' ||
    value === 'vec2<f32>' ||
    value === 'vec3<f32>' ||
    value === 'vec4<f32>'
  );
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FIELD_FACTS: Readonly<
  Record<MaterialDynamicFieldType, { readonly size: number; readonly alignment: number }>
> = {
  f32: { size: 4, alignment: 4 },
  u32: { size: 4, alignment: 4 },
  'vec2<f32>': { size: 8, alignment: 8 },
  // WGSL vec3 values occupy a 16-byte aligned slot in a storage struct.
  'vec3<f32>': { size: 12, alignment: 16 },
  'vec4<f32>': { size: 16, alignment: 16 },
};

function materialDynamicFieldFacts(
  type: unknown,
): { readonly size: number; readonly alignment: number } | undefined {
  switch (type) {
    case 'f32':
      return FIELD_FACTS.f32;
    case 'u32':
      return FIELD_FACTS.u32;
    case 'vec2<f32>':
      return FIELD_FACTS['vec2<f32>'];
    case 'vec3<f32>':
      return FIELD_FACTS['vec3<f32>'];
    case 'vec4<f32>':
      return FIELD_FACTS['vec4<f32>'];
    default:
      return undefined;
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function layoutError(
  code: MaterialDynamicInputLayoutErrorCode,
  expected: string,
  hint: string,
  field?: string,
  actual?: unknown,
): MaterialDynamicInputLayoutError {
  return {
    code,
    expected,
    hint,
    ...(field === undefined ? {} : { field }),
    ...(actual === undefined ? {} : { actual }),
  };
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Derive the one record layout used by the producer encoder and Surface
 * accessor.  The result is deterministic and refuses silent truncation.
 */
export function deriveMaterialDynamicInputLayout(
  schema: MaterialDynamicInputSchema,
): Result<MaterialDynamicInputLayout, MaterialDynamicInputLayoutError> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return err(
      layoutError(
        'invalid-name',
        'the dynamic input schema is an object with a WGSL identifier name',
        'provide a plain dynamic input declaration before publishing the material',
        'schema',
        schema,
      ),
    );
  }
  if (typeof schema.name !== 'string' || !IDENTIFIER_RE.test(schema.name)) {
    return err(
      layoutError(
        'invalid-name',
        'the dynamic input name is a WGSL identifier',
        'rename the dynamic input using ASCII letters, digits, and underscores',
        'name',
        schema.name,
      ),
    );
  }
  if (!Array.isArray(schema.fields) || schema.fields.length === 0) {
    return err(
      layoutError(
        'invalid-field',
        'a dynamic input declares at least one field',
        'add a scalar or vector field to the dynamic input schema',
        'fields',
        schema.fields,
      ),
    );
  }
  const limits: readonly [string, number][] = [
    ['maxRecords', schema.maxRecords],
    ['maxDomains', schema.maxDomains],
    ['maxPageBytes', schema.maxPageBytes],
    ['maxBindings', schema.maxBindings],
    ['maxEventsPerSample', schema.maxEventsPerSample],
  ];
  for (const [field, value] of limits) {
    if (!validPositiveInteger(value)) {
      return err(
        layoutError(
          'invalid-limit',
          `${field} is a positive safe integer`,
          'choose an explicit finite producer budget and retry publication',
          field,
          value,
        ),
      );
    }
  }
  const names = new Set<string>();
  let cursor = 0;
  let maxAlignment = 16;
  const fields: MaterialDynamicInputLayoutField[] = [];
  for (const [index, field] of schema.fields.entries()) {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      return err(
        layoutError(
          'invalid-field',
          'every dynamic field is an object with a name and supported type',
          'repair the malformed dynamic input field before publishing the material',
          `fields[${index}]`,
          field,
        ),
      );
    }
    if (typeof field.name !== 'string' || !IDENTIFIER_RE.test(field.name)) {
      return err(
        layoutError(
          'invalid-field',
          'every dynamic field name is a WGSL identifier',
          'rename the field using ASCII letters, digits, and underscores',
          `fields[${index}].name`,
          field.name,
        ),
      );
    }
    if (names.has(field.name)) {
      return err(
        layoutError(
          'duplicate-field',
          'dynamic field names are unique',
          'remove the duplicate field before cooking the material',
          field.name,
          field.name,
        ),
      );
    }
    if (!isMaterialDynamicFieldType(field.type)) {
      return err(
        layoutError(
          'invalid-field',
          'each dynamic field uses a supported scalar or vector type',
          'use f32, u32, vec2<f32>, vec3<f32>, or vec4<f32>',
          `fields[${index}].type`,
          field.type,
        ),
      );
    }
    const facts = materialDynamicFieldFacts(field.type);
    if (facts === undefined) {
      return err(
        layoutError(
          'invalid-field',
          'each dynamic field uses a supported scalar or vector type',
          'use f32, u32, vec2<f32>, vec3<f32>, or vec4<f32>',
          `fields[${index}].type`,
          field.type,
        ),
      );
    }
    names.add(field.name);
    maxAlignment = Math.max(maxAlignment, facts.alignment);
    const offset = alignTo(cursor, facts.alignment);
    fields.push({ ...field, offset, size: facts.size, alignment: facts.alignment });
    cursor = offset + facts.size;
  }
  const stride = alignTo(cursor, maxAlignment);
  const requiredBytes = stride * schema.maxRecords;
  if (
    !Number.isSafeInteger(requiredBytes) ||
    stride > schema.maxPageBytes ||
    requiredBytes > schema.maxPageBytes
  ) {
    return err(
      layoutError(
        'page-too-small',
        'the declared page can hold maxRecords at the derived stride',
        'increase maxPageBytes or reduce maxRecords before publishing the material',
        'maxPageBytes',
        schema.maxPageBytes,
      ),
    );
  }
  const identity = [
    'surface-dynamic-v1',
    schema.name,
    `stride-${stride}`,
    ...fields.map((field) => `${field.name}:${field.type}@${field.offset}`),
    `records-${schema.maxRecords}`,
    `domains-${schema.maxDomains}`,
    `bytes-${schema.maxPageBytes}`,
    `bindings-${schema.maxBindings}`,
    `sample-${schema.maxEventsPerSample}`,
  ].join('/');
  return ok({
    name: schema.name,
    stride,
    fields,
    maxRecords: schema.maxRecords,
    maxDomains: schema.maxDomains,
    maxPageBytes: schema.maxPageBytes,
    maxBindings: schema.maxBindings,
    maxEventsPerSample: schema.maxEventsPerSample,
    identity,
  });
}

/** Root-owned model selection and imported Surface module. */
export interface MaterialSurfaceDeclaration {
  readonly model: MaterialSurfaceModel;
  readonly module: string;
  readonly dynamicInput?: MaterialDynamicInputSchema;
}

/** Runtime shape guard used by pack and catalog boundaries before projection. */
export function isMaterialSurfaceDeclaration(value: unknown): value is MaterialSurfaceDeclaration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const declaration = value as Record<string, unknown>;
  if (
    (declaration.model !== 'standard' && declaration.model !== 'single-layer-medium') ||
    typeof declaration.module !== 'string' ||
    declaration.module.length === 0
  ) {
    return false;
  }
  if (declaration.dynamicInput === undefined) return true;
  if (declaration.dynamicInput === null || typeof declaration.dynamicInput !== 'object') {
    return false;
  }
  return deriveMaterialDynamicInputLayout(declaration.dynamicInput as MaterialDynamicInputSchema)
    .ok;
}
