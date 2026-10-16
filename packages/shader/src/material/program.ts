export type PipelineGroup2Contract = 'mesh' | 'skin' | 'cluster' | 'skin-cluster';

/** Immutable facts about one composed source, shared across material passes and GPU devices. */
export interface MaterialShaderProgram {
  readonly source: string;
  readonly identity: string;
  readonly group2: PipelineGroup2Contract;
  /** Undefined is an admitted absence, not a request to scan the source again. */
  readonly uvSetCount: number | undefined;
  readonly probeBlendRecordRequired: boolean;
  /** False only when the material uniform has no references beyond its declaration. */
  readonly materialUniformRequired: boolean;
  /** Literal group(1) declarations; undefined keeps unknown source contracts conservative. */
  readonly materialBindings: readonly number[] | undefined;
}

/** WGSL permits nested block comments; preserve token separation when removing them. */
function withoutComments(source: string): string {
  const parts: string[] = [];
  const comments = /\/\/|\/\*/gu;
  const blocks = /\/\*|\*\//gu;
  let start = 0;
  for (let comment = comments.exec(source); comment !== null; comment = comments.exec(source)) {
    parts.push(source.slice(start, comment.index), ' ');
    if (comment[0] === '//') {
      const end = source.indexOf('\n', comments.lastIndex);
      start = end < 0 ? source.length : end;
    } else {
      let depth = 1;
      blocks.lastIndex = comments.lastIndex;
      for (let block = blocks.exec(source); block !== null; block = blocks.exec(source)) {
        depth += block[0] === '/*' ? 1 : -1;
        if (depth === 0) break;
      }
      start = depth === 0 ? blocks.lastIndex : source.length;
    }
    comments.lastIndex = start;
  }
  return parts.length === 0 ? source : parts.join('') + source.slice(start);
}

export function materialShaderUvSetCount(source: string): number | undefined {
  return vertexUvSetCount(withoutComments(source));
}

function vertexUvSetCount(code: string): number | undefined {
  const inputStructs = [...code.matchAll(/struct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/gu)].filter(
    (match) => /@location\s*\(/u.test(match[2] ?? ''),
  );
  for (const inputStruct of inputStructs) {
    const name = inputStruct[1];
    const body = inputStruct[2];
    if (name === undefined || body === undefined) continue;
    const firstParameter = new RegExp(
      `@vertex\\s*fn\\s+\\w+\\s*\\(\\s*\\w+\\s*:\\s*${name}\\b`,
      'u',
    );
    if (!firstParameter.test(code)) continue;
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
    return uvSetCount > 0 ? uvSetCount : undefined;
  }
  return undefined;
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

export function createMaterialShaderProgram(source: string): MaterialShaderProgram {
  const code = withoutComments(source);
  const bindings = [...code.matchAll(/@group\s*\(\s*2\s*\)\s*@binding\s*\(\s*(\d+)\s*\)/gu)].map(
    (match) => Number(match[1]),
  );
  const skin = bindings.includes(1) || bindings.includes(2);
  const cluster = bindings.some((binding) => binding >= 3);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Object.freeze({
    source,
    identity: `${source.length}:${hash >>> 0}`,
    group2: skin ? (cluster ? 'skin-cluster' : 'skin') : cluster ? 'cluster' : 'mesh',
    probeBlendRecordRequired:
      /@group\s*\(\s*3\s*\)\s*@binding\s*\(\s*1\s*\)\s*var\s*<\s*storage\s*(?:,\s*read\s*)?>\s*\w+\s*:\s*array\s*<\s*vec4\s*<\s*f32\s*>\s*>/u.test(
        code,
      ),
    uvSetCount: vertexUvSetCount(code),
    materialUniformRequired: materialUniformRequired(code),
    materialBindings: materialBindings(code),
  });
}
