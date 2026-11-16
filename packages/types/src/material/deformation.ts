import { sha256 } from '../sha256.js';
import {
  deriveMaterialDynamicInputLayout,
  type MaterialDynamicInputField,
  type MaterialDynamicInputLayout,
} from './surface-model.js';

export const WATER_DEFORMATION_VERSION = 'water-deformation/1' as const;
export const WATER_DEFORMATION_INPUTS = Object.freeze([
  { name: 'positionM', type: 'vec3<f32>' },
  { name: 'previousPositionM', type: 'vec3<f32>' },
  { name: 'normalYUp', type: 'vec3<f32>' },
  { name: 'viewOriginM', type: 'vec3<f32>' },
  { name: 'waveRelativeXZ', type: 'vec2<f32>' },
  { name: 'vertexFlowMPerSec', type: 'vec2<f32>' },
  { name: 'timeSeconds', type: 'f32' },
  { name: 'prevTimeSeconds', type: 'f32' },
  { name: 'bodyRenderIndex', type: 'u32' },
  { name: 'waveBodyRenderIndex', type: 'u32' },
  { name: 'waterInfoSlice', type: 'u32' },
  { name: 'waterInfoEncoding', type: 'u32' },
  { name: 'waveFirst', type: 'u32' },
  { name: 'waveCount', type: 'u32' },
  { name: 'displacementMode', type: 'u32' },
] satisfies readonly MaterialDynamicInputField[]);

/** Root-owned source and its immutable, versioned vertex contract. Children inherit it. */
export interface MaterialDeformationDeclaration {
  readonly module: string;
  readonly version: typeof WATER_DEFORMATION_VERSION;
  readonly inputs: readonly MaterialDynamicInputField[];
}

export interface MaterialDeformationProgramAbi extends MaterialDeformationDeclaration {
  readonly inputLayout: MaterialDynamicInputLayout;
  readonly inputLayoutHash: string;
  readonly outputAbi: 'WaterDeformationOutput';
  readonly variants: readonly ['color', 'depth', 'shadow', 'velocity'];
}

/** One input manifest derives the CPU metadata and the canonical WGSL struct. */
export function waterDeformationInputLayout(): MaterialDynamicInputLayout {
  const result = deriveMaterialDynamicInputLayout({
    name: 'WaterDeformationInput',
    fields: WATER_DEFORMATION_INPUTS,
    maxRecords: 1,
    maxDomains: 1,
    maxPageBytes: 256,
    maxBindings: 9,
    maxEventsPerSample: 1,
  });
  if (!result.ok) throw new Error(result.error.expected);
  return result.value;
}

export function waterDeformationInputLayoutHash(): string {
  return sha256(JSON.stringify(waterDeformationInputLayout()));
}

export function isMaterialDeformationDeclaration(
  value: unknown,
): value is MaterialDeformationDeclaration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const declaration = value as Record<string, unknown>;
  const inputs = declaration.inputs;
  return (
    Object.keys(declaration).every((key) => ['module', 'version', 'inputs'].includes(key)) &&
    declaration.version === WATER_DEFORMATION_VERSION &&
    typeof declaration.module === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_.-]*(?:::[A-Za-z_][A-Za-z0-9_.-]*)*$/.test(declaration.module) &&
    Array.isArray(inputs) &&
    inputs.length === WATER_DEFORMATION_INPUTS.length &&
    WATER_DEFORMATION_INPUTS.every((expected, index) => {
      const field: unknown = inputs[index];
      return (
        field !== null &&
        typeof field === 'object' &&
        !Array.isArray(field) &&
        Object.keys(field).every((key) => key === 'name' || key === 'type') &&
        (field as MaterialDynamicInputField).name === expected.name &&
        (field as MaterialDynamicInputField).type === expected.type
      );
    })
  );
}

function isWaterDeformationInputLayout(value: unknown): value is MaterialDynamicInputLayout {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const layout = waterDeformationInputLayout();
  if (
    Object.keys(candidate).length !== Object.keys(layout).length ||
    Object.entries(layout).some(
      ([key, expected]) =>
        !Object.hasOwn(candidate, key) || (key !== 'fields' && candidate[key] !== expected),
    ) ||
    !Array.isArray(candidate.fields) ||
    candidate.fields.length !== layout.fields.length
  ) {
    return false;
  }
  const fields = candidate.fields;
  return layout.fields.every((field, index) => {
    const candidateField: unknown = fields[index];
    if (
      candidateField === null ||
      typeof candidateField !== 'object' ||
      Array.isArray(candidateField)
    ) {
      return false;
    }
    const actual = candidateField as Record<string, unknown>;
    return (
      Object.keys(actual).length === Object.keys(field).length &&
      Object.entries(field).every(
        ([key, expected]) => Object.hasOwn(actual, key) && actual[key] === expected,
      )
    );
  });
}

export function isMaterialDeformationProgramAbi(
  value: unknown,
): value is MaterialDeformationProgramAbi {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const abi = value as Record<string, unknown>;
  const declaration = { module: abi.module, version: abi.version, inputs: abi.inputs };
  if (!isMaterialDeformationDeclaration(declaration)) return false;
  return (
    abi.outputAbi === 'WaterDeformationOutput' &&
    abi.inputLayoutHash === waterDeformationInputLayoutHash() &&
    isWaterDeformationInputLayout(abi.inputLayout) &&
    Array.isArray(abi.variants) &&
    abi.variants.length === 4 &&
    abi.variants[0] === 'color' &&
    abi.variants[1] === 'depth' &&
    abi.variants[2] === 'shadow' &&
    abi.variants[3] === 'velocity'
  );
}
