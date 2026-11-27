export const sceneHistoryCases = [
  { name: 'ordinary', half: [0x4400, 0x3c00, 0x4000, 0x3c00], rgb: [4, 1, 2], valid: true },
  { name: 'known-black', half: [0, 0, 0, 0x3c00], rgb: [0, 0, 0], valid: true },
  {
    name: 'below-half-max',
    half: [0x7bfe, 0x3c00, 0x4000, 0x3c00],
    rgb: [65472, 1, 2],
    valid: true,
  },
  {
    name: 'exact-half-max',
    half: [0x7bff, 0x3c00, 0x4000, 0x3c00],
    rgb: [65504, 1, 2],
    valid: true,
  },
  { name: 'negative', half: [0xbc00, 0x3c00, 0x4000, 0x3c00], rgb: [-1, 1, 2], valid: false },
  { name: 'nan', half: [0x7e00, 0x3c00, 0x4000, 0x3c00], rgb: [NaN, 1, 2], valid: false },
  {
    name: 'positive-infinity',
    half: [0x7c00, 0x3c00, 0x4000, 0x3c00],
    rgb: [Infinity, 1, 2],
    valid: false,
  },
  {
    name: 'negative-infinity',
    half: [0xfc00, 0x3c00, 0x4000, 0x3c00],
    rgb: [-Infinity, 1, 2],
    valid: false,
  },
] as const;

/** Execute the current copy predicate and history-admission condition, not GPU storage conversion. */
export function sceneHistorySourceWitness(source: string, rgb: readonly number[]) {
  const at = source.indexOf('fn copySceneHistory(');
  if (at < 0) throw new Error('Missing actual copySceneHistory');
  const begin = source.indexOf('{', at);
  let end = begin + 1,
    depth = 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw new Error('Unclosed actual copySceneHistory');
  const body = source
    .slice(begin + 1, end - 1)
    .replace(/\blet\b/g, 'const')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(\d+)u\b/g, '$1')
    .replace('any(textureDimensions(sceneColor) != extent)', 'false')
    .replace(
      /all\(color\.xyz\s*(>=|<=|<|>)\s*vec3f\(([^)]+)\)\)/g,
      (_match, operator: string, bound: string) => `color.xyz.every(v => v ${operator} ${bound})`,
    )
    .replaceAll('color.xyz', 'color');
  const vector = (values: readonly number[]) => ({
    x: values[0],
    y: values[1],
    z: values[2],
    xy: values.slice(0, 2),
    every: (predicate: (value: number) => boolean) => values.every(predicate),
  });
  const output: { x: readonly number[]; y: { x: number; y: number } }[] = [];
  const context = {
    gid: {},
    groups: {},
    spLinearId: () => 0,
    extentSize: () => ({ x: 1, y: 1 }),
    previousSceneOut: output,
    sceneColor: {},
    textureLoad: () => vector(rgb),
    vec2u: (x: unknown, y: unknown) => ({ x, y }),
    vec2i: (value: unknown) => value,
    vec2f: (x: number, y: number) => ({ x, y }),
    vec3f: (value: number) => vector([value, value, value]),
    select: (a: unknown, b: unknown, condition: boolean) => (condition ? b : a),
    pack2x16float: (value: unknown) => value,
  };
  Function(...Object.keys(context), body)(...Object.values(context));
  const copied = output[0];
  if (!copied) throw new Error('Actual copy did not write its controlled one-pixel output');
  const hit = source.match(/if \((radiance\.w\s*>\s*0\.0)\) \{/g);
  if (hit?.length !== 1) throw new Error('Expected one actual traceScreenProbes history gate');
  const predicate = hit[0].slice(4, -3);
  return {
    rgb: [copied.x[0], copied.x[1], copied.y.x],
    alpha: copied.y.y,
    resolvesScreenHit: Function('radiance', `return ${predicate};`)({ w: copied.y.y }) as boolean,
  };
}
