import { createHash } from 'node:crypto';
import type { MaterialParticleInput } from '@forgeax/engine-types';
import {
  err,
  ok,
  type Result,
  stripWgslComments,
  WGSL_NUMERIC_LAYOUT,
} from '@forgeax/engine-types';
import type {
  ParticleRendererSourceV3,
  VfxDataInterfaceRequirement,
  VfxEffectReflection,
  VfxGpuRendererReflection,
  VfxReflectedField,
  VfxReflectedStruct,
  VfxValue,
  VfxValueType,
} from '@forgeax/engine-vfx';
import {
  defaultParticleRendererAttributes,
  deriveVfxCustomLayout,
  isParticleRendererSortingV3,
  isParticleTopologyRenderer,
  PARTICLE_RENDERER_SEMANTICS,
  VFX_PARTICLE_CORE_LAYOUT,
} from '@forgeax/engine-vfx';

/** Kind-derived renderer facts, before material inputs, attributes and lighting are reflected. */
export type ParticleRendererReflection = Omit<
  VfxGpuRendererReflection,
  | 'attributes'
  | 'materialInputs'
  | 'materialInputDefinitions'
  | 'lighting'
  | 'castShadows'
  | 'receiveShadows'
>;

export interface VfxReflectionInput {
  readonly root: string;
  readonly imports?: Readonly<Record<string, string>>;
}

export interface VfxReflectionErrorDetail {
  readonly path: string;
  readonly struct?: string;
  readonly field?: string;
  readonly module?: string;
  readonly type?: string;
}

export interface VfxReflectionError {
  readonly code:
    | 'vfx-reflection-empty-struct'
    | 'vfx-reflection-unknown-type'
    | 'vfx-reflection-invalid-dimension'
    | 'vfx-reflection-duplicate-field'
    | 'vfx-reflection-duplicate-struct'
    | 'vfx-reflection-unknown-field'
    | 'vfx-reflection-layout-overflow'
    | 'vfx-reflection-invalid-default'
    | 'vfx-reflection-custom-budget'
    | 'vfx-reflection-unknown-data-interface'
    | 'vfx-reflection-duplicate-data-interface'
    | 'vfx-renderer-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: VfxReflectionErrorDetail;
}

function rendererFailure(
  expected: string,
  hint: string,
  path: string,
): Result<never, VfxReflectionError> {
  return err({
    code: 'vfx-renderer-invalid',
    expected,
    hint,
    detail: { path },
  });
}

interface ParsedField {
  readonly name: string;
  readonly type: VfxValueType;
  readonly defaultValue?: VfxValue;
}

interface ParsedStruct {
  readonly name: string;
  readonly fields: readonly ParsedField[];
  readonly module: string;
}

const STRUCT_NAMES = new Set(['VfxParameters', 'VfxCustom', 'VfxParticleData']);
const MAX_PACKED_SIZE = 64 * 1024;
/** Program v3 allocates reflected external resources after managed event bindings (8/9). */
const DATA_INTERFACE_DEFINITIONS_V3: readonly VfxDataInterfaceRequirement[] = [
  {
    token: 'vfx:scene-sdf',
    kind: 'scene-sdf',
    binding: 15,
    bindingType: 'read-only-storage',
    lifetime: 'generation',
  },
  {
    token: 'vfx:force-fields',
    kind: 'force-fields',
    binding: 17,
    bindingType: 'read-only-storage',
    lifetime: 'generation',
  },
  {
    token: 'vfx:camera',
    kind: 'camera',
    binding: 12,
    bindingType: 'uniform',
    lifetime: 'generation',
  },
  {
    token: 'vfx:scene-depth',
    kind: 'scene-depth',
    binding: 13,
    bindingType: 'sampled-depth',
    lifetime: 'generation',
    sampleCount: 1,
  },
  {
    token: 'vfx:noise',
    kind: 'noise',
    binding: 14,
    bindingType: 'sampled-float',
    lifetime: 'generation',
  },
];

function failure(
  code: VfxReflectionError['code'],
  expected: string,
  hint: string,
  detail: VfxReflectionErrorDetail,
): Result<never, VfxReflectionError> {
  return err({ code, expected, hint, detail });
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseNumber(value: string): number | undefined {
  const parsed = Number(value.trim().replace(/f$/, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDefault(value: string, type: VfxValueType): VfxValue | undefined {
  const vector = value.match(/^vec([234])<f32>\((.*)\)$/);
  if (vector !== null) {
    const vectorValues = vector[2];
    if (vectorValues === undefined) return undefined;
    const components = vectorValues
      .split(',')
      .map(parseNumber)
      .filter((component): component is number => component !== undefined);
    const expectedLength = Number(vector[1]);
    return components.length === expectedLength ? components : undefined;
  }
  const scalar = parseNumber(value);
  return scalar === undefined || type.startsWith('vec') ? undefined : scalar;
}

function defaultsByField(source: string): ReadonlyMap<string, string> {
  const defaults = new Map<string, string>();
  const pattern = /^\s*\/\/\s*forgeax-vfx-default\s+([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/gm;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) defaults.set(name, value);
  }
  return defaults;
}

function parseType(
  rawType: string,
  detail: VfxReflectionErrorDetail,
): Result<VfxValueType, VfxReflectionError> {
  const type = rawType.replace(/\s+/g, '');
  if (Object.hasOwn(WGSL_NUMERIC_LAYOUT, type)) return ok(type as VfxValueType);
  if (type.startsWith('array<')) {
    return failure(
      'vfx-reflection-invalid-dimension',
      'a scalar or vec2/vec3/vec4<f32> value',
      'replace the array with a supported fixed value type',
      { ...detail, type: rawType },
    );
  }
  return failure(
    'vfx-reflection-unknown-type',
    'f32, i32, u32, vec2<f32>, vec3<f32>, or vec4<f32>',
    'change the WGSL field to one of the supported VFX value types',
    { ...detail, type: rawType },
  );
}

function parseStructs(
  source: string,
  module: string,
  annotationSource = source,
): Result<readonly ParsedStruct[], VfxReflectionError> {
  const structs: ParsedStruct[] = [];
  const pattern = /struct\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined || !STRUCT_NAMES.has(name)) continue;
    if (body.trim().length === 0) {
      return failure(
        'vfx-reflection-empty-struct',
        `${name} must contain at least one field`,
        `add a supported field to ${name} or omit the struct`,
        { path: `${module}:${name}`, struct: name, module },
      );
    }
    const defaults = defaultsByField(annotationSource);
    const fields: ParsedField[] = [];
    const seen = new Set<string>();
    const fieldPattern = /([A-Za-z_]\w*)\s*:\s*([^,;]+)\s*[,;]/g;
    for (const fieldMatch of body.matchAll(fieldPattern)) {
      const field = fieldMatch[1];
      const rawType = fieldMatch[2]?.trim();
      if (field === undefined || rawType === undefined) continue;
      if (seen.has(field)) {
        return failure(
          'vfx-reflection-duplicate-field',
          'each reflected struct field name to be unique',
          `rename the duplicate field ${field} and recook`,
          { path: `${module}:${name}.${field}`, struct: name, field, module },
        );
      }
      seen.add(field);
      const parsedType = parseType(rawType, {
        path: `${module}:${name}.${field}`,
        struct: name,
        field,
        module,
      });
      if (!parsedType.ok) return parsedType;
      const rawDefault = defaults.get(field);
      const defaultValue =
        rawDefault === undefined ? undefined : parseDefault(rawDefault, parsedType.value);
      if (rawDefault !== undefined && defaultValue === undefined) {
        return failure(
          'vfx-reflection-invalid-default',
          `a finite default matching ${parsedType.value}`,
          `repair the forgeax-vfx-default annotation for ${field}`,
          { path: `${module}:${name}.${field}`, struct: name, field, module },
        );
      }
      fields.push(
        defaultValue === undefined
          ? { name: field, type: parsedType.value }
          : { name: field, type: parsedType.value, defaultValue },
      );
    }
    if (fields.length === 0) {
      return failure(
        'vfx-reflection-empty-struct',
        `${name} must contain parseable fields`,
        `write comma- or semicolon-terminated fields in ${name}`,
        { path: `${module}:${name}`, struct: name, module },
      );
    }
    structs.push({ name, fields, module });
  }
  return ok(structs);
}

function usedFields(source: string, fields: readonly ParsedField[]): ReadonlySet<string> {
  const withoutStructBodies = source.replace(/struct\s+[A-Za-z_]\w*\s*\{[\s\S]*?\}/g, '');
  return new Set(
    fields
      .filter((field) => new RegExp(`\\.\\s*${field.name}\\b`).test(withoutStructBodies))
      .map((field) => field.name),
  );
}

function buildStruct(
  name: string,
  fields: readonly ParsedField[],
  source: string,
  includeUnused = false,
): Result<VfxReflectedStruct, VfxReflectionError> {
  const used = includeUnused
    ? new Set(fields.map((field) => field.name))
    : usedFields(source, fields);
  // These offsets describe the authored WGSL struct. Sorting members changes
  // its ABI even though the set of field names remains identical.
  const selected = fields.filter((field) => used.has(field.name));
  let offset = 0;
  let alignment = 1;
  const reflected: VfxReflectedField[] = [];
  for (const field of selected) {
    const layout = WGSL_NUMERIC_LAYOUT[field.type];
    offset = alignUp(offset, layout.alignment);
    const next = offset + layout.size;
    if (!Number.isSafeInteger(next) || next > MAX_PACKED_SIZE) {
      return failure(
        'vfx-reflection-layout-overflow',
        `a packed ${name} layout no larger than ${MAX_PACKED_SIZE} bytes`,
        `remove fields from ${name} or split the effect data`,
        { path: `${name}.${field.name}`, struct: name, field: field.name },
      );
    }
    alignment = Math.max(alignment, layout.alignment);
    reflected.push({
      name: field.name,
      type: field.type,
      offset,
      size: layout.size,
      alignment: layout.alignment,
      ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    });
    offset = next;
  }
  return ok({
    name,
    fields: reflected,
    size: selected.length === 0 ? 0 : alignUp(offset, alignment),
    alignment,
  });
}

function emptyStruct(name: string): VfxReflectedStruct {
  return { name, fields: [], size: 0, alignment: 1 };
}

function reflectDataInterfaces(
  modules: readonly { readonly name: string; readonly source: string }[],
  definitions: readonly VfxDataInterfaceRequirement[] = DATA_INTERFACE_DEFINITIONS_V3,
): Result<readonly VfxDataInterfaceRequirement[], VfxReflectionError> {
  const imported = new Set<string>();
  for (const module of modules) {
    const pattern = /#import\s+forgeax_vfx::data::(?:\{([^}]+)\}|([A-Za-z_]\w*))/g;
    for (const match of module.source.matchAll(pattern)) {
      const names = match[1]?.split(',').map((name) => name.trim()) ?? [match[2] ?? ''];
      for (const name of names) {
        if (name.length === 0) continue;
        const definition = definitions.find(
          (candidate) => candidate.token === `vfx:${name.replaceAll('_', '-')}`,
        );
        if (definition === undefined) {
          return failure(
            'vfx-reflection-unknown-data-interface',
            `supported Data Interface imports: ${definitions.map((entry) => entry.kind.replaceAll('-', '_')).join(', ')}`,
            `replace forgeax_vfx::data::${name} with a supported Data Interface import`,
            { path: `${module.name}:forgeax_vfx::data::${name}`, module: module.name },
          );
        }
        if (imported.has(definition.token)) {
          return failure(
            'vfx-reflection-duplicate-data-interface',
            'one explicit import per Data Interface token',
            `remove the duplicate ${definition.token} import and recook`,
            { path: `${module.name}:forgeax_vfx::data::${name}`, module: module.name },
          );
        }
        imported.add(definition.token);
      }
    }
  }
  return ok(Object.freeze(definitions.filter((definition) => imported.has(definition.token))));
}

/** Reflect the canonical Program v3 scope. All Custom fields are persistent. */
export function reflectVfxLayout(
  input: VfxReflectionInput,
): Result<VfxEffectReflection, VfxReflectionError> {
  const modules = [
    { name: 'root', source: input.root },
    ...Object.entries(input.imports ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, source]) => ({ name, source })),
  ];
  const parsed: ParsedStruct[] = [];
  const knownStructs = new Set<string>();
  const codeModules = modules.map((module) => ({
    name: module.name,
    source: stripWgslComments(module.source),
  }));
  for (const [index, module] of modules.entries()) {
    if (/^\s*\/\/\s*forgeax-vfx-unknown\b/m.test(module.source)) {
      return failure(
        'vfx-reflection-unknown-field',
        'only recognized forgeax-vfx reflection annotations',
        'remove the unknown annotation and recook',
        { path: module.name, module: module.name },
      );
    }
    const codeModule = codeModules[index];
    if (codeModule === undefined) continue;
    const result = parseStructs(codeModule.source, module.name, module.source);
    if (!result.ok) return result;
    for (const struct of result.value) {
      if (knownStructs.has(struct.name)) {
        return failure(
          'vfx-reflection-duplicate-struct',
          'one authoritative declaration per reflected struct name',
          `remove the duplicate ${struct.name} declaration and recook`,
          { path: `${module.name}:${struct.name}`, struct: struct.name, module: module.name },
        );
      }
      knownStructs.add(struct.name);
      parsed.push(struct);
    }
  }

  const dataInterfaces = reflectDataInterfaces(codeModules, DATA_INTERFACE_DEFINITIONS_V3);
  if (!dataInterfaces.ok) return dataInterfaces;

  const parameterStruct = parsed.find((struct) => struct.name === 'VfxParameters');
  const customStruct = parsed.find(
    (struct) => struct.name === 'VfxCustom' || struct.name === 'VfxParticleData',
  );
  const parameters =
    parameterStruct === undefined
      ? ok(emptyStruct('VfxParameters'))
      : buildStruct(
          'VfxParameters',
          parameterStruct.fields,
          codeModules.map((module) => module.source).join('\n'),
          true,
        );
  if (!parameters.ok) return parameters;
  const custom =
    customStruct === undefined
      ? ok(emptyStruct('VfxCustom'))
      : buildStruct(
          'VfxCustom',
          customStruct.fields,
          codeModules.map((module) => module.source).join('\n'),
          true,
        );
  if (!custom.ok) return custom;
  let customLayout: ReturnType<typeof deriveVfxCustomLayout>;
  try {
    customLayout = deriveVfxCustomLayout({ ...custom.value, name: 'VfxCustom' });
  } catch (error) {
    return failure(
      'vfx-reflection-custom-budget',
      'VfxCustom no larger than four vec4-equivalent lanes',
      error instanceof Error ? error.message : 'reduce VfxCustom fields and recook',
      { path: 'VfxCustom' },
    );
  }
  const fingerprintInput = {
    version: 3 as const,
    parameters: parameters.value,
    custom: custom.value,
    core: VFX_PARTICLE_CORE_LAYOUT,
    customLayout,
  };
  const fingerprint = `sha256:${createHash('sha256').update(canonical(fingerprintInput)).digest('hex')}`;
  return ok({ ...fingerprintInput, dataInterfaces: dataInterfaces.value, fingerprint });
}

/** Derive executable renderer resources and shader inputs from the authored renderer union. */
export function reflectVfxRenderer(
  renderers: readonly unknown[],
): Result<readonly ParticleRendererReflection[], VfxReflectionError> {
  const reflected: ParticleRendererReflection[] = [];
  for (const [index, candidate] of renderers.entries()) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return rendererFailure(
        'a renderer object',
        'repair the renderer declaration and recook',
        `renderers[${index}]`,
      );
    const renderer = candidate as ParticleRendererSourceV3;
    if (!Object.hasOwn(PARTICLE_RENDERER_SEMANTICS, renderer.kind))
      return rendererFailure(
        'a billboard, mesh, ribbon, trail, or beam renderer kind',
        'repair the renderer kind and recook',
        `renderers[${index}].kind`,
      );
    const capacity = isParticleTopologyRenderer(renderer)
      ? renderer.capacity
      : renderer.kind === 'billboard'
        ? (renderer.capacity ?? 64)
        : 1;
    if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 65536) {
      return rendererFailure(
        'a renderer capacity in the range 1..65536',
        'set a bounded capacity and recook the VFX program',
        `renderers[${index}].capacity`,
      );
    }
    const base = {
      topology: renderer.kind,
      resource: `vfx-renderer-${renderer.kind}-${index}`,
      capacity,
      overflow: renderer.kind === 'mesh' ? 'drop-newest' : (renderer.overflow ?? 'drop-newest'),
      enabled: renderer.enabled ?? true,
      shaderInputs: [] as readonly string[],
    } satisfies Omit<
      ParticleRendererReflection,
      | 'textureSheet'
      | 'pivot'
      | 'softParticle'
      | 'sorting'
      | 'stripKey'
      | 'historyLength'
      | 'endpointField'
    >;
    switch (renderer.kind) {
      case 'billboard': {
        const sheet = renderer.textureSheet;
        if (
          sheet !== undefined &&
          (!Number.isInteger(sheet.columns) ||
            sheet.columns <= 0 ||
            sheet.columns > 64 ||
            !Number.isInteger(sheet.rows) ||
            sheet.rows <= 0 ||
            sheet.rows > 64 ||
            !Number.isFinite(sheet.frameRate) ||
            sheet.frameRate < 0 ||
            (sheet.frameCount !== undefined &&
              (!Number.isInteger(sheet.frameCount) ||
                sheet.frameCount <= 0 ||
                sheet.frameCount > sheet.columns * sheet.rows)))
        )
          return rendererFailure(
            'a bounded texture sheet declaration',
            'repair the texture sheet dimensions and recook',
            `renderers[${index}].textureSheet`,
          );
        if (
          renderer.pivot !== undefined &&
          (renderer.pivot.length !== 2 ||
            renderer.pivot.some((value) => !Number.isFinite(value) || value < -1 || value > 1))
        )
          return rendererFailure(
            'a pivot with two finite values in the -1..1 range',
            'repair the billboard pivot and recook',
            `renderers[${index}].pivot`,
          );
        if (
          renderer.softParticle !== undefined &&
          (!Number.isFinite(renderer.softParticle.fadeDistance) ||
            renderer.softParticle.fadeDistance <= 0)
        )
          return rendererFailure(
            'a positive soft-particle fade distance',
            'provide scene depth and a positive fade distance',
            `renderers[${index}].softParticle`,
          );
        if (renderer.sorting !== undefined && !isParticleRendererSortingV3(renderer.sorting))
          return rendererFailure(
            'none, view-depth, view-distance, or an explicitly dispatched custom sort',
            'repair the billboard sorting mode and recook',
            `renderers[${index}].sorting`,
          );
        const frameCount =
          sheet?.frameCount ?? (sheet === undefined ? 1 : sheet.columns * sheet.rows);
        const shaderInputs = [
          ...(sheet === undefined ? [] : ['textureSheet']),
          ...(renderer.pivot === undefined ? [] : ['pivot']),
          ...(renderer.softParticle === undefined ? [] : ['softParticleDepth']),
          ...(renderer.sorting === undefined || renderer.sorting === 'none' ? [] : ['sorting']),
        ];
        reflected.push({
          ...base,
          shaderInputs: Object.freeze(shaderInputs),
          ...(sheet === undefined ? {} : { textureSheet: { ...sheet, frameCount } }),
          ...(renderer.pivot === undefined ? {} : { pivot: renderer.pivot }),
          ...(renderer.softParticle === undefined
            ? {}
            : {
                softParticle: {
                  fadeDistance: renderer.softParticle.fadeDistance,
                  requiresDepth: true as const,
                },
              }),
          ...(renderer.sorting === undefined ? {} : { sorting: renderer.sorting }),
        });
        break;
      }
      case 'mesh':
        reflected.push({ ...base, shaderInputs: Object.freeze(['mesh']) });
        break;
      case 'ribbon':
        reflected.push({
          ...base,
          shaderInputs: Object.freeze(['stripKey']),
          stripKey: renderer.stripKey,
        });
        break;
      case 'trail':
        if (
          !Number.isInteger(renderer.historyLength) ||
          renderer.historyLength <= 0 ||
          renderer.historyLength > 256
        )
          return rendererFailure(
            'a trail historyLength in the range 1..256',
            'bound trail history memory and recook',
            `renderers[${index}].historyLength`,
          );
        reflected.push({
          ...base,
          shaderInputs: Object.freeze(['history']),
          historyLength: renderer.historyLength,
        });
        break;
      case 'beam':
        reflected.push({
          ...base,
          shaderInputs: Object.freeze(['endpoint']),
          endpointField: renderer.endpointField,
        });
        break;
    }
  }
  return ok(Object.freeze(reflected));
}

function semanticTypes(semantic: string): readonly string[] {
  switch (semantic) {
    case 'position':
    case 'endpoint':
    case 'scale':
      return ['vec3<f32>'];
    case 'color':
      return ['vec4<f32>'];
    case 'size':
      return ['vec2<f32>'];
    case 'orientation':
      return ['vec4<f32>'];
    case 'visibility':
      return ['u32', 'f32'];
    case 'age':
    case 'rotation':
    case 'subImage':
    case 'sort':
    case 'width':
    case 'taper':
      return ['f32', 'i32', 'u32'];
  }
  return [];
}

/** Convert a reflected particle field expression to a material input type. */
export function materialInputSourceExpression(
  expression: string,
  fieldType: string,
  inputType: MaterialParticleInput['type'],
): string | undefined {
  if (fieldType === inputType) return expression;
  if (inputType === 'f32' && (fieldType === 'i32' || fieldType === 'u32')) {
    return `f32(${expression})`;
  }
  return undefined;
}

export function isMaterialInputCompatible(
  fieldType: string,
  inputType: MaterialParticleInput['type'],
): boolean {
  return materialInputSourceExpression('value', fieldType, inputType) !== undefined;
}

/** Reflection projection for Program v3 renderer semantics and Standard Mesh flags. */
export function reflectVfxRendererV3(
  renderers: readonly ParticleRendererSourceV3[],
  materials?: Readonly<Record<string, readonly MaterialParticleInput[]>>,
  layout?: VfxEffectReflection,
): Result<readonly VfxGpuRendererReflection[], VfxReflectionError> {
  const baseReflections = reflectVfxRenderer(renderers);
  if (!baseReflections.ok) return baseReflections;
  for (const [index, renderer] of renderers.entries()) {
    const names = renderer.materialInputs ?? [];
    if (names.length === 0) continue;
    const definitions = materials?.[renderer.material];
    if (definitions === undefined) {
      return rendererFailure(
        'a material artifact with particleInputs metadata',
        `load or cook material ${renderer.material} before the VFX program`,
        `renderers[${index}].materialInputs`,
      );
    }
    for (const [inputIndex, name] of names.entries()) {
      const input = definitions.find((candidate) => candidate.name === name);
      if (input === undefined) {
        return rendererFailure(
          `material ${renderer.material} declares particle input ${name}`,
          `add ${name} to the material particleInputs declaration and recook`,
          `renderers[${index}].materialInputs[${inputIndex}]`,
        );
      }
      const customField = layout?.customLayout?.fields.find((field) => field.name === name);
      const coreField = VFX_PARTICLE_CORE_LAYOUT.fields.find((field) => field.name === name);
      const field = customField ?? coreField;
      if (field === undefined) {
        return rendererFailure(
          `a Core or Custom particle field named ${name}`,
          `declare ${name} in VfxCustom or map the material input to an existing Core field before cooking`,
          `renderers[${index}].materialInputs[${inputIndex}]`,
        );
      }
      if (!isMaterialInputCompatible(field.type, input.type)) {
        return rendererFailure(
          `${name} to use a ${input.type} source-compatible particle field`,
          `change ${name} to match ${field.type} or change the material particle input type and recook`,
          `renderers[${index}].materialInputs[${inputIndex}]`,
        );
      }
    }
  }
  const customSortFields = new Set<string>();
  for (const [index, renderer] of renderers.entries()) {
    const attributes = {
      ...defaultParticleRendererAttributes(renderer.kind),
      ...(renderer.attributes ?? {}),
    };
    if (
      !isParticleTopologyRenderer(renderer) &&
      (renderer.sorting === 'custom-ascending' || renderer.sorting === 'custom-descending')
    ) {
      const sort = attributes.sort;
      if (sort?.source !== 'custom') {
        return rendererFailure(
          'custom sorting to reference one reflected VfxCustom scalar sort attribute',
          'map renderer.attributes.sort to a VfxCustom field before cooking custom sorting',
          `renderers[${index}].attributes.sort`,
        );
      }
      customSortFields.add(sort.name);
    }
    for (const [semantic, reference] of Object.entries(attributes)) {
      if (reference === undefined) continue;
      const supportedSemantics = PARTICLE_RENDERER_SEMANTICS[renderer.kind] as readonly string[];
      if (!supportedSemantics.includes(semantic)) {
        return rendererFailure(
          `a semantic supported by the ${renderer.kind} renderer topology`,
          `remove the unknown renderer attribute ${semantic} and recook`,
          `renderers[${index}].attributes.${semantic}`,
        );
      }
      const reflected =
        reference.source === 'core'
          ? VFX_PARTICLE_CORE_LAYOUT.fields.find((field) => field.name === reference.name)
          : layout?.customLayout?.fields.find((field) => field.name === reference.name);
      if (reflected === undefined) {
        return rendererFailure(
          `a declared ${reference.source} particle attribute ${reference.name}`,
          `declare ${reference.name} in the effect ${reference.source} schema before mapping ${semantic}`,
          `renderers[${index}].attributes.${semantic}`,
        );
      }
      const accepted = semanticTypes(semantic);
      if (accepted.length > 0 && !accepted.includes(reflected.type)) {
        return rendererFailure(
          `${semantic} mapped to one of ${accepted.join(', ')}`,
          `map ${semantic} to a compatible typed particle attribute and recook`,
          `renderers[${index}].attributes.${semantic}`,
        );
      }
    }
  }
  if (customSortFields.size > 1) {
    return rendererFailure(
      'all custom-sorted renderers in one emitter to share one VfxCustom sort field',
      'use one reflected custom sort key so the managed alive-index dispatch has one deterministic order',
      'renderers[*].attributes.sort',
    );
  }
  const reflected = renderers.map((renderer, index) => {
    const base = baseReflections.value[index];
    if (base === undefined) throw new Error(`renderer reflection missing index ${index}`);
    const { sorting: _baseSorting, ...baseWithoutSorting } = base;
    const attributes = Object.freeze({
      ...defaultParticleRendererAttributes(renderer.kind),
      ...(renderer.attributes ?? {}),
    });
    const materialInputs = Object.freeze([...(renderer.materialInputs ?? [])]);
    const materialInputDefinitions =
      materials === undefined || materialInputs.length === 0
        ? undefined
        : materials[renderer.material];
    return Object.freeze({
      ...baseWithoutSorting,
      shaderInputs: Object.freeze([
        ...base.shaderInputs,
        ...Object.keys(attributes).sort(),
        ...materialInputs.map((name) => `material.${name}`),
      ]),
      attributes,
      materialInputs,
      ...(materialInputDefinitions === undefined
        ? {}
        : { materialInputDefinitions: Object.freeze([...materialInputDefinitions]) }),
      ...(!isParticleTopologyRenderer(renderer) && renderer.sorting !== undefined
        ? { sorting: renderer.sorting }
        : {}),
      ...(renderer.kind === 'mesh'
        ? {
            lighting: renderer.lighting ?? 'standard',
            castShadows: renderer.castShadows ?? false,
            receiveShadows: renderer.receiveShadows ?? true,
          }
        : { castShadows: false, receiveShadows: false }),
    });
  });
  return ok(Object.freeze(reflected));
}
