import { executable, rootVector } from '../../../../shader/src/__tests__/sdf-surface-root.fixture';
import { sdfSurfaceCandidatesWgsl } from '../../../../shader/src/sdf-surface-candidates-wgsl';
import { SCREEN_PROBE_DF_RECEIVER_WGSL } from '../../raytracing/screen-probe-df-receiver';

/** Executes actual integer/branch control. Slab/geometry are explicit callbacks,
 * not a CPU emulation of WGSL interval arithmetic or a GPU qualification. */
export function softwareDfReceiverControl(
  input: {
    readonly ready?: boolean;
    readonly stale?: boolean;
    readonly opaque?: boolean;
    readonly associated?: boolean;
    readonly directory?: boolean;
  } = {},
) {
  const expected = rootVector(36864, 4194304, 1, 3);
  const probe = {
    receiverControl: rootVector(Number(input.ready !== false), 9, 1, 7),
    receiverExpected: rootVector(36864, 4194304, 1, input.stale ? 2 : 3),
    pixel: 32,
    receiverRow: 0,
    receiverPrimitive: 17,
  };
  return executable<{ row: number; primitive: number; valid: number }>(
    SCREEN_PROBE_DF_RECEIVER_WGSL,
    'screenProbeDfReceiver',
    'probe',
    {
      different: (a: typeof expected, b: typeof expected) =>
        a.x !== b.x || a.y !== b.y || a.z !== b.z || a.w !== b.w,
      SdfMeshDfReceiver: (row: number, primitive: number, valid: number) => ({
        row,
        primitive,
        valid,
      }),
      probeFrame: {
        probes: rootVector(0, 0, 0, 9),
        query: rootVector(0, 0, 7),
        expectedSource: expected,
      },
      grid: { source: expected },
      sdfInstanceValid: () => true,
      sdfInstanceMask: () => 255,
      sdfSurfaceRowAssociated: () => input.associated !== false,
      sdfSurfacePacket: () => ({ valid: 1, triangles: { y: 262267 } }),
      sdfSurfacePrimitiveOpaque: () => input.opaque !== false,
      sdfSurfaceExpectedDirectory: () => ({ valid: Number(input.directory !== false) }),
    },
  )(probe);
}

export function softwareDfCandidateControl(input: {
  readonly budget: number;
  readonly live?: number;
  readonly capacity?: number;
  readonly culled?: boolean;
  readonly stale?: boolean;
  readonly malformed?: boolean;
}) {
  const live = input.live ?? 3,
    capacity = input.capacity ?? 1024;
  const remaining = { value: input.budget },
    work = { value: 0 };
  let rawRows = 0,
    rawNodes = 0;
  const source = sdfSurfaceCandidatesWgsl(true)
    .replaceAll('var out:SdfSurfaceCandidates;', 'var out=empty();')
    .replaceAll('(*work)++', 'work.value++')
    .replace('loop {', 'while(true){');
  const empty = () => ({ state: 0, rows: Array<number>(32).fill(0), nodeVisits: 0 });
  const a = { x: 10, y: 0, z: 0, w: 0x40000000, xyz: rootVector(10, 0, 0) };
  const b = { x: 11, y: 1, z: 1, w: 5, xyz: rootVector(11, 1, 1) };
  const result = executable<ReturnType<typeof empty>>(
    source,
    'sdfSurfaceSceneCandidates',
    'world,rowLimit,mask,actualSource,expectedSource,remaining,work',
    {
      empty,
      different: () => input.stale === true,
      sdfInstanceRowCount: () => capacity,
      sdfSurfaceExpectedDirectory: () => ({
        valid: Number(live <= capacity),
        indexed: 1,
        first: 0,
        nodes: 5,
        rowLimit: live,
      }),
      sdfSurfaceRayUsable: () => true,
      sdfSurfaceCandidatesUnknown: (visits: number) => ({
        ...empty(),
        state: 2,
        nodeVisits: visits,
      }),
      sdfSurfaceCharge: (bank: typeof remaining) => bank.value > 0 && --bank.value >= 0,
      sdfInstanceMask: () => {
        rawRows++;
        return 255;
      },
      sdfInstanceValid: () => true,
      sdfSurfacePoolVector: (address: number) => {
        rawNodes += Number(address % 8 === 0);
        return address % 8 === 0 ? a : b;
      },
      sdfSurfaceCandidateBoxValid: () => input.malformed !== true,
      sdfSurfaceCandidateLeafValid: () => true,
      sdfSurfaceCandidateChildrenValid: () => true,
      sdfSurfaceSlab: () => ({ certified: 1, possible: Number(input.culled === false) }),
    },
  )({}, live, 255, {}, {}, remaining, work);
  return { result, remaining: remaining.value, work: work.value, rawRows, rawNodes };
}
