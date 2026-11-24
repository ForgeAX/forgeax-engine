import { CARD_RADIOSITY_VISIBILITY_WGSL } from '../../raytracing/card-radiosity-kernels';
import { GlobalSdfQueryStatus } from '../../raytracing/global-sdf-query';

export interface CardVisibilityCase {
  name: string;
  origin: readonly number[];
  normal: readonly number[];
  target: readonly number[];
  direction: readonly number[];
  offset: readonly number[];
  parameter: number;
  distance: number;
  available: number;
  strength: number;
  status: number;
  expected: number;
  physicalVisibility?: number;
  expectedAvailable?: number;
  tag?: number;
  expectedRay: number;
  stratified?: boolean;
}

const base: CardVisibilityCase = {
  name: 'wall-before-midpoint',
  origin: [0, 0, 0],
  normal: [0, 0, 1],
  target: [1, 0, 0],
  direction: [1, 0, 0],
  offset: [0, 0, 0],
  parameter: 0.25,
  distance: 0.25,
  available: 1,
  strength: 0.5,
  status: GlobalSdfQueryStatus.hit,
  expected: 0,
  expectedRay: 0,
};

/** Analytic distances, not traced Engine output. The last two rows deliberately
 * retain soft-transition and angular false-occlusion limits as observable data. */
export const cardVisibilityCases: readonly CardVisibilityCase[] = [
  base,
  { ...base, name: 'zero-distance-known-hit-blocks-borrowing', parameter: 0, distance: 0 },
  {
    ...base,
    name: 'unknown-is-not-visible',
    available: 0,
    status: GlobalSdfQueryStatus.missingField,
    expectedAvailable: 0,
  },
  { ...base, name: 'unoccluded-endpoint', parameter: 1, distance: 1, expected: 1 },
  {
    ...base,
    name: 'miss-in-range',
    parameter: 2,
    distance: 2,
    status: GlobalSdfQueryStatus.miss,
    expected: 1,
  },
  {
    ...base,
    name: 'miss-beyond-observed-range-is-unknown',
    target: [3, 0, 0],
    parameter: 2,
    distance: 2,
    status: GlobalSdfQueryStatus.miss,
    expectedAvailable: 0,
  },
  {
    ...base,
    name: 'hit-at-the-same-max-is-not-a-miss',
    target: [3, 0, 0],
    parameter: 2,
    distance: 2,
    expected: 1 / 3,
  },
  { ...base, name: 'legacy-availability-has-no-distance-model', tag: 1, expectedAvailable: 0 },
  {
    ...base,
    name: 'negative-start-zero',
    parameter: 0,
    distance: 0,
    status: GlobalSdfQueryStatus.negativeStart,
  },
  { ...base, name: 'grazing-clear', target: [1, 0, 0.001], distance: 2, expected: 1 },
  { ...base, name: 'strength-zero-negative-control', strength: 0, expected: 0.25 },
  {
    ...base,
    name: 'soft-transition-residual-is-not-physical-proof',
    parameter: 0.75,
    distance: 0.75,
    expected: 0.5,
    physicalVisibility: 0,
  },
  {
    ...base,
    name: 'hard-comparison-not-production-default',
    parameter: 0.75,
    distance: 0.75,
    strength: 1,
  },
  // The +X target misses plane y=.25. Its nearest 4x4 hemisphere direction is
  // phi=pi/4,z=.125 and hits that plane. No exact-visibility claim is made.
  {
    ...base,
    name: 'off-ray-plane-false-occlusion',
    parameter: 0.25 / (Math.sqrt(1 - 0.125 ** 2) * Math.SQRT1_2),
    distance: 0.25 / (Math.sqrt(1 - 0.125 ** 2) * Math.SQRT1_2),
    physicalVisibility: 1,
  },
  {
    ...base,
    name: 'normal-bias-endpoint-distance',
    offset: [0, 0, 0.25],
    parameter: 0.5,
    distance: Math.sqrt(5) / 4,
    expected: (Math.sqrt(5) / 4 - 0.5) * 2,
  },
  // Expected bin is the original trace sequence index, not the inverse map.
  ...[
    [0, 0, 1],
    [0, 1, 0],
    [1 / Math.sqrt(14), 2 / Math.sqrt(14), 3 / Math.sqrt(14)],
  ].flatMap((normal, axis) =>
    Array.from(
      { length: 16 },
      (_, bin): CardVisibilityCase => ({
        ...base,
        name: `trace-bin-roundtrip-${axis}-${bin}`,
        normal,
        parameter: 0.5 + (bin + 1) / 64,
        distance: 0.5 + (bin + 1) / 64,
        expected: (bin + 1) / 32,
        expectedRay: bin,
        stratified: true,
      }),
    ),
  ),
];

export function packCardVisibilityCases(cases: readonly CardVisibilityCase[]) {
  const bytes = new Uint8Array(cases.length * 112),
    view = new DataView(bytes.buffer);
  cases.forEach((row, i) => {
    const at = i * 112;
    for (const [slot, words] of [
      row.origin,
      row.normal,
      row.target,
      row.direction,
      row.offset,
    ].entries())
      words.forEach((word, axis) => {
        view.setFloat32(at + slot * 16 + axis * 4, word, true);
      });
    view.setFloat32(at + 60, row.parameter, true);
    [row.distance, row.available, row.strength, 2].forEach((word, axis) => {
      view.setFloat32(at + 80 + axis * 4, word, true);
    });
    view.setUint32(at + 96, 16, true);
    view.setUint32(at + 100, row.status, true);
    view.setUint32(at + 104, row.tag ?? 0, true);
    view.setFloat32(at + 28, row.expectedRay, true);
    view.setUint32(at + 108, row.stratified ? 1 : 0, true);
  });
  return bytes;
}

export function packCardVisibilityDistances(cases: readonly CardVisibilityCase[]) {
  return Float32Array.from(
    cases.flatMap(() => Array.from({ length: 16 }, (_, bin) => 0.5 + (bin + 1) / 64)),
  );
}

export const cardVisibilityFixture = `${CARD_RADIOSITY_VISIBILITY_WGSL}
struct CardVisibilityCase { origin:vec4f, normal:vec4f, receiver:vec4f, ray:vec4f, offset:vec4f, trace:vec4f, control:vec4u }
@group(0) @binding(0) var<storage,read> inputs:array<CardVisibilityCase>;
@group(0) @binding(1) var<storage,read_write> results:array<vec4f>;
@group(0) @binding(2) var<storage,read> distances:array<f32>;
@compute @workgroup_size(64) fn auditCardProbeVisibility(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=arrayLength(&inputs)){return;}let value=inputs[i];
 var receiver=value.receiver.xyz;var direction=value.ray.xyz;
 if(value.control.w==1u){direction=cardProbeTraceDirection(value.normal.xyz,u32(value.normal.w),value.control.x);receiver=value.origin.xyz+direction;}
 let sample=cardProbeVisibilitySample(value.origin.xyz,value.normal.xyz,receiver,value.control.x);
 var tag=cardProbeTransportTag(value.control.y,value.trace.y);if(value.control.z!=0u){tag=f32(value.control.z);}
 var hitDistance=value.trace.x;if(value.control.w==1u){hitDistance=distances[i*16u+sample.ray];}
 let visibility=cardProbeVisibilityWeight(sample.distance,hitDistance,tag,value.trace.z);
 let distance=cardRadiosityTraceDistance(value.control.y,value.ray.w,value.trace.w,value.offset.xyz,direction);
 results[i*2u]=vec4f(visibility.weight,select(0.0,1.0,value.trace.y==1.0),f32(sample.ray),f32(sample.valid));
 results[i*2u+1u]=vec4f(sample.distance,distance.distance,f32(distance.valid),f32(visibility.available));
}`;
