import { describe, expect, it, vi } from 'vitest';
import type { IblPrecomputeOutput } from '../ibl/IblPipelineCache';
import type { RenderSystemInternals } from '../record/render-context';
import { createProbeFilterState } from '../reflection/filter';
import type { ReflectionProbeFact } from '../reflection/projection';
import { ReflectionProbeRecordOwner } from '../reflection/record-owner';
import type { SkylightSnapshot } from '../render-system-extract';

// Tests exercise the existing owner without widening its production API.
type ProbeOwnerFixture = {
  resources: ReflectionProbeRecordOwner['resources'];
  resourceFor: ReflectionProbeRecordOwner['resourceFor'];
  completeSubmission: ReflectionProbeRecordOwner['completeSubmission'];
};

function fixture(intent: 'once' | 'on-change' | 'continuous') {
  const writes: Float32Array[] = [];
  const scope = { generation: 1 } as RenderSystemInternals['deviceScope'];
  const getCubemapIbl = vi.fn<() => IblPrecomputeOutput | undefined>(() => undefined);
  const owner = new ReflectionProbeRecordOwner({
    gpuStore: { getCubemapIbl },
    device: {
      caps: { rgba16floatRenderable: true },
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, payload: Float32Array) => {
          writes.push(new Float32Array(payload));
          return { ok: true };
        },
      },
    },
    deviceScope: scope,
  } as unknown as RenderSystemInternals) as unknown as ProbeOwnerFixture;
  const fact: ReflectionProbeFact = {
    worldId: 0,
    entityKey: 1,
    center: [0, 0, 0],
    halfExtents: [2, 2, 2],
    intensity: 1,
    priority: 0,
    resolution: 64,
    revision: 1,
    updateIntent: intent,
  };
  const resource = {
    fact,
    captureFact: fact,
    diffusePayload: [0, 0, 0, 0, 0, 0, 0, 1],
    captureSceneRevision: '1',
    index: 0,
    filter: {
      ...createProbeFilterState({ probeIndex: 0, mipCount: 5, activeGeneration: 1 }),
      cursor: 30,
    },
    rawFaceCursor: 6,
    raw: { size: 64, faceViews: new Array(6) },
    active: {},
    candidate: {},
    spare: undefined,
  } as unknown as NonNullable<ReturnType<(typeof owner)['resourceFor']>>;
  owner.resources.set('0:1', resource);
  return { owner, fact, resource, writes, scope, getCubemapIbl };
}

describe('ReflectionProbe real resource update ownership', () => {
  it.each([
    'continuous',
    'on-change',
  ] as const)('starts another bounded capture for %s', (intent) => {
    const { owner, fact, resource } = fixture(intent);
    owner.resourceFor('0:1', fact, 0, '2');
    expect(resource.rawFaceCursor).toBe(0);
    expect(resource.filter.cursor).toBe(0);
    expect(resource.filter.activeGeneration).toBe(1);
  });
  it('keeps once probes steady across ordinary scene changes', () => {
    const { owner, fact, resource } = fixture('once');
    owner.resourceFor('0:1', fact, 0, '2');
    expect(resource.rawFaceCursor).toBe(6);
    expect(resource.filter.cursor).toBe(30);
  });
  it('coalesces a changing scene without starving an in-progress capture', () => {
    const { owner, fact, resource } = fixture('on-change');
    resource.rawFaceCursor = 3;
    resource.filter = { ...resource.filter, cursor: 0 };
    owner.resourceFor('0:1', { ...fact, revision: 2 }, 0, '2');
    expect(resource.rawFaceCursor).toBe(3);
  });
  it('commits capture tickets even when no fallback MRT was requested', async () => {
    const { owner, resource } = fixture('once');
    resource.rawFaceCursor = 2;
    const pending = { rawCaptureFace: 2, step: undefined };
    resource.pending = pending;
    await owner.completeSubmission(
      true,
      new Map(),
      Promise.resolve(),
      undefined,
      false,
      [{ resource, pending }],
      1,
      37,
    );
    expect(resource.rawFaceCursor).toBe(3);
    expect(resource.pending).toBeUndefined();
  });
  it('failed submissions retry the same face', async () => {
    const { owner, resource } = fixture('once');
    resource.rawFaceCursor = 2;
    const pending = { rawCaptureFace: 2, step: undefined };
    resource.pending = pending;
    await owner.completeSubmission(
      false,
      new Map(),
      undefined,
      undefined,
      false,
      [{ resource, pending }],
      1,
      37,
    );
    expect(resource.rawFaceCursor).toBe(2);
    expect(resource.pending).toBeUndefined();
  });
  it('a stale completion cannot advance a replaced pending ticket', async () => {
    const { owner, resource } = fixture('once');
    resource.rawFaceCursor = 2;
    const old = { rawCaptureFace: 2, step: undefined };
    const current = { rawCaptureFace: 2, step: undefined };
    resource.pending = current;
    await owner.completeSubmission(
      true,
      new Map(),
      undefined,
      undefined,
      false,
      [{ resource, pending: old }],
      1,
      37,
    );
    expect(resource.rawFaceCursor).toBe(2);
    expect(resource.pending).toBe(current);
  });
});

describe('ReflectionProbe global diffuse availability', () => {
  const sky: SkylightSnapshot = {
    entityHandle: 123,
    equirectHandle: 456,
    color: [0.4, 0.6, 0.8],
    intensity: 2,
    rotation: [0, 0.6, 0, 0.8],
  };
  function ready(f: ReturnType<typeof fixture>) {
    const output = {
      irradianceView: {},
      prefilterView: {},
      brdfLutView: {},
    } as IblPrecomputeOutput;
    f.getCubemapIbl.mockReturnValue(output);
    return output;
  }
  function readPayload(f: { writes: Float32Array[] }) {
    const payload = f.writes.at(-1);
    if (payload === undefined) throw new Error('Expected probe uniform write');
    return [...payload];
  }
  function write(input: SkylightSnapshot | undefined, complete = false) {
    const f = fixture('once');
    if (complete) ready(f);
    f.owner.resourceFor('0:1', f.fact, 0, '1', input);
    return { ...f, payload: readPayload(f) };
  }
  it('preserves constant irradiance independently of a local reflection probe', () => {
    const { payload } = write({ ...sky, ambientIrradiance: [1, 2, 3] });
    expect(payload.slice(8, 11)).toEqual([0, 0, 0]);
    expect(payload.slice(16)).toEqual([1, 2, 3, 0]);
  });
  it('keeps explicit unavailable image diffuse zero without removing local probe specular', () => {
    const { payload } = write(sky);
    expect(payload).toHaveLength(20);
    expect(payload[0]).toBe(-2);
    expect(payload.slice(1, 8)).toEqual([0, 0, 0, 2, 2, 2, 0]);
    expect(payload.slice(8, 11)).toEqual([0, 0, 0]);
    expect(payload[11]).toBe(1);
    expect(payload.slice(12, 16)).toEqual([...new Float32Array(sky.rotation)]);
  });
  it('retains ready image diffuse and authored rotation', () => {
    const { payload } = write(sky, true);
    expect(payload.slice(8, 11)).toEqual([...new Float32Array([0.8, 1.2, 1.6])]);
    expect(payload.slice(12, 16)).toEqual([...new Float32Array(sky.rotation)]);
  });
  it('retains explicit solid-color ambient without an image or cache', () => {
    expect(write({ ...sky, equirectHandle: 0 }).payload.slice(8, 11)).toEqual([
      ...new Float32Array([0.8, 1.2, 1.6]),
    ]);
  });
  it('retains no-Skylight zero diffuse', () => {
    expect(write(undefined).payload.slice(8, 16)).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
  });
  it('rewrites the same resource through unavailable-ready-unavailable transitions', () => {
    const f = fixture('once');
    const first = f.owner.resourceFor('0:1', f.fact, 0, '1', sky);
    expect(readPayload(f).slice(8, 11)).toEqual([0, 0, 0]);
    ready(f);
    expect(f.owner.resourceFor('0:1', f.fact, 0, '1', sky)).toBe(first);
    expect(readPayload(f).slice(8, 11)).toEqual([...new Float32Array([0.8, 1.2, 1.6])]);
    f.getCubemapIbl.mockReturnValue(undefined);
    expect(f.owner.resourceFor('0:1', f.fact, 0, '1', sky)).toBe(first);
    expect(readPayload(f).slice(8, 11)).toEqual([0, 0, 0]);
    expect(f.writes).toHaveLength(3);
  });
});
