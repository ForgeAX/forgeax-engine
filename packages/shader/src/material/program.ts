import {
  findUndeclaredSampledTextures,
  fnv1aUtf16,
  isDeepFrozenJson,
  type ParamSchemaEntry,
  type ShaderEntryPointReads,
  stripWgslComments,
} from '@forgeax/engine-types';

const NO_TEXTURE_DECLARATIONS: readonly ParamSchemaEntry[] = Object.freeze([]);

export type PipelineGroup2Contract = 'mesh' | 'skin' | 'cluster' | 'skin-cluster';

/** Immutable facts about one composed source, shared across material passes and GPU devices. */
export interface MaterialShaderProgram {
  readonly entryPoints?: readonly ShaderEntryPointReads[];
  readonly source: string;
  /** User-region texture names sampled by this exact source, before schema validation. */
  readonly sampledUserTextureFields: readonly string[];
  readonly identity: string;
  readonly group2: PipelineGroup2Contract;
  /** Undefined is an admitted absence, not a request to scan the source again. */
  readonly uvSetCount: number | undefined;
  readonly vertexInputRequired: boolean;
  readonly probeBlendRecordRequired: boolean;
  /** False only when the material uniform has no references beyond its declaration. */
  readonly materialUniformRequired: boolean;
  /** Literal group(1) declarations; undefined keeps unknown source contracts conservative. */
  readonly materialBindings: readonly number[] | undefined;
  /** Numeric `@id` pipeline overrides this exact module declares, in source order. */
  readonly overrideIds: readonly string[];
}

export function materialShaderUvSetCount(source: string): number | undefined {
  return vertexInputs(stripWgslComments(source)).uvSetCount;
}

export function materialShaderVertexInputRequired(source: string): boolean {
  return vertexInputs(stripWgslComments(source)).vertexInputRequired;
}

function vertexInputs(code: string): {
  uvSetCount: number | undefined;
  vertexInputRequired: boolean;
} {
  const inputTypes = new Set<string>();
  for (const input of code.matchAll(/@vertex\s*fn\s+\w+\s*\(\s*\w+\s*:\s*([A-Za-z_]\w*)\b/gu))
    if (input[1] !== undefined) inputTypes.add(input[1]);
  for (const inputStruct of code.matchAll(/struct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/gu)) {
    const name = inputStruct[1],
      body = inputStruct[2];
    if (name === undefined || body === undefined || !inputTypes.has(name)) continue;
    let uvSetCount = 0;
    for (const location of body.matchAll(/@location\s*\(\s*(\d+)\s*\)\s+([A-Za-z_]\w*)/gu)) {
      const field = location[2];
      if (field === 'uv') {
        uvSetCount = Math.max(uvSetCount, 1);
        continue;
      }
      const uvIndex = field?.match(/^uv(\d+)_?$/u)?.[1];
      if (uvIndex !== undefined) uvSetCount = Math.max(uvSetCount, Number(uvIndex) + 1);
    }
    if (/@location\s*\(/u.test(body))
      return { uvSetCount: uvSetCount > 0 ? uvSetCount : undefined, vertexInputRequired: true };
  }
  return {
    uvSetCount: undefined,
    vertexInputRequired: /@vertex\s*fn[^{]*\([^)]*@location\s*\(/u.test(code),
  };
}

function materialUniformRequired(source: string): boolean {
  const declarations = source.matchAll(
    /((?:@\w+\s*\([^)]*\)\s*)+)var\s*<\s*uniform\s*>\s*([A-Za-z_]\w*)\s*:/gu,
  );
  let observed = 0;
  let materialUniform = false;
  for (const declaration of declarations) {
    observed++;
    const attributes = declaration[1] ?? '';
    const group = /@group\s*\(\s*(\d+)u?\s*\)/u.exec(attributes);
    const binding = /@binding\s*\(\s*(\d+)u?\s*\)/u.exec(attributes);
    // An unrecognized constant expression could alias the material binding.
    if (group === null || binding === null) return true;
    if (Number(group[1]) !== 1 || Number(binding[1]) !== 0) continue;
    materialUniform = true;
    const name = declaration[2];
    if (name === undefined) return true;
    // Count the whole module, including helpers and every entry point. A local
    // name shadow or an unused helper conservatively keeps the uniform offset.
    const references = source.matchAll(new RegExp(`\\b${name}\\b`, 'gu'));
    references.next(); // declaration
    if (!references.next().done) return true;
  }
  // Unknown declarations and synthetic sources keep the existing path. Check
  // every uniform: separate entries may alias the same binding with other names.
  return !materialUniform || observed !== [...source.matchAll(/\bvar\s*<\s*uniform\s*>/gu)].length;
}

function materialBindings(source: string): readonly number[] | undefined {
  const bindings: number[] = [];
  let observed = 0;
  for (const declaration of source.matchAll(/((?:@\w+\s*\([^)]*\)\s*)+)var\b/gu)) {
    const attributes = declaration[1] ?? '';
    if (!attributes.includes('@group') && !attributes.includes('@binding')) continue;
    const group = /@group\s*\(\s*(\d+)u?\s*\)/u.exec(attributes);
    const binding = /@binding\s*\(\s*(\d+)u?\s*\)/u.exec(attributes);
    if (group === null || binding === null) return undefined;
    observed += 1;
    if (Number(group[1]) === 1) bindings.push(Number(binding[1]));
  }
  return observed > 0 && observed === [...source.matchAll(/@group\s*\(/gu)].length
    ? Object.freeze(bindings)
    : undefined;
}

/** Reflection may arrive after source warmup; retain the already admitted source facts. */
export function withMaterialShaderEntryPoints(
  program: MaterialShaderProgram,
  entryPoints?: readonly ShaderEntryPointReads[],
): MaterialShaderProgram {
  if (entryPoints === undefined || program.entryPoints === entryPoints) return program;
  if (program.entryPoints !== undefined) {
    const same =
      program.entryPoints.length === entryPoints.length &&
      program.entryPoints.every((entry, index) => {
        const other = entryPoints[index];
        return (
          other !== undefined &&
          entry.name === other.name &&
          entry.stage === other.stage &&
          entry.bindings.length === other.bindings.length &&
          entry.bindings.every((binding, index) => {
            const candidate = other.bindings[index];
            return (
              candidate !== undefined &&
              binding.group === candidate.group &&
              binding.binding === candidate.binding &&
              (binding.fields === candidate.fields ||
                (binding.fields !== undefined &&
                  candidate.fields !== undefined &&
                  binding.fields.length === candidate.fields.length &&
                  binding.fields.every((field, index) => field === candidate.fields?.[index])))
            );
          })
        );
      });
    if (!same)
      throw new Error(
        'ShaderRegistry: conflicting shader entry read contract for immutable source',
      );
    return program;
  }
  // Reads published inside a retained ABI receipt are already deep-frozen JSON.
  const reads = isDeepFrozenJson(entryPoints)
    ? entryPoints
    : entryPoints.map((entry) =>
        Object.freeze({
          ...entry,
          bindings: Object.freeze(
            entry.bindings.map((binding) =>
              Object.freeze({
                ...binding,
                ...(binding.fields === undefined
                  ? {}
                  : { fields: Object.freeze([...binding.fields]) }),
              }),
            ),
          ),
        }),
      );
  return Object.freeze({ ...program, entryPoints: Object.freeze(reads) });
}

export function createMaterialShaderProgram(
  source: string,
  entryPoints?: readonly ShaderEntryPointReads[],
): MaterialShaderProgram {
  const code = stripWgslComments(source);
  const bindings = [...code.matchAll(/@group\s*\(\s*2\s*\)\s*@binding\s*\(\s*(\d+)\s*\)/gu)].map(
    (match) => Number(match[1]),
  );
  const skin = bindings.includes(1) || bindings.includes(2);
  const cluster = bindings.some((binding) => binding >= 3);
  const hash = fnv1aUtf16(source);
  return withMaterialShaderEntryPoints(
    Object.freeze({
      source,
      sampledUserTextureFields: Object.freeze(
        findUndeclaredSampledTextures(source, NO_TEXTURE_DECLARATIONS),
      ),
      identity: `${source.length}:${hash >>> 0}`,
      group2: skin ? (cluster ? 'skin-cluster' : 'skin') : cluster ? 'cluster' : 'mesh',
      probeBlendRecordRequired:
        /@group\s*\(\s*3\s*\)\s*@binding\s*\(\s*1\s*\)\s*var\s*<\s*storage\s*(?:,\s*read\s*)?>\s*\w+\s*:\s*array\s*<\s*vec4\s*<\s*f32\s*>\s*>/u.test(
          code,
        ),
      ...vertexInputs(code),
      materialUniformRequired: materialUniformRequired(code),
      materialBindings: materialBindings(code),
      overrideIds: Object.freeze([
        ...new Set(
          [...code.matchAll(/@id\s*\(\s*(\d+)u?\s*\)\s*override\b/gu)].map((match) =>
            String(Number(match[1])),
          ),
        ),
      ]),
    }),
    entryPoints,
  );
}
