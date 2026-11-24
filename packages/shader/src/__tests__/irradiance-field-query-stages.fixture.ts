import { createHash } from 'node:crypto';

/** Exact 076cfac control tails. Geometry/FP preparation remains source-owned. */
export const LEVEL_VISIBILITY_BASELINE = `#ifdef IRRADIANCE_FIELD_VISIBILITY
    let segment = fieldSegmentVisibility(biased, probePosition);
    if (segment < 0.0) { (*corners).incomplete = true; return 0.0; }
    if (segment == 0.0) { continue; }
    if (clearanceProof) {
      let anchorSegment = fieldSegmentVisibility(lightingPosition, probePosition);
      if (anchorSegment < 0.0) { (*corners).incomplete = true; return 0.0; }
      if (anchorSegment == 0.0) { continue; }
    }
#endif
    (*corners).values[first + corner] = value.xyz;
    (*corners).weights[first + corner] = weight;
    total += weight;`;

export const CORNERS_BLEND_BASELINE = `  let fine = irradianceFieldSupportedCorners(&corners, 0u, level, position, normal, viewDir, direction, coneAngle);
  var coarse = 0.0;
  // A fully invalid finer neighbourhood also falls back to the coarser level.
  if (level + 1u < count && (alpha < 1.0 || !(fine > 0.0))) {
    coarse = irradianceFieldSupportedCorners(&corners, 8u, level + 1u, position, normal, viewDir, direction, coneAngle);
  }
  let wFine = select(0.0, alpha, fine > 0.0);
  let wCoarse = select(0.0, select(1.0 - alpha, 1.0, !(fine > 0.0)), coarse > 0.0);
  let total = wFine + wCoarse;
  corners.valid = total > 0.0 && !corners.incomplete;
  if (corners.valid) {
    irradianceFieldScale(&corners, 0u, select(0.0, wFine / (fine * total), fine > 0.0));
    irradianceFieldScale(&corners, 8u, select(0.0, wCoarse / (coarse * total), coarse > 0.0));
  }
  return corners;`;

export function queryStageFunction(source: string, name: string) {
  const anchor = `fn ${name}(`;
  if (source.split(anchor).length !== 2) throw Error('Unique owning function required');
  const start = source.indexOf(anchor),
    open = source.indexOf('{', start);
  let depth = 1,
    end = open + 1;
  while (depth > 0 && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw Error('Complete owning function required');
  return source.slice(start, end);
}

export function levelVisibilityTail(source: string) {
  const fn = queryStageFunction(source, 'irradianceFieldLevelCorners');
  const start = fn.indexOf('#ifdef IRRADIANCE_FIELD_VISIBILITY');
  const end = fn.indexOf('total += weight;', start) + 'total += weight;'.length;
  if (start < 0 || end < start) throw Error('Actual visibility and slot-write boundary required');
  return fn.slice(start, end);
}

export function cornersBlendTail(source: string) {
  const fn = queryStageFunction(source, 'irradianceFieldCorners');
  const start = / {2}(?:let|var) fine =/.exec(fn)?.index;
  if (start === undefined) throw Error('Actual fine/coarse boundary required');
  return fn.slice(start, fn.lastIndexOf('}')).trimEnd();
}

export function queryStageBoundary(source: string) {
  return createHash('sha256')
    .update(
      source
        .replace(levelVisibilityTail(source), '<visibility-slot-tail>')
        .replace(cornersBlendTail(source), '<fine-coarse-tail>'),
    )
    .digest('hex');
}

export function queryStageCallsites(source: string) {
  return {
    supported: (cornersBlendTail(source).match(/\birradianceFieldSupportedCorners\s*\(/g) ?? [])
      .length,
    segment: (
      levelVisibilityTail(source).match(
        /\b(?:fieldSegmentVisibility|irradianceFieldCachedCornerSegment)\s*\(/g,
      ) ?? []
    ).length,
  };
}

function visibilityBranch(source: string, visibility: boolean) {
  return source.replace(
    /#ifdef IRRADIANCE_FIELD_VISIBILITY\n([\s\S]*?)#endif/g,
    (_, body: string) => (visibility ? body : ''),
  );
}

function lowerControl(source: string) {
  return uncachedSegmentControl(source)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\(\*corners\)/g, 'corners')
    .replace(/&corners\b/g, 'corners')
    .replace(/any\(bitcast<vec3u>\((\w+)\) != bitcast<vec3u>\((\w+)\)\)/g, 'differentWords($1,$2)')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(\d+)[u]\b/g, '$1');
}

// The existing scripted provider observes the uncached delegate. Cache-key
// activation and fallback are exercised separately from this control tail.
function uncachedSegmentControl(source: string) {
  return source.replace(
    'irradianceFieldCachedCornerSegment(level,corner,normalClearance,stage != 0u,segmentOrigin,probePosition)',
    'fieldSegmentVisibility(segmentOrigin,probePosition)',
  );
}

interface Slots {
  values: number[][];
  weights: number[];
  incomplete: boolean;
  valid: boolean;
}
function slots(): Slots {
  return {
    values: Array.from({ length: 16 }, (_, i) => [i + 1, -0, 0.25]),
    weights: Array.from({ length: 16 }, (_, i) => i + 16),
    incomplete: false,
    valid: false,
  };
}

export interface CornerScript {
  readonly fine: number;
  readonly coarse: number;
  readonly alpha: number;
  readonly level: number;
  readonly count: number;
  readonly initialIncomplete: boolean;
  readonly fineIncomplete: boolean;
  readonly coarseIncomplete: boolean;
}

/** Executes the actual fine/coarse/normalization tail, with observable providers. */
export function observeCornerTail(tail: string, script: CornerScript) {
  const body = lowerControl(tail)
    .replace('1.0 - alpha', 'sub(1.0,alpha)')
    .replace('wFine + wCoarse', 'add(wFine,wCoarse)')
    .replace('wFine / (fine * total)', 'div(wFine,mul(fine,total))')
    .replace('wCoarse / (coarse * total)', 'div(wCoarse,mul(coarse,total))');
  const execute = new Function(
    'corners',
    'level',
    'count',
    'alpha',
    'position',
    'normal',
    'viewDir',
    'direction',
    'coneAngle',
    'irradianceFieldSupportedCorners',
    'irradianceFieldScale',
    'select',
    'add',
    'sub',
    'mul',
    'div',
    `"use strict";${body}`,
  ) as (...args: unknown[]) => Slots;
  const corners = slots(),
    events: unknown[] = [];
  corners.incomplete = script.initialIncomplete;
  let calls = 0;
  const supported = (actual: Slots, first: number, level: number, ...args: unknown[]) => {
    if (actual !== corners || calls >= 2)
      throw Error('Original slots and at most two calls required');
    events.push({ kind: 'supported', first, level, args, before: structuredClone(corners) });
    const value = Math.fround(calls === 0 ? script.fine : script.coarse);
    corners.incomplete ||= calls === 0 ? script.fineIncomplete : script.coarseIncomplete;
    corners.values[first] = [calls + 1, -0, 0.5];
    corners.weights[first] = Math.fround((calls + 1) / 8);
    calls++;
    return value;
  };
  const scale = (actual: Slots, first: number, value: number) => {
    if (actual !== corners) throw Error('Shared original slots required');
    events.push({ kind: 'scale', first, value });
    for (let i = first; i < first + 8; i++)
      corners.weights[i] = Math.fround((corners.weights[i] ?? 0) * value);
  };
  const result = execute(
    corners,
    script.level,
    script.count,
    Math.fround(script.alpha),
    [1, 2, 3],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 0],
    0.5,
    supported,
    scale,
    (a: number, b: number, c: boolean) => (c ? b : a),
    (a: number, b: number) => Math.fround(a + b),
    (a: number, b: number) => Math.fround(a - b),
    (a: number, b: number) => Math.fround(a * b),
    (a: number, b: number) => Math.fround(a / b),
  );
  return { result, events, calls };
}

export interface VisibilityCorner {
  readonly eligible: boolean;
  readonly weight: number;
  readonly primary: number;
  readonly anchor: number;
  readonly anchorY?: number;
  readonly targetZ?: number;
}
export interface VisibilityScript {
  readonly first: 0 | 8;
  readonly proof: boolean;
  readonly initialIncomplete: boolean;
  readonly corners: readonly VisibilityCorner[];
}

function visibilityWordsDiffer(a: readonly number[], b: readonly number[]) {
  const words = (value: readonly number[]) => new Uint32Array(new Float32Array(value).buffer);
  const first = words(a),
    second = words(b);
  return first.some((word, i) => word !== second[i]);
}

/** Only prior geometric admission is scripted. The actual visibility and slot
 * tail executes unchanged in the original eight-corner order. This is not a
 * numerical substitute for the published complete LevelCorners function. */
export function observeVisibilityTail(tail: string, visibility: boolean, script: VisibilityScript) {
  const body = lowerControl(visibilityBranch(tail, visibility)).replace(
    'total += weight;',
    'total = Math.fround(total + weight);',
  );
  const execute = new Function(
    'corners',
    'first',
    'clearanceProof',
    'entries',
    'fieldSegmentVisibility',
    'differentWords',
    `"use strict";let total=0.0;
for(let corner=0;corner<8;corner++){
 const row=entries[corner];if(!row.eligible)continue;
 const biased=[corner,0,0], lightingPosition=[corner,row.anchorY ?? 1,0], probePosition=[corner,2,row.targetZ ?? 0];
 const value={xyz:[corner+1,-0,0.25]},weight=Math.fround(row.weight);
 ${body}
}return total;`,
  ) as (...args: unknown[]) => number;
  if (script.corners.length !== 8) throw Error('Eight original corner addresses required');
  const corners = slots(),
    events: unknown[] = [];
  corners.incomplete = script.initialIncomplete;
  const segment = (origin: number[], endpoint: number[]) => {
    const corner = origin[0] as number,
      row = script.corners[corner];
    if (!row) throw Error('Actual selected corner required');
    events.push({ origin, endpoint, slots: structuredClone(corners) });
    return Math.fround(Object.is(origin[1], 0) ? row.primary : row.anchor);
  };
  const result = execute(
    corners,
    script.first,
    script.proof,
    script.corners,
    segment,
    visibilityWordsDiffer,
  );
  return { result, events, corners };
}

/** Naga-only control ABI for mechanically selected production tails.
 * Scripted providers are separate from the complete builtins below. */
export function queryStageControlKernel(source: string, visibility: boolean) {
  return `
struct IrradianceFieldCorners { values:array<vec3f,16>,weights:array<f32,16>,valid:bool,incomplete:bool }
@group(0) @binding(0) var<storage,read> stageInput:array<vec4u>;
@group(0) @binding(1) var<storage,read_write> stageOutput:array<vec4u>;
var<private> supportedCalls:u32;
var<private> segmentCalls:u32;
fn irradianceFieldSupportedCorners(corners:ptr<function,IrradianceFieldCorners>,first:u32,
 level:u32,position:vec3f,normal:vec3f,viewDir:vec3f,direction:vec3f,coneAngle:f32)->f32 {
 let row=stageInput[supportedCalls];supportedCalls++;
 (*corners).incomplete=(*corners).incomplete || row.y!=0u;
 (*corners).weights[first]=bitcast<f32>(row.z);
 return bitcast<f32>(row.x);
}
${queryStageFunction(source, 'irradianceFieldScale')}
fn fieldSegmentVisibility(origin:vec3f,endpoint:vec3f)->f32 {
 segmentCalls++;return bitcast<f32>(stageInput[2u+u32(origin.x)].x);
}
fn cornerControl()->IrradianceFieldCorners {
 var corners:IrradianceFieldCorners;let level=0u;let count=2u;let alpha=0.5;
 let position=vec3f(0);let normal=vec3f(0,1,0);let viewDir=vec3f(0,0,1);
 let direction=normal;let coneAngle=0.75;
${cornersBlendTail(source)}
}
fn visibilityControl(corners:ptr<function,IrradianceFieldCorners>)->f32 {
 let first=0u;let clearanceProof=true;var total=0.0;
 for(var corner=0u;corner<8u;corner++){
 let biased=vec3f(f32(corner),0,0);let lightingPosition=vec3f(f32(corner),1,0);
 let probePosition=vec3f(f32(corner),2,0);let value=vec4f(0.5,0.25,0,1);let weight=0.125;
${uncachedSegmentControl(visibilityBranch(levelVisibilityTail(source), visibility))}
 }return total;
}
@compute @workgroup_size(1) fn queryStageControl(){
 var corners=cornerControl();let total=visibilityControl(&corners);
 stageOutput[0]=vec4u(supportedCalls,segmentCalls,u32(corners.incomplete),bitcast<u32>(total));
}`;
}
