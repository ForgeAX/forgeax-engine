import { executable, rootVector } from '../../../../shader/src/__tests__/sdf-surface-root.fixture';
import { SDF_MESH_DF_APPROX_WGSL } from '../../../../shader/src/sdf-mesh-df-approx-wgsl';
import {
  type MeshDfApproxPolicy,
  WORLD_CARD_RADIANCE_WGSL,
  worldTraversalWgsl,
} from '../../raytracing/world-traversal';

export const meshDfPolicy: MeshDfApproxPolicy = {
  receiverBiasVoxels: 1,
  expansionVoxels: 0.5,
  maxErrorVoxels: 16,
};

function functionBody(source: string, name: string) {
  const start = source.indexOf(`fn ${name}(`);
  if (start < 0) throw Error(`Actual factory lacks ${name}`);
  const begin = source.indexOf('{', start);
  let depth = 1;
  let end = begin + 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw Error('Unclosed actual function');
  return source.slice(begin + 1, end - 1);
}

type FixtureVector = ReturnType<typeof rootVector> & {
  readonly xyz: ReturnType<typeof rootVector>;
};

const vector = (...values: number[]): FixtureVector => {
  const out = rootVector(...values);
  return Object.assign(out, values, { xyz: rootVector(...values.slice(0, 3)) });
};
const hit = (status = 1, flags = 0x60000000, error = 0.5) => ({
  state: vector(status, flags, 0, 7),
  metrics: vector(2, error, 0, 1),
  position: vector(0, 0, 2, 1),
  normal: vector(0, 0, 1, 0),
});

/** Actual row-entry control up to shifted-ray construction. Source qualification
 * and vector dimensions are explicit fixture inputs, not emulated GPU math.
 * The sentinel return stops before sampling; any exact call before it is real
 * production control flow. A failed refinement deliberately consumes the bank.
 */
export function meshDfReceiverEntryControl(ready = true) {
  const body = functionBody(SDF_MESH_DF_APPROX_WGSL, 'sdfMeshDfRow');
  const stop = body.indexOf('let shift=');
  if (stop < 0) throw Error('Actual shifted-ray entry absent');
  const prefix = body.slice(0, stop).replace('any(m.field.yzw<vec3u(2u))', 'false');
  const bank = { value: 3 };
  let exactCalls = 0;
  const result = executable<ReturnType<typeof hit>>(
    `fn actual(){${prefix}return sdfMeshDfUnknown(ray.tMin);}`,
    'actual',
    'row,ray,world,remaining,contact,offset,bias,receiverVoxel,policy',
    {
      sdfMeshDfUnknown: () => hit(4, 0x20000000),
      sdfSurfacePacket: () => ({ valid: Number(ready), prefixEligible: 1 }),
      sdfInstanceAt: () => ({ error: { w: 2 }, field: { yzw: vector(4, 4, 4) } }),
      sdfSurfaceRowAssociated: () => ready,
      sdfMeshDfScale: () => 1,
      length: () => 1,
      sdfMeshDfFinite: Number.isFinite,
      min: Math.min,
      sdfMeshDfRefine: () => {
        exactCalls++;
        bank.value = 0;
        return { state: 3 };
      },
      sdfMeshDfFromExact: () => hit(),
    },
  )(0, { tMin: 0, tMax: 8, direction: vector(0, 0, 1) }, {}, bank, {}, {}, 1, 1, {});
  return { exactCalls, remaining: bank.value, result };
}

/** Executes the actual reserve authority; no independent counter algorithm. */
export function meshDfBudgetControl(initial: number, costs: readonly number[]) {
  const remaining = { value: initial };
  const reserve = executable<boolean>(
    SDF_MESH_DF_APPROX_WGSL,
    'sdfMeshDfReserve',
    'remaining,cost',
    {},
  );
  const accepted = costs.map((cost) => reserve(remaining, cost));
  return { accepted, remaining: remaining.value };
}

/** Executes actual factory wrapper/Card control only. Sampled geometry, source
 * checks and exact traversal are independent callbacks, not GPU math emulation.
 * The typed lowering retains function-local pointer aliases and bit encodings.
 */
export function meshDfFactoryControl(
  input: {
    readonly approximate?: boolean;
    readonly sourceReady?: boolean;
    readonly rayValid?: boolean;
    readonly steps?: number;
    readonly first?: number;
    readonly last?: number;
    readonly directionLength?: number;
    readonly mask?: number;
    readonly source?: string;
    readonly nearDistance?: number;
    readonly nearStatus?: number;
    readonly farStatus?: number;
  } = {},
) {
  const calls = { exact: 0, approximate: 0 };
  const nearWindows: number[][] = [];
  const farWindows: number[][] = [];
  const source =
    input.source ??
    worldTraversalWgsl(
      'global-sdf',
      false,
      false,
      false,
      input.approximate === false
        ? undefined
        : input.nearDistance === undefined
          ? meshDfPolicy
          : { ...meshDfPolicy, nearDistance: input.nearDistance },
    );
  const body = functionBody(source, 'traceWorld')
    .replaceAll('bitcast<vec3u>(', 'bits3(')
    .replaceAll('bitcast<vec2u>(vec2f(', 'bits2(vec2f(')
    .replace('var remaining=maxSteps;', 'var remaining=bank(maxSteps);')
    .replace('var nearRay=ray;', 'var nearRay=copy(ray);')
    .replace('var farRay=ray;', 'var farRay=copy(ray);')
    .replace('var nearWorld=world;', 'var nearWorld=copy(world);')
    .replaceAll('&remaining', 'remaining')
    .replaceAll('&candidates', 'candidates')
    .replace('remaining-=farHit.state.z;', 'remaining.value-=farHit.state.z;')
    .replace('traceGlobal(farRay,remaining,', 'traceGlobal(farRay,remaining.value,')
    .replaceAll('maxSteps-remaining', 'maxSteps-remaining.value');
  const result = executable<ReturnType<typeof hit>>(
    `fn actual(){${body}}`,
    'actual',
    'ray,maxSteps,minStepFactor',
    {
      bank: (value: number) => ({ value }),
      bits3: (value: unknown) => value,
      bits2: (value: unknown) => value,
      rootBits: (value: number) => value,
      copy: structuredClone,
      min: Math.min,
      max: Math.max,
      length: () => input.directionLength ?? 1,
      sdfMeshDfFinite: Number.isFinite,
      vec2f: vector,
      vec4f: vector,
      vec4u: vector,
      SdfSurfaceRay: (...words: unknown[]) => ({ tRange: words[4] }),
      Hit: (
        state: ReturnType<typeof vector>,
        metrics: ReturnType<typeof vector>,
        position: ReturnType<typeof vector>,
        normal: ReturnType<typeof vector>,
      ) => ({ state, metrics, position, normal }),
      sdfSurfaceRayUsable: () => input.rayValid !== false,
      worldBoundsValid: () => input.sourceReady !== false,
      sdfSceneObservedRayUsable: () => input.rayValid !== false,
      sdfMeshDfUnknown: (first: number) => ({
        ...hit(4, 0x20000000),
        metrics: vector(first, 0, 0, 0),
      }),
      SdfMeshDfPolicy: (...values: number[]) => values,
      sdfMeshDfCost: vector(0, 0, 0, 0),
      sdfMeshDfWorld: (
        ray: { tMin: number; tMax: number },
        _world: unknown,
        bank: { value: number },
      ) => {
        calls.approximate++;
        nearWindows.push([ray.tMin, ray.tMax, bank.value]);
        if (bank.value === 0) return hit(3, 0x20000000);
        bank.value--;
        return hit(input.nearStatus);
      },
      traceGlobal: (ray: { tMin: number; tMax: number }, budget: number) => {
        farWindows.push([ray.tMin, ray.tMax, budget]);
        const value = hit(budget < 8 ? 3 : input.farStatus, 0);
        value.state.z = budget < 8 ? 0 : 8;
        return value;
      },
      SdfSurfaceContact: (...values: number[]) => values,
      SdfMeshDfReceiver: (...values: number[]) => values,
      grid: {
        dimensionsCount: vector(2, 2, 2, 1),
        source: vector(36, 128, 1, 7),
        originSpacing: vector(0, 0, 0, 0.25),
      },
      worldSceneExpected: () => vector(36, 128, 1, 7),
      sdfSurfaceSceneCandidates: () => ({ state: 0 }),
      sdfSceneSurfaceTraceRows: () => {
        calls.exact++;
        return { state: 0 };
      },
      sdfSceneSurfaceHit: () => hit(0, 0),
    },
  )(
    {
      origin: vector(0, 0, 0),
      direction: vector(0, 0, input.directionLength ?? 1),
      tMin: input.first ?? 0,
      tMax: input.last ?? 8,
      mask: vector(input.mask ?? 255),
    },
    input.steps ?? 64,
    0,
  );
  return { result, calls, nearWindows, farWindows };
}

export function meshDfCardControl(flags = 0x60000000, uncertainty = 0.5, margin = 0.1) {
  const source = worldTraversalWgsl('global-sdf', false, false, false, meshDfPolicy);
  const candidates = executable<{
    state: ReturnType<typeof vector>;
    ids: ReturnType<typeof vector>;
  }>(source, 'worldHitCandidates', 'hit', {
    vec4u: vector,
    Candidates: (state: ReturnType<typeof vector>, ids: ReturnType<typeof vector>) => ({
      state,
      ids,
    }),
    findCandidates: () => ({ state: vector(0, 0, 0, 0), ids: vector(0xffffffff) }),
    SdfHit: (...values: unknown[]) => values,
  });
  const backface = executable<boolean>(WORLD_CARD_RADIANCE_WGSL, 'worldHitBackface', 'hit,ray', {
    WORLD_HIT_NORMAL_EXACT: false,
    dot: () => 1,
  });
  const observed: number[] = [];
  const sampled = executable<unknown>(
    WORLD_CARD_RADIANCE_WGSL.replaceAll('&cards', 'cards'),
    'worldCardRadiance',
    'hit,projectionMargin,pointSample,ray',
    {
      vec4f: vector,
      vec3f: vector,
      vec2i: vector,
      i32: Math.trunc,
      worldHitCandidates: candidates,
      worldCandidateOnRay: () => true,
      select: (a: unknown, b: unknown, p: boolean) => (p ? b : a),
      max: Math.max,
      min: Math.min,
      lookupCardPoint: (_p: unknown, _n: unknown, _id: unknown, value: number) => {
        observed.push(value);
        return { state: vector(2) };
      },
      textureDimensions: () => {
        throw Error('Unmapped Card must not read texture');
      },
      textureLoad: () => {
        throw Error('Unmapped Card must not read texture');
      },
      decodeCardNormal: () => {
        throw Error('Unmapped Card must not decode texture');
      },
      dot: () => 1,
      arrayLength: () => 0,
      firstOwnerCard: () => 0,
      settings: vector(0, 1, 0, 0),
      cards: [],
      cardLit: [],
      normal: [],
    },
  );
  const actual = hit(1, flags, uncertainty);
  sampled(actual, margin, true, {});
  return { candidate: candidates(actual), backface: backface(actual, {}), margins: observed };
}

/** Actual World -> Card authoring closure. No new runtime bindings. */
export function meshDfWorldKernel(receiver = true, prepared = false) {
  return `${worldTraversalWgsl('global-sdf', prepared, receiver, false, meshDfPolicy)}
${WORLD_CARD_RADIANCE_WGSL}
@group(1) @binding(0) var<storage,read> cards:array<Card>;
@group(1) @binding(1) var<storage,read> cardLit:array<vec4f>;
@group(1) @binding(2) var<uniform> settings:vec4u;
@group(1) @binding(3) var normal:texture_2d<f32>;
@group(1) @binding(4) var albedo:texture_2d<f32>;
@group(1) @binding(5) var emission:texture_2d<f32>;
@group(1) @binding(6) var f0:texture_2d<f32>;
@group(1) @binding(7) var cardDepth:texture_depth_2d;
@group(2) @binding(0) var<storage,read_write> result:array<vec4f>;
fn worldSceneExpected()->vec4u{return vec4u(36u,128u,1u,7u);}
@compute @workgroup_size(1) fn main(){
 let r=Ray(vec3f(0),0,vec3f(0,0,1),8,vec4u(255u));
 ${prepared ? 'let raw=SdfSurfaceRay(bitcast<vec3u>(r.origin),bitcast<vec3u>(r.origin),bitcast<vec3u>(r.direction),bitcast<vec3u>(r.direction),bitcast<vec2u>(vec2f(0,8)),1u);let request=sdfSurfaceRootRequestEmpty(raw,255u,64u,worldSceneExpected(),vec2u(0u));' : ''}
 let h=traceWorld(r,64u,0.0${prepared ? ',request,vec2u(0u)' : ''}${receiver ? ',bitcast<vec3u>(r.origin),bitcast<vec3u>(r.direction),SdfMeshDfReceiver(0xffffffffu,0xffffffffu,0u)' : ''});
 result[0]=worldCardRadiance(h,0.1,true,r);
}`;
}
