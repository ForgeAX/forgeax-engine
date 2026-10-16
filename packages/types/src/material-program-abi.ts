/**
 * Producer-published material program facts shared by Pack and runtime
 * rendering.  This is deliberately a data-only contract: it describes the
 * interface selected by a program, but does not grant GPU-driven admission by
 * itself.  Render prepare still validates the facts against the current mesh,
 * resources and device generation.
 */

import {
  deriveMaterialDynamicInputLayout,
  type MaterialDynamicFieldType,
  type MaterialDynamicInputLayout,
  type MaterialDynamicInputSchema,
  type MaterialSurfaceModel,
} from './material/surface-model.js';

export const MATERIAL_SCENE_ADDRESS_UNIT_BYTES = 16 as const;

export type MaterialProgramAddress = 'direct' | 'scene-index';

export type MaterialProgramBindingContract =
  | 'group-0'
  | 'group-0-resource'
  | 'view-only'
  | 'view-and-scene-depth'
  | 'render-material-with-scene-depth'
  | 'render-material-and-scene-depth'
  | 'render-material';

export type MaterialSceneDepth = 'read-only' | 'before-pass';

export function isMaterialProgramBindingContract(
  value: unknown,
): value is MaterialProgramBindingContract {
  return (
    typeof value === 'string' &&
    [
      'group-0',
      'group-0-resource',
      'view-only',
      'view-and-scene-depth',
      'render-material-with-scene-depth',
      'render-material-and-scene-depth',
      'render-material',
    ].includes(value)
  );
}

export interface MaterialProgramResourceSlot {
  readonly name: string;
  readonly parameter: string;
  readonly kind: 'sampler' | 'texture' | 'storage-buffer';
  readonly group: number;
  readonly binding: number;
}

export interface MaterialProgramVertexInput {
  readonly semantic: string;
  readonly location: number;
  readonly format: string;
}

export type MaterialSurfacePassKind = 'nearest-layer' | 'color';

/** Producer-owned model facts shared by the direct and scene-index entries. */
export interface MaterialSurfaceProgramAbi {
  readonly model: MaterialSurfaceModel;
  readonly module: string;
  readonly inputAbi: string;
  readonly outputAbi: string;
  readonly passes: readonly MaterialSurfacePassKind[];
  readonly dynamicInput?: {
    readonly layout: MaterialDynamicInputLayout;
    readonly group: number;
    readonly binding: number;
    readonly readOnly: true;
    readonly accessor: string;
  };
}

/** Complete immutable ABI projection for one material program family. */
export interface MaterialProgramAbi {
  /** Omitted selects the ordinary Render material interface. Never inferred from WGSL text. */
  readonly bindings?: MaterialProgramBindingContract;
  /** Explicit attachment read or independent snapshot of depth before this pass. */
  readonly sceneDepth?: MaterialSceneDepth;
  readonly directEntry: string;
  /** Absent for a program that only has a direct entry. */
  readonly sceneIndexEntry?: string;
  readonly materialRow: {
    /** Zero only for a direct program with no parameter region. */
    readonly byteLength: number;
    /** Scene selectors carry an aligned address in these units, never a fixed-row ordinal. */
    readonly addressUnitBytes?: typeof MATERIAL_SCENE_ADDRESS_UNIT_BYTES;
    readonly fields: readonly string[];
  };
  readonly resourceSlots: readonly MaterialProgramResourceSlot[];
  readonly uvSets: readonly { readonly parameter: string; readonly set: number }[];
  readonly vertexInputs: readonly MaterialProgramVertexInput[];
  readonly alphaMask: { readonly cutoff: string; readonly source: string };
  readonly skinPaletteAddress?: {
    readonly group: number;
    readonly binding: number;
    readonly stride: number;
  };
  readonly reflection: {
    readonly layoutIdentity: string;
    readonly resourceSlots: readonly MaterialProgramResourceSlot[];
    readonly vertexInputs: readonly MaterialProgramVertexInput[];
  };
  readonly receiptIdentity: string;
  readonly generation: number;
  /** Optional imported Surface model projection. Standard keeps this absent. */
  readonly surface?: MaterialSurfaceProgramAbi;
}

function isDynamicInputLayout(value: unknown): value is MaterialDynamicInputLayout {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const layout = value as Record<string, unknown>;
  if (
    typeof layout.name !== 'string' ||
    typeof layout.stride !== 'number' ||
    !Number.isSafeInteger(layout.stride) ||
    layout.stride <= 0 ||
    layout.stride % 16 !== 0 ||
    !Array.isArray(layout.fields) ||
    typeof layout.identity !== 'string' ||
    layout.identity.length === 0
  )
    return false;
  const limits = [
    'maxRecords',
    'maxDomains',
    'maxPageBytes',
    'maxBindings',
    'maxEventsPerSample',
  ] as const;
  if (limits.some((field) => !Number.isSafeInteger(layout[field]))) return false;
  const fields = layout.fields.map((field) => {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) return undefined;
    const candidate = field as Record<string, unknown>;
    if (
      typeof candidate.name === 'string' &&
      typeof candidate.type === 'string' &&
      Number.isSafeInteger(candidate.offset) &&
      (candidate.offset as number) >= 0 &&
      Number.isSafeInteger(candidate.size) &&
      (candidate.size as number) > 0 &&
      Number.isSafeInteger(candidate.alignment) &&
      (candidate.alignment as number) > 0
    ) {
      return {
        name: candidate.name,
        type: candidate.type,
        offset: candidate.offset as number,
        size: candidate.size as number,
        alignment: candidate.alignment as number,
      };
    }
    return undefined;
  });
  if (fields.some((field) => field === undefined)) return false;
  const fieldTypes = new Set<MaterialDynamicFieldType>([
    'f32',
    'u32',
    'vec2<f32>',
    'vec3<f32>',
    'vec4<f32>',
  ]);
  if (
    fields.some(
      (field) => field !== undefined && !fieldTypes.has(field.type as MaterialDynamicFieldType),
    )
  ) {
    return false;
  }
  const schema: MaterialDynamicInputSchema = {
    name: layout.name,
    fields: fields.map((field) => ({
      name: field?.name ?? '',
      type: field?.type as MaterialDynamicFieldType,
    })),
    maxRecords: layout.maxRecords as number,
    maxDomains: layout.maxDomains as number,
    maxPageBytes: layout.maxPageBytes as number,
    maxBindings: layout.maxBindings as number,
    maxEventsPerSample: layout.maxEventsPerSample as number,
  };
  const derived = deriveMaterialDynamicInputLayout(schema);
  if (!derived.ok || derived.value.stride !== layout.stride) return false;
  if (
    derived.value.maxRecords !== schema.maxRecords ||
    derived.value.maxDomains !== schema.maxDomains ||
    derived.value.maxPageBytes !== schema.maxPageBytes ||
    derived.value.maxBindings !== schema.maxBindings ||
    derived.value.maxEventsPerSample !== schema.maxEventsPerSample ||
    derived.value.identity !== layout.identity ||
    derived.value.fields.length !== fields.length
  ) {
    return false;
  }
  return derived.value.fields.every((field, index) => {
    const candidate = fields[index];
    return (
      candidate !== undefined &&
      field.name === candidate.name &&
      field.type === candidate.type &&
      field.offset === candidate.offset &&
      field.size === candidate.size &&
      field.alignment === candidate.alignment
    );
  });
}

const SURFACE_MODULE_RE = /^[A-Za-z_][A-Za-z0-9_.-]*(?:::[A-Za-z_][A-Za-z0-9_.-]*)*$/;

/** Validate the Surface model portion of a published material ABI. */
export function isMaterialSurfaceProgramAbi(value: unknown): value is MaterialSurfaceProgramAbi {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const surface = value as Record<string, unknown>;
  if (
    (surface.model !== 'standard' && surface.model !== 'single-layer-medium') ||
    typeof surface.module !== 'string' ||
    !SURFACE_MODULE_RE.test(surface.module) ||
    typeof surface.inputAbi !== 'string' ||
    typeof surface.outputAbi !== 'string' ||
    !Array.isArray(surface.passes) ||
    surface.passes.some((pass) => pass !== 'nearest-layer' && pass !== 'color')
  )
    return false;
  const passes = surface.passes as unknown[];
  const expectedPasses =
    surface.model === 'single-layer-medium' ? ['nearest-layer', 'color'] : ['color'];
  if (
    passes.length !== expectedPasses.length ||
    passes.some((pass, index) => pass !== expectedPasses[index])
  )
    return false;
  if (surface.dynamicInput === undefined) return true;
  if (surface.dynamicInput === null || typeof surface.dynamicInput !== 'object') return false;
  const dynamic = surface.dynamicInput as Record<string, unknown>;
  if (
    isDynamicInputLayout(dynamic.layout) &&
    dynamic.group === 3 &&
    dynamic.binding === 3 &&
    dynamic.readOnly === true &&
    typeof dynamic.accessor === 'string' &&
    dynamic.accessor === `read_${(dynamic.layout as { name: string }).name}`
  ) {
    return true;
  }
  return false;
}

/**
 * Runtime-safe boundary check for ABI facts carried by a cooked publication.
 * Pack and Catalog use this instead of trusting JSON shape or rebuilding an
 * ABI from a shader identifier.  The check intentionally validates the
 * structural contract only; Render prepare still compares the facts with the
 * resident geometry, resources and device generation.
 */
export function isMaterialProgramAbi(value: unknown): value is MaterialProgramAbi {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const abi = value as Record<string, unknown>;
  const row = abi.materialRow;
  const reflection = abi.reflection;
  const generation = abi.generation;
  const validIndex = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0;
  const validInputs = (inputs: unknown): boolean =>
    Array.isArray(inputs) &&
    inputs.every(
      (input) =>
        input !== null &&
        typeof input === 'object' &&
        typeof (input as { semantic?: unknown }).semantic === 'string' &&
        validIndex((input as { location?: unknown }).location) &&
        typeof (input as { format?: unknown }).format === 'string',
    ) &&
    new Set(inputs.map((input) => (input as { location: number }).location)).size === inputs.length;
  const validRow = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return false;
    const materialRow = candidate as {
      byteLength?: unknown;
      fields?: unknown;
      addressUnitBytes?: unknown;
    };
    const byteLength = materialRow.byteLength;
    if (
      abi.sceneIndexEntry !== undefined &&
      materialRow.addressUnitBytes !== MATERIAL_SCENE_ADDRESS_UNIT_BYTES
    )
      return false;
    if (
      typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength % 16 !== 0 ||
      !Array.isArray(materialRow.fields) ||
      !materialRow.fields.every((field) => typeof field === 'string')
    ) {
      return false;
    }
    if (byteLength === 0 && (abi.sceneIndexEntry !== undefined || materialRow.fields.length !== 0))
      return false;
    return new Set(materialRow.fields).size === materialRow.fields.length;
  };
  const validResources = (resources: unknown): boolean =>
    Array.isArray(resources) &&
    resources.every(
      (resource) =>
        resource !== null &&
        typeof resource === 'object' &&
        typeof (resource as { name?: unknown }).name === 'string' &&
        (resource as { name: string }).name.length > 0 &&
        typeof (resource as { parameter?: unknown }).parameter === 'string' &&
        (resource as { parameter: string }).parameter.length > 0 &&
        ['sampler', 'texture', 'storage-buffer'].includes(
          (resource as { kind?: unknown }).kind as string,
        ) &&
        validIndex((resource as { group?: unknown }).group) &&
        validIndex((resource as { binding?: unknown }).binding),
    ) &&
    new Set(
      resources.map((resource) => {
        const candidate = resource as { group: number; binding: number };
        return `${candidate.group}:${candidate.binding}`;
      }),
    ).size === resources.length;
  const validSkin =
    abi.skinPaletteAddress === undefined ||
    (abi.skinPaletteAddress !== null &&
      typeof abi.skinPaletteAddress === 'object' &&
      validIndex((abi.skinPaletteAddress as { group?: unknown }).group) &&
      validIndex((abi.skinPaletteAddress as { binding?: unknown }).binding) &&
      Number.isSafeInteger((abi.skinPaletteAddress as { stride?: unknown }).stride) &&
      ((abi.skinPaletteAddress as { stride: number }).stride ?? 0) > 0);
  const validSurface = abi.surface === undefined || isMaterialSurfaceProgramAbi(abi.surface);
  const validShape =
    (abi.bindings === undefined || isMaterialProgramBindingContract(abi.bindings)) &&
    (abi.sceneDepth === undefined ||
      abi.sceneDepth === 'read-only' ||
      abi.sceneDepth === 'before-pass') &&
    typeof abi.directEntry === 'string' &&
    abi.directEntry.length > 0 &&
    (abi.sceneIndexEntry === undefined ||
      (typeof abi.sceneIndexEntry === 'string' && abi.sceneIndexEntry.length > 0)) &&
    validRow(row) &&
    validResources(abi.resourceSlots) &&
    Array.isArray(abi.uvSets) &&
    (abi.uvSets as unknown[]).every(
      (uv) =>
        uv !== null &&
        typeof uv === 'object' &&
        typeof (uv as { parameter?: unknown }).parameter === 'string' &&
        Number.isSafeInteger((uv as { set?: unknown }).set) &&
        ((uv as { set: number }).set ?? -1) >= 0,
    ) &&
    validInputs(abi.vertexInputs) &&
    abi.alphaMask !== null &&
    typeof abi.alphaMask === 'object' &&
    typeof (abi.alphaMask as { cutoff?: unknown }).cutoff === 'string' &&
    typeof (abi.alphaMask as { source?: unknown }).source === 'string' &&
    reflection !== null &&
    typeof reflection === 'object' &&
    typeof (reflection as { layoutIdentity?: unknown }).layoutIdentity === 'string' &&
    (reflection as { layoutIdentity: string }).layoutIdentity.length > 0 &&
    validResources((reflection as { resourceSlots?: unknown }).resourceSlots) &&
    validInputs((reflection as { vertexInputs?: unknown }).vertexInputs) &&
    typeof abi.receiptIdentity === 'string' &&
    abi.receiptIdentity.length > 0 &&
    Number.isSafeInteger(generation) &&
    typeof generation === 'number' &&
    generation >= 1 &&
    validSkin &&
    validSurface;
  if (!validShape) return false;
  const topResources = JSON.stringify(abi.resourceSlots);
  const reflectionResources = JSON.stringify(
    (reflection as { resourceSlots: unknown }).resourceSlots,
  );
  const topInputs = JSON.stringify(abi.vertexInputs);
  const reflectionInputs = JSON.stringify((reflection as { vertexInputs: unknown }).vertexInputs);
  return topResources === reflectionResources && topInputs === reflectionInputs;
}
