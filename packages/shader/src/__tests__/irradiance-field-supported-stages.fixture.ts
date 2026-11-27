type Point = readonly [number, number, number];
interface Support {
  unavailable: boolean;
  pendingRelocation: boolean;
}
interface Corners {
  values: Point[];
  weights: number[];
  incomplete: boolean;
}
export interface SupportedStageAction {
  readonly total: number;
  readonly unavailable: boolean;
  readonly pendingRelocation: boolean;
  readonly incomplete: boolean;
}
export interface SupportedStageScript {
  readonly first: 0 | 8;
  readonly initialIncomplete: boolean;
  readonly actions: readonly [SupportedStageAction, SupportedStageAction];
  readonly segment: number;
}

/** Historical 96de433d source, frozen before reducing static callsites. */
export const SUPPORTED_CORNER_BASELINE = `fn irradianceFieldSupportedCorners(corners: ptr<function, IrradianceFieldCorners>, first: u32,
    level: u32, position: vec3f, normal: vec3f, viewDir: vec3f, direction: vec3f, coneAngle: f32) -> f32 {
  var support: IrradianceFieldSupport;
  let total = irradianceFieldLevelCorners(corners, first, level, position, normal, viewDir, direction, coneAngle, false, false, &support);
  if (total > 0.0 || (*corners).incomplete || support.unavailable) { return total; }
  if (support.pendingRelocation) {
#ifdef IRRADIANCE_FIELD_VISIBILITY
    let scale = irradianceFieldLevelScale(level);
    let anchor = position + normal * irradianceField.bias.x * scale;
    let biased = position + (normal * irradianceField.bias.x + viewDir * irradianceField.bias.y) * scale;
    let segment = fieldSegmentVisibility(biased, anchor);
    if (segment < 0.0) { (*corners).incomplete = true; return 0.0; }
    if (segment == 0.0) { return 0.0; }
    var alternative: IrradianceFieldSupport;
    let weight = irradianceFieldLevelCorners(corners, first, level, position, normal, viewDir, direction, coneAngle, true, true, &alternative);
    // Every positive geometric candidate must be known. Known occlusion only
    // excludes that corner; absent lighting or another pending pose rejects the
    // alternative instead of normalizing the remaining known subset.
    if (alternative.unavailable || alternative.pendingRelocation) { return 0.0; }
    return weight;
#else
    return 0.0;
#endif
  }
  // A probe plane, classification or conservative visibility band can remove
  // every corner. Try normal clearance only when support is known; every new
  // corner still passes its active/side/moment/segment checks. Angular absence
  // and unavailable transport keep the original coarser-level/invalid result.
  return irradianceFieldLevelCorners(corners, first, level, position, normal, viewDir, direction, coneAngle, true, false, &support);
}`;

export function supportedCornerFunction(source: string) {
  const anchor = 'fn irradianceFieldSupportedCorners(';
  if (source.split(anchor).length !== 2)
    throw Error('One actual supported-corner function required');
  const start = source.indexOf(anchor);
  let end = source.indexOf('{', start) + 1,
    depth = 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  if (depth !== 0) throw Error('Complete actual function body required');
  return source.slice(start, end);
}

export function supportedCornerCallsites(source: string) {
  return Array.from(supportedCornerFunction(source).matchAll(/\birradianceFieldLevelCorners\s*\(/g))
    .length;
}

export function supportedVisibilitySource(source: string, visibility: boolean) {
  let enabled = true;
  return supportedCornerFunction(source)
    .split('\n')
    .filter((line) => {
      if (line.trim() === '#ifdef IRRADIANCE_FIELD_VISIBILITY') {
        enabled = visibility;
        return false;
      }
      if (line.trim() === '#else') {
        enabled = !visibility;
        return false;
      }
      if (line.trim() === '#endif') {
        enabled = true;
        return false;
      }
      if (line.trim().startsWith('#')) throw Error('Unexpected directive in the owning function');
      return enabled;
    })
    .join('\n');
}

// Only the two existing +/* vector expressions need arithmetic lowering. The
// control flow below executes mechanically from the actual function, not a model.
function floatExpression(expression: string): string {
  const tokens = expression.match(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+(?:\.\d+)?|[()+*]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s+/g, '')) throw Error('Unsupported FP expression');
  let at = 0;
  function factor(): string {
    const token = tokens[at++];
    if (!token) throw Error('Incomplete FP expression');
    if (token !== '(') return token;
    const result = sum();
    if (tokens[at++] !== ')') throw Error('Unbalanced FP expression');
    return result;
  }
  function product(): string {
    let result = factor();
    while (tokens[at] === '*') {
      at++;
      result = `fpMul(${result},${factor()})`;
    }
    return result;
  }
  function sum(): string {
    let result = product();
    while (tokens[at] === '+') {
      at++;
      result = `fpAdd(${result},${product()})`;
    }
    return result;
  }
  const result = sum();
  if (at !== tokens.length) throw Error('Unconsumed FP expression');
  return result;
}

function fpOperation(
  a: number | readonly number[],
  b: number | readonly number[],
  multiply: boolean,
) {
  const scalar = (x: number, y: number) => Math.fround(multiply ? x * y : x + y);
  if (typeof a === 'number' && typeof b === 'number') return scalar(a, b);
  return [0, 1, 2].map((i) =>
    scalar(
      typeof a === 'number' ? a : (a[i] as number),
      typeof b === 'number' ? b : (b[i] as number),
    ),
  );
}

export function supportedCornerExecutor(source: string, visibility: boolean) {
  const selected = uncachedAnchorControl(supportedVisibilitySource(source, visibility)).replace(
    /\/\/[^\n]*/g,
    '',
  );
  let body = selected.slice(selected.indexOf('{') + 1, selected.lastIndexOf('}'));
  if (/\b(?:while|loop|switch)\b/.test(body)) throw Error('Unsupported unbounded/control syntax');
  const loops = body.match(/\bfor\s*\(/g) ?? [];
  if (
    loops.length > 1 ||
    (loops.length === 1 && !body.replace(/\s+/g, '').includes('for(varstage=0u;stage<2u;stage++)'))
  )
    throw Error('Only the owning fixed two-stage loop is executable');
  body = body
    .replace(
      /let (anchor|biased) = ([^;]+);/g,
      (_, name: string, expression: string) => `let ${name} = ${floatExpression(expression)};`,
    )
    .replace(/var (\w+): IrradianceFieldSupport;/g, 'let $1 = makeSupport();')
    .replace(/\bIrradianceFieldSupport\(/g, 'makeSupport(')
    .replace(/\(\*corners\)/g, 'corners')
    .replace(/&(support|alternative)\b/g, '$1')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(\d+(?:\.\d+)?)[uf]\b/g, '$1');
  const allowed = new Set([
    'if',
    'for',
    'makeSupport',
    'fpAdd',
    'fpMul',
    'irradianceFieldLevelCorners',
    'irradianceFieldLevelScale',
    'fieldSegmentVisibility',
  ]);
  for (const match of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g))
    if (!allowed.has(match[1] ?? ''))
      throw Error(`Unexpected call in restricted source: ${match[1]}`);
  return new Function(
    'corners',
    'first',
    'level',
    'position',
    'normal',
    'viewDir',
    'direction',
    'coneAngle',
    'irradianceField',
    'irradianceFieldLevelCorners',
    'irradianceFieldLevelScale',
    'fieldSegmentVisibility',
    'makeSupport',
    'fpAdd',
    'fpMul',
    `"use strict";${body}`,
  ) as (...args: unknown[]) => number;
}

// Keep this existing scripted visibility provider at its uncached delegate;
// the production adapter's activation/key fence has a separate exact test.
function uncachedAnchorControl(source: string) {
  return source.replace(
    'irradianceFieldCachedAnchorSegment(level,biased,anchor)',
    'fieldSegmentVisibility(biased,anchor)',
  );
}

export function observeSupportedStages(
  execute: ReturnType<typeof supportedCornerExecutor>,
  script: SupportedStageScript,
) {
  const corners: Corners = {
    incomplete: script.initialIncomplete,
    values: Array.from({ length: 16 }, (_, i) => [i + 10, -0, 0.5] as const),
    weights: Array.from({ length: 16 }, (_, i) => i + 20),
  };
  const events: unknown[] = [];
  let calls = 0;
  const makeSupport = (unavailable = false, pendingRelocation = false): Support => ({
    unavailable,
    pendingRelocation,
  });
  const level = (
    actual: Corners,
    first: number,
    level: number,
    position: Point,
    normal: Point,
    viewDir: Point,
    direction: Point,
    coneAngle: number,
    clearance: boolean,
    proof: boolean,
    support: Support,
  ) => {
    if (actual !== corners || calls >= 2)
      throw Error('Same slots and at most two actual calls required');
    const action = script.actions[calls],
      before = { ...support };
    if (!action) throw Error('Complete action sequence required');
    events.push({
      kind: 'level',
      first,
      level,
      position,
      normal,
      viewDir,
      direction,
      coneAngle,
      clearance,
      proof,
      supportBefore: before,
      slotsBefore: structuredClone(corners),
    });
    support.unavailable ||= action.unavailable;
    support.pendingRelocation ||= action.pendingRelocation;
    corners.incomplete ||= action.incomplete;
    corners.values[first + calls] = [calls + 1, -0, 0.25];
    corners.weights[first + calls] = Math.fround((calls + 1) / 8);
    calls++;
    events.push({ kind: 'level-result', support: { ...support }, slots: structuredClone(corners) });
    return Math.fround(action.total);
  };
  const scale = (level: number) => {
    events.push({ kind: 'scale', level });
    return 0.5;
  };
  const segment = (origin: Point, endpoint: Point) => {
    events.push({ kind: 'segment', origin, endpoint });
    return Math.fround(script.segment);
  };
  const position: Point = [0.125, -0.25, 3],
    normal: Point = [0, 0, 1],
    viewDir: Point = [Math.fround(0.6), 0, Math.fround(0.8)];
  const result = execute(
    corners,
    script.first,
    2,
    position,
    normal,
    viewDir,
    [0, 1, 0],
    0.75,
    { bias: { x: 0.0625, y: 0.03125 } },
    level,
    scale,
    segment,
    makeSupport,
    (a: number | readonly number[], b: number | readonly number[]) => fpOperation(a, b, false),
    (a: number | readonly number[], b: number | readonly number[]) => fpOperation(a, b, true),
  );
  return { result, events, corners, calls };
}

export function supportedStageActions(): SupportedStageAction[] {
  return [-Infinity, -1, -0, 0, 2 ** -126, 1, Infinity, NaN].flatMap((total) =>
    Array.from({ length: 8 }, (_, flags) => ({
      total,
      unavailable: (flags & 1) !== 0,
      pendingRelocation: (flags & 2) !== 0,
      incomplete: (flags & 4) !== 0,
    })),
  );
}

/** Scripted provider validates the actual owning function's WGSL/control ABI.
 * It does not replace LevelCorners in the published Builtin or qualify GI. */
export function supportedStageControlKernel(source: string, visibility: boolean) {
  return `
struct IrradianceFieldSupport { unavailable:bool,pendingRelocation:bool }
struct IrradianceFieldCorners { values:array<vec3f,16>,weights:array<f32,16>,incomplete:bool }
struct FieldConfiguration { bias:vec4f }
const irradianceField=FieldConfiguration(vec4f(0.0625,0.03125,0,0));
@group(0) @binding(0) var<storage,read> stageInputs:array<vec4u>;
@group(0) @binding(1) var<storage,read_write> stageOutputs:array<vec4u>;
var<private> stageCalls:u32=0u;
var<private> observedFlags:u32=0u;
fn irradianceFieldLevelScale(level:u32)->f32{return 0.5;}
fn fieldSegmentVisibility(origin:vec3f,endpoint:vec3f)->f32{return bitcast<f32>(stageInputs[2].x);}
fn irradianceFieldLevelCorners(corners:ptr<function,IrradianceFieldCorners>,first:u32,level:u32,
 position:vec3f,normal:vec3f,viewDir:vec3f,direction:vec3f,coneAngle:f32,
 normalClearance:bool,clearanceProof:bool,support:ptr<function,IrradianceFieldSupport>)->f32 {
 if(stageCalls>=2u){return bitcast<f32>(0x7fc00000u);}
 let row=stageInputs[stageCalls];
 observedFlags=observedFlags*4u+u32(normalClearance)+2u*u32(clearanceProof);
 (*support).unavailable=(*support).unavailable || (row.y&1u)!=0u;
 (*support).pendingRelocation=(*support).pendingRelocation || (row.y&2u)!=0u;
 (*corners).incomplete=(*corners).incomplete || (row.y&4u)!=0u;
 (*corners).weights[first+stageCalls]=bitcast<f32>(row.z);
 (*corners).values[first+stageCalls]=vec3f(f32(stageCalls+1u),0,0.25);
 stageCalls++;return bitcast<f32>(row.x);
}
${uncachedAnchorControl(supportedVisibilitySource(source, visibility))}
@compute @workgroup_size(1) fn supportedStageControl(){
 var corners:IrradianceFieldCorners;
 corners.weights[8]=42;corners.weights[9]=43;
 let result=irradianceFieldSupportedCorners(&corners,8u,2u,vec3f(0.125,-0.25,3),
  vec3f(0,0,1),vec3f(0.6,0,0.8),vec3f(0,1,0),0.75);
 stageOutputs[0]=vec4u(bitcast<u32>(result),stageCalls,u32(corners.incomplete),observedFlags);
 stageOutputs[1]=vec4u(bitcast<u32>(corners.weights[8]),bitcast<u32>(corners.weights[9]),0u,0u);
}`;
}
