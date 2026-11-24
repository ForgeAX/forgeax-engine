import source from '../../../../shader/src/ray-screen-probe.wgsl?raw';
import { SCREEN_PROBE_RECONSTRUCTION_WGSL } from '../../../../shader/src/screen-probe-reconstruction';

type V3 = readonly [number, number, number];
export interface PlanPacket {
  samples: { x: number; y: number }[];
  support: number;
  hitDistance?: number;
}
export const POLICY_CULL_SUPPORT = -3;
export interface PlanReceiver {
  normal: V3;
  pixel: number;
  receiverExpected: readonly number[];
  receiverControl: readonly number[];
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function body(name: string, text = source): string | undefined {
  const at = text.indexOf(`fn ${name}(`);
  if (at < 0) return undefined;
  const start = text.indexOf('{', at);
  let end = start + 1;
  let depth = 1;
  for (; depth; end++) {
    if (end >= text.length) throw Error('Unclosed production function');
    if (text[end] === '{') depth++;
    if (text[end] === '}') depth--;
  }
  return text.slice(start + 1, end - 1);
}
function execute<T>(text: string, args: string, dependencies: Record<string, unknown>): T {
  const code = text
    .replace(/\blet\b/g, 'const')
    .replace(/\bvar\b/g, 'let')
    .replace(/\b(0x[\da-f]+|\d+)u\b/g, '$1')
    .replace(/0x1p-16/g, '(2 ** -16)')
    .replace(/0x1p-122/g, '(2 ** -122)');
  return Function(
    ...Object.keys(dependencies),
    `return function(${args}){${code}}`,
  )(...Object.values(dependencies)) as T;
}
function mayContribute(texel: number, n: V3) {
  for (let c = 0; c < 4; c++) {
    const x = ((texel % 8) + (c & 1)) / 4 - 1;
    const y = (Math.floor(texel / 8) + (c >> 1)) / 4 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    const v: V3 =
      z < 0
        ? [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1), z]
        : [x, y, z];
    if (dot(n, v) > 0) return true;
  }
  return false;
}
export function plannedCull(
  receiver: PlanReceiver,
  texel: number,
  ready = true,
  brdf = true,
  context = { expected: [36864, 4194304, 1, 3], frame: 0, revision: 1 },
) {
  const code = body('probePolicyCull');
  if (code === undefined) return false; // Baseline executes its ordinary resolver, yielding the real red value.
  const sourceControl = body('spReconstructionSource', SCREEN_PROBE_RECONSTRUCTION_WGSL);
  if (sourceControl === undefined) throw Error('Missing source authority');
  const sourceReady = execute<
    (
      expected: number[],
      control: number[],
      frame: number,
      revision: number,
      source: number[],
      flags: number,
    ) => boolean
  >(
    sourceControl
      .replace(/all\((source|expected|control)==vec4u\(0u\)\)/g, '$1.every(v=>v===0)')
      .replace('all(expected==source)', 'expected.every((v,i)=>v===source[i])')
      .replace(
        /\b(source|expected|control)\.([xyzw])/g,
        (_match, name: string, axis: string) => `${name}[${'xyzw'.indexOf(axis)}]`,
      ),
    'expected,control,frame,revision,source,flags',
    { SP_CURRENT_SUPPORT_MASK: 8 },
  );
  return execute<(probe: number, texel: number) => boolean>(
    code.replace(
      'all((bitcast<vec3u>(receiver.normal)&vec3u(0x7fffffffu))<vec3u(0x40000000u))',
      'receiver.normal.every(v=>Math.abs(v)<2.0)',
    ),
    'probe,texel',
    {
      probeFrame: {
        control: { x: brdf ? 1 : 0, z: 8 },
        probes: { w: context.frame },
        query: { z: context.revision },
        expectedSource: context.expected,
      },
      probesIn: [receiver],
      probeLive: () => ready,
      spReconstructionSource: sourceReady,
      probeCellMayContribute: mayContribute,
      dot,
    },
  )(0, texel);
}
export function policyCullPacket(texel: number): PlanPacket {
  const code = body('distributionPolicyCull');
  if (code === undefined)
    return {
      samples: Array.from({ length: 4 }, () => ({ x: 0, y: 0 })),
      support: 0,
      hitDistance: -1,
    };
  return execute<(texel: number) => PlanPacket>(
    code.replace('var p:ProbeRadiance;', 'var p=empty();'),
    'texel',
    {
      SUPPORT_POLICY_CULL: POLICY_CULL_SUPPORT,
      empty: () => ({
        samples: Array.from({ length: 4 }, () => ({ x: 0, y: 0 })),
        support: 0,
        hitDistance: 0,
      }),
    },
  )(texel);
}
export function isPolicyCull(packet: PlanPacket, texel: number) {
  const code = body('distributionIsPolicyCull');
  return code === undefined
    ? false
    : execute<(p: PlanPacket, texel: number) => boolean>(code, 'p,texel', {
        SUPPORT_POLICY_CULL: POLICY_CULL_SUPPORT,
      })(packet, texel);
}
export function projectedCullBound(texel: number, normal: V3) {
  const code = body('probePolicyCullProjectedBound');
  if (code === undefined) return 0;
  return execute<(texel: number, n: V3) => number>(
    code
      .replaceAll('normal.x', 'normal[0]')
      .replaceAll('normal.y', 'normal[1]')
      .replaceAll('normal.z', 'normal[2]')
      .replace(
        'all((bitcast<vec3u>(normal)&vec3u(0x7fffffffu))<vec3u(0x40000000u))',
        'normal.every(v=>Math.abs(v)<2.0)',
      )
      .replace('texel/8u', 'Math.floor(texel/8)')
      .replace('bitcast<f32>(bitcast<u32>(bound)+1u)', 'nextUp(bound)'),
    'texel,normal',
    {
      abs: Math.abs,
      max: Math.max,
      f32: Number,
      select: <T>(a: T, b: T, choose: boolean) => (choose ? b : a),
      nextUp: (value: number) => {
        const f = Float32Array.of(value),
          u = new Uint32Array(f.buffer);
        u[0] = (u[0] ?? 0) + 1;
        return f[0];
      },
    },
  )(texel, normal);
}

/** Executes the actual packet-copy exits; it does not emulate a scene query. */
export function carryPolicyCull(stage: 'temporal' | 'filter') {
  const packet = policyCullPacket(29),
    radianceOut: PlanPacket[] = [];
  const probeHistoryOut = [{ radiance: Array<PlanPacket>(64) }];
  const text = body(stage === 'temporal' ? 'accumulateProbeHistory' : 'filterProbeRadiance');
  if (text === undefined) throw Error('Missing existing producer');
  const anchor =
    stage === 'temporal'
      ? 'if(distributionIsPolicyCull(currentRecord,texel))'
      : 'if (probe >= probeFrame.probes.x ||';
  const at = text.indexOf(anchor);
  if (at < 0) return { packet, radiance: undefined, history: undefined };
  const end = text.indexOf('}', at) + 1;
  const start = stage === 'filter' ? text.lastIndexOf('let empty =', at) : at;
  if (start < 0) throw Error('Missing spatial support classification');
  execute<() => void>(text.slice(start, end), '', {
    SUPPORT_SCATTER_EMPTY: -4,
    SUPPORT_SPATIAL_ESTIMATE: 0.5,
    currentRecord: packet,
    centerRecord: packet,
    center: { w: packet.support },
    distributionIsPolicyCull: isPolicyCull,
    radianceOut,
    probeHistoryOut,
    index: 0,
    probe: 0,
    texel: 29,
    probeFrame: { probes: { x: 1 } },
    probeLive: () => true,
    probeRadianceMeasure: () => 0,
  })();
  return { packet, radiance: radianceOut[0], history: probeHistoryOut[0]?.radiance[29] };
}
