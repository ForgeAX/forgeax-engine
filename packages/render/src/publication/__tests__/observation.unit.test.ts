import { afterEach, expect, it, vi } from 'vitest';
import {
  beginSourcePreparation,
  SOURCE_PREPARATION_PROTOCOL,
  type SourcePreparationControl,
} from '../observation';

const root = globalThis as typeof globalThis & {
  __forgeaxFramePhaseDiagnostics?: { sourcePreparation?: SourcePreparationControl };
};
function arm(maxAttempts = 2) {
  const control: SourcePreparationControl = {
    protocol: SOURCE_PREPARATION_PROTOCOL,
    enabled: true,
    token: 'test',
    build: 'a'.repeat(40),
    worldIdentity: 'world',
    maxAttempts,
    attempts: 0,
    skipped: 0,
    dropped: 0,
    failures: 0,
    probeWallMs: 0,
    observerWallMs: 0,
    clockCalls: 0,
    clockFailures: 0,
    cancelled: false,
    finalizationWallMs: 0,
    outcomes: { accepted: 0, discarded: 0, 'prepare-error': 0, retired: 0 },
  };
  root.__forgeaxFramePhaseDiagnostics = { sourcePreparation: control };
  return control;
}
const begin = () => beginSourcePreparation({ identity: 'world' }, 'source', 3, 7, 19, false);
function requiredBegin() {
  const tx = begin();
  if (!tx) throw Error('Expected observation');
  return tx;
}
type Receipt = {
  status: string;
  rows: {
    handle: number;
    runtime: boolean;
    verticesBytes: number | null;
    indicesBytes: number | null;
  }[];
  omitted: number;
  phases: Record<string, number>;
  observer: { wallMs: number };
  beginMs: number;
  endMs: number;
};
afterEach(() => {
  delete root.__forgeaxFramePhaseDiagnostics;
  vi.restoreAllMocks();
});
it('does no clocks or World identity reads when absent/disabled', () => {
  const now = vi.spyOn(performance, 'now');
  const world = {
    get identity(): string {
      throw Error('extra World read');
    },
  };
  expect(beginSourcePreparation(world, 'source', 1, 2, undefined, false)).toBeUndefined();
  arm().enabled = false;
  expect(beginSourcePreparation(world, 'source', 1, 2, undefined, false)).toBeUndefined();
  expect(now).not.toHaveBeenCalled();
});
it('bounds probes and captures only one actual runtime mesh mutation', () => {
  const c = arm();
  const first = requiredBegin();
  first.finish('accepted');
  expect(c.result).toBeUndefined();
  const tx = requiredBegin();
  tx.fact('pendingMeshContent', 1);
  tx.phase('extract');
  tx.phase('feature');
  tx.phase('clone');
  tx.mesh(2, true, { vertices: new Float32Array(3), indices: new Uint16Array(2) });
  tx.phase('send');
  tx.phase('accept');
  tx.finish('accepted');
  const result = c.result as Receipt;
  expect(result).toMatchObject({
    status: 'accepted',
    frameId: 19,
    source: 'source',
    epoch: 3,
    revision: 7,
    runtimeMeshes: 1,
  });
  expect(result.rows[0]).toEqual({ handle: 2, runtime: true, verticesBytes: 12, indicesBytes: 4 });
  expect(c.skipped).toBe(1);
  expect(c.enabled).toBe(false);
  expect(begin()).toBeUndefined();
  expect(
    Object.values(result.phases).reduce((a: number, b: number) => a + b, 0) +
      result.observer.wallMs,
  ).toBeCloseTo(result.endMs - result.beginMs, 4);
});
it('keeps row omissions, cancellation/retirement and clock failure explicit', () => {
  const c = arm();
  const tx = requiredBegin();
  tx.count('mesh-filter-write');
  const clone = {
    get vertices() {
      throw Error('not observed');
    },
  };
  for (let i = 0; i < 80; i++) tx.mesh(i, true, clone);
  c.cancelled = true;
  tx.finish('retired');
  const r = c.result as Receipt;
  expect(r.status).toBe('cancelled');
  expect(r.rows).toHaveLength(64);
  expect(r.omitted).toBe(16);
  expect(r.rows[0]?.verticesBytes).toBeNull();
});
it('does not throw for a failing clock or frozen collector', () => {
  const c = arm();
  vi.spyOn(performance, 'now').mockImplementation(() => {
    throw Error('clock');
  });
  const tx = requiredBegin();
  tx.fact('runtimeNewMesh', true);
  tx.mesh(1, true, {});
  Object.freeze(c);
  expect(() => tx.finish('discarded')).not.toThrow();
});
it('stops at the explicit attempt budget without manufacturing a zero-work receipt', () => {
  const c = arm(1);
  requiredBegin().finish('accepted');
  expect(begin()).toBeUndefined();
  expect(c.dropped).toBe(1);
  expect(c.result).toBeUndefined();
});

it('keeps an explicit unavailable receipt when bounded metadata would exceed the byte cap', () => {
  const c = arm();
  c.build = 'x'.repeat(20000);
  const tx = requiredBegin();
  tx.fact('runtimeNewMesh', true);
  tx.mesh(1, true, {});
  tx.finish('accepted');
  expect(c.result).toMatchObject({ status: 'unavailable', reason: 'byte-budget', maxBytes: 16384 });
});
