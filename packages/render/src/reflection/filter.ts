export interface ProbeFilterState {
  readonly probeIndex: number;
  readonly faceCount: number;
  readonly mipCount: number;
  readonly cursor: number;
  readonly activeGeneration: number;
}

export function createProbeFilterState(input: {
  readonly probeIndex: number;
  readonly faceCount?: number;
  readonly mipCount: number;
  readonly activeGeneration?: number;
}): ProbeFilterState {
  return {
    probeIndex: input.probeIndex,
    faceCount: input.faceCount ?? 6,
    mipCount: input.mipCount,
    cursor: 0,
    activeGeneration: input.activeGeneration ?? 0,
  };
}

export function advanceProbeFilter(
  state: ProbeFilterState,
):
  | { readonly probeIndex: number; readonly faceIndex: number; readonly mipLevel: number }
  | undefined {
  const total = state.faceCount * state.mipCount;
  if (state.cursor >= total) return undefined;
  return {
    probeIndex: state.probeIndex,
    faceIndex: state.cursor % state.faceCount,
    mipLevel: Math.floor(state.cursor / state.faceCount),
  };
}

export function commitProbeFilterStep(state: ProbeFilterState, success: boolean): ProbeFilterState {
  if (!success) return state;
  const nextCursor = state.cursor + 1;
  const complete = nextCursor >= state.faceCount * state.mipCount;
  return {
    ...state,
    cursor: nextCursor,
    activeGeneration: complete ? state.activeGeneration + 1 : state.activeGeneration,
  };
}

export function probeFilterIsSteady(state: ProbeFilterState): boolean {
  return state.cursor >= state.faceCount * state.mipCount;
}

function normalize(vector: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length === 0) return [0, 0, 1];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function boxProjectReflectionDirection(
  direction: readonly [number, number, number],
  boxCenter: readonly [number, number, number],
  halfExtents: readonly [number, number, number],
  point: readonly [number, number, number],
): [number, number, number] {
  const ray = normalize(direction);
  for (const axis of [0, 1, 2] as const) {
    if (Math.abs(point[axis] - boxCenter[axis]) >= halfExtents[axis]) return ray;
  }
  let distance = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 3; axis += 1) {
    const component = ray[axis] ?? 0;
    if (component === 0) continue;
    const extent = halfExtents[axis] ?? 0;
    const edge = component > 0 ? (boxCenter[axis] ?? 0) + extent : (boxCenter[axis] ?? 0) - extent;
    const candidate = (edge - (point[axis] ?? 0)) / component;
    if (candidate > 0) distance = Math.min(distance, candidate);
  }
  if (!Number.isFinite(distance)) return ray;
  return normalize([
    (point[0] ?? 0) + ray[0] * distance - (boxCenter[0] ?? 0),
    (point[1] ?? 0) + ray[1] * distance - (boxCenter[1] ?? 0),
    (point[2] ?? 0) + ray[2] * distance - (boxCenter[2] ?? 0),
  ]);
}
