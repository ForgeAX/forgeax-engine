import { readFileSync } from 'node:fs';

export function visibilityCacheSource() {
  return readFileSync(new URL('../ray-irradiance-field-sample.wgsl', import.meta.url), 'utf8');
}

export function visibilityFunction(source: string, name: string) {
  const marker = `fn ${name}(`;
  if (source.split(marker).length !== 2) throw Error(`One actual ${name} function required`);
  const start = source.indexOf('{', source.indexOf(marker));
  let end = start + 1;
  let depth = 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw Error('Complete function required');
  return source.slice(start + 1, end - 1);
}

export interface CacheCase {
  readonly enabled: number;
  readonly level: number;
  readonly corner: number;
  readonly normalClearance: boolean;
  readonly secondary: boolean;
  readonly origin: readonly number[];
  readonly endpoint: readonly number[];
  readonly primary: readonly number[];
  readonly proof: readonly number[];
  readonly cachedEndpoint: readonly number[];
  readonly cached: readonly [number, number];
  readonly actual: number;
}

/** Execute the actual WGSL cache decision, with primitive query replaced by an
 * observable ternary oracle. No geometric/FP sampler is translated or mocked. */
export function runVisibilityCache(source: string, input: CacheCase) {
  const body = visibilityFunction(source, 'irradianceFieldCachedCornerSegment')
    .replace(/#ifdef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE|#endif/g, '')
    .replace(/bitcast<vec3u>\((\w+)\)/g, '$1')
    .replace(/any\((\w+) != ([^)]+)\)/g, 'different($1,$2)')
    .replace(/\b(let|var)\b/g, 'let')
    .replace(/\b(\d+)u\b/g, '$1');
  const index = input.level * 16 + (input.normalClearance ? 8 : 0) + input.corner;
  const endpoints = Object.assign({}, { [index]: input.cachedEndpoint });
  const primary = Object.assign({}, { [input.level]: input.primary });
  const proof = Object.assign(
    {},
    { [input.level * 2 + Number(input.normalClearance)]: input.proof },
  );
  const values = Object.assign({}, { [index]: { x: input.cached[0], y: input.cached[1] } });
  let calls = 0;
  const evaluate = new Function(
    'level',
    'corner',
    'normalClearance',
    'secondary',
    'origin',
    'endpoint',
    'fieldProbeCacheEnabled',
    'fieldProbeCachePrimary',
    'fieldProbeCacheProof',
    'fieldProbeCacheEndpoint',
    'fieldProbeCacheValue',
    'select',
    'different',
    'fieldSegmentVisibility',
    body,
  );
  const value = evaluate(
    input.level,
    input.corner,
    input.normalClearance,
    input.secondary,
    input.origin,
    input.endpoint,
    input.enabled,
    primary,
    proof,
    endpoints,
    values,
    (a: unknown, b: unknown, test: boolean) => (test ? b : a),
    (a: readonly number[], b: readonly number[]) => a.some((word, i) => word !== b[i]),
    () => {
      calls++;
      return input.actual;
    },
  );
  return { value, calls };
}

export function runVisibilityAnchorCache(source: string, input: CacheCase) {
  const body = visibilityFunction(source, 'irradianceFieldCachedAnchorSegment')
    .replace(/#ifdef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE|#endif/g, '')
    .replace(/bitcast<vec3u>\((\w+)\)/g, '$1')
    .replace(/all\((\w+) == ([^)]+)\)/g, '!different($1,$2)')
    .replace(/\b(\d+)u\b/g, '$1');
  const primary = { [input.level]: input.primary };
  const anchor = { [input.level]: input.cachedEndpoint };
  const values = { [input.level]: input.cached[0] };
  let calls = 0;
  const evaluate = new Function(
    'level',
    'origin',
    'endpoint',
    'fieldProbeCacheEnabled',
    'fieldProbeCachePrimary',
    'fieldProbeCacheAnchor',
    'fieldProbeCacheAnchorValue',
    'different',
    'fieldSegmentVisibility',
    body,
  );
  const value = evaluate(
    input.level,
    input.origin,
    input.endpoint,
    input.enabled,
    primary,
    anchor,
    values,
    (a: readonly number[], b: readonly number[]) => a.some((word, i) => word !== b[i]),
    () => {
      calls++;
      return input.actual;
    },
  );
  return { value, calls };
}
