import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { createMaterialShaderProgram } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { assembleStandardPbrArtifact } from '../assembly/material/assembly';
import type { GpuBuffer } from '../gpu-resource';
import {
  buildBindGroupLayoutDescriptor,
  buildGpuDrivenPbrInstancesBindGroupLayout,
  buildGpuDrivenPbrSkinPipelineLayout,
  buildPbrPipelineLayouts,
  buildPbrSkinLayouts,
  buildPbrViewBglEntries,
} from '../pbr-pipeline';
import type { RenderFrameState } from '../record/frame-snapshot';
import {
  resolveGeometryInstancesBindGroup,
  resolveProbeBlendBuffer,
} from '../record/main-pass-geometry';
import { ensureProbeBlendRecordBuffer } from '../record/probe-blend-buffer';
import type { ProbeBlendBufferProjection } from '../scene/probe-blend';
import type { ProbeBlendRecord } from '../scene/probe-blend-record';
import { PROBE_BLEND_RECORD_STRIDE, probeBlendRecordOffset } from '../scene/probe-blend-record';

describe('ProbeBlendRecord renderer lane', () => {
  it('does not retain a probe binding decision after replacing the published source', () => {
    const probeSource = '@group(3) @binding(1) var<storage, read> probes: array<vec4<f32>>;';
    const ordinarySource = '@group(3) @binding(1) var<storage, read> visible: array<vec2<u32>>;';
    const probe = assembleStandardPbrArtifact(
      'forgeax::default-standard-pbr',
      createMaterialShaderProgram(probeSource),
    );
    const ordinary = assembleStandardPbrArtifact(
      'forgeax::default-standard-pbr',
      createMaterialShaderProgram(ordinarySource),
    );
    if (probe === undefined || ordinary === undefined) throw new Error('missing test artifacts');
    expect(
      requiresProbeBlendRecord({ ...probe, program: createMaterialShaderProgram(ordinarySource) }),
    ).toBe(false);
    expect(
      requiresProbeBlendRecord({ ...ordinary, program: createMaterialShaderProgram(probeSource) }),
    ).toBe(true);
  });

  it('carries the selected shader ABI on the published artifact', () => {
    const probeSource = '@group(3) @binding(1) var<storage, read> probes: array<vec4<f32>>;';
    const ordinarySource = '@group(3) @binding(1) var<storage, read> visible: array<vec2<u32>>;';
    const probe = assembleStandardPbrArtifact(
      'forgeax::default-standard-pbr',
      createMaterialShaderProgram(probeSource),
    );
    const ordinary = assembleStandardPbrArtifact(
      'forgeax::default-standard-pbr',
      createMaterialShaderProgram(ordinarySource),
    );
    expect(probe?.program.probeBlendRecordRequired).toBe(true);
    expect(ordinary?.program.probeBlendRecordRequired).toBe(false);
    expect(requiresProbeBlendRecord({ ...probe } as MaterialShaderArtifact)).toBe(true);
    expect(requiresProbeBlendRecord({ ...ordinary } as MaterialShaderArtifact)).toBe(false);
  });

  it('derives the ProbeBlend page from cooked WGSL without a runtime variantSet', () => {
    const mediumArtifact = {
      variantSet: undefined,
      program: createMaterialShaderProgram(
        '@group(3) @binding(1) var<storage, read> probes: array<vec4<f32>>;',
      ),
    } as unknown as MaterialShaderArtifact;
    const ordinaryArtifact = {
      variantSet: undefined,
      program: createMaterialShaderProgram(
        '@group(3) @binding(1) var<storage, read> visible: array<vec2<u32>>;',
      ),
    } as unknown as MaterialShaderArtifact;

    expect(requiresProbeBlendRecord(mediumArtifact)).toBe(true);
    expect(
      requiresProbeBlendRecord({
        ...mediumArtifact,
        program: createMaterialShaderProgram(
          '@group(3) @binding(1) var<storage> probes: array<vec4<f32>>;',
        ),
      }),
    ).toBe(true);
    expect(requiresProbeBlendRecord(ordinaryArtifact)).toBe(false);
    const entries = buildBindGroupLayoutDescriptor({} as never, {
      kind: 'pbr-gpu-driven-instances',
      caps: { storageBuffer: true, probeBlend: requiresProbeBlendRecord(mediumArtifact) },
    }).entries;
    expect(
      entries.some(
        (entry) =>
          entry.binding === 1 &&
          entry.visibility === 2 &&
          entry.buffer?.type === 'read-only-storage',
      ),
    ).toBe(true);
  });

  it('does not construct probe pipeline layouts on the uniform fallback route', () => {
    const pipelineLabels: string[] = [];
    let handle = 0;
    const device = {
      createBindGroupLayout: () => ({ ok: true, value: { id: ++handle } }),
      createPipelineLayout: (descriptor: { label?: string }) => {
        pipelineLabels.push(descriptor.label ?? '');
        return { ok: true, value: { id: ++handle } };
      },
    };

    const pbr = buildPbrPipelineLayouts(device as never, {
      storageBuffer: false,
      extendedLighting: false,
    });
    const skin = buildPbrSkinLayouts(device as never, { storageBuffer: false }, pbr);

    expect(pipelineLabels).toEqual(['pbr-pl', 'pbr-skin-pl']);
    expect(pbr.probePipelineLayout).toBeNull();
    expect(pbr.probeInstancesBgl).toBe(pbr.instancesBgl);
    expect(skin.probePipelineLayout).toBeNull();
    expect(skin.probeInstancesBgl).toBe(pbr.instancesBgl);
  });

  it('keeps the optional extended-lighting view topology out of the base variant', () => {
    const base = buildPbrViewBglEntries({
      storageBuffer: true,
      extendedLighting: false,
      projectorAvailable: false,
    });
    const extended = buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: true });

    expect(base.map((entry) => entry.binding)).toEqual([0, 3, 4, 5, 6, 7, 8, 10]);
    expect(base.some((entry) => [9, 11, 12, 13, 14].includes(entry.binding))).toBe(false);
    expect(extended.map((entry) => entry.binding)).toEqual(
      expect.arrayContaining([9, 11, 12, 13, 14, 15]),
    );
    expect(extended).toHaveLength(16);
  });

  it('keeps no-probe instances at binding(0) and adds binding(1) only for probe variants', () => {
    const base = buildBindGroupLayoutDescriptor({} as never, {
      kind: 'pbr-instances',
      caps: { storageBuffer: true },
    });
    expect(base.entries).toEqual([
      {
        binding: 0,
        visibility: 3,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      },
    ]);
    const probe = buildBindGroupLayoutDescriptor({} as never, {
      kind: 'pbr-instances',
      caps: { storageBuffer: true, probeBlend: true },
    });
    expect(probe.entries).toEqual([
      {
        binding: 0,
        visibility: 3,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      },
      {
        binding: 1,
        visibility: 2,
        buffer: { type: 'read-only-storage', hasDynamicOffset: true },
      },
    ]);
  });

  it('keeps the scene-index ProbeBlend layout inside the portable fragment storage budget', () => {
    const layout = buildBindGroupLayoutDescriptor({} as never, {
      kind: 'pbr-gpu-driven-instances',
      caps: { storageBuffer: true },
    });
    expect(layout.entries).toMatchObject([
      { binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 1, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: 2, buffer: { type: 'uniform' } },
      { binding: 6, visibility: 1, buffer: { type: 'read-only-storage' } },
      { binding: 7, visibility: 1, buffer: { type: 'read-only-storage' } },
    ]);
    expect(
      layout.entries.filter(
        (entry) => (entry.visibility & 2) !== 0 && entry.buffer?.type === 'read-only-storage',
      ),
    ).toHaveLength(3);
  });

  it('fits the complete scene-index skin layout within the portable vertex storage limit', () => {
    const device = {
      createBindGroupLayout: (descriptor: { entries: readonly GPUBindGroupLayoutEntry[] }) => ({
        ok: true,
        value: descriptor,
      }),
      createPipelineLayout: (descriptor: {
        bindGroupLayouts: readonly { entries: readonly GPUBindGroupLayoutEntry[] }[];
      }) => {
        const vertexStorage = descriptor.bindGroupLayouts
          .flatMap((layout) => layout.entries)
          .filter(
            (entry) =>
              (entry.visibility & 1) !== 0 &&
              (entry.buffer?.type === 'storage' || entry.buffer?.type === 'read-only-storage'),
          );
        expect(vertexStorage.length).toBeLessThanOrEqual(8);
        return { ok: true, value: descriptor };
      },
    };
    const caps = { storageBuffer: true, extendedLighting: true };
    const pbr = buildPbrPipelineLayouts(device as never, caps);
    const skin = buildPbrSkinLayouts(device as never, caps, pbr);
    const instances = buildGpuDrivenPbrInstancesBindGroupLayout(device as never, caps);
    buildGpuDrivenPbrSkinPipelineLayout(device as never, skin, instances);
  });

  it('keeps direct Surface instance transforms out of the fragment storage budget', () => {
    const layout = buildBindGroupLayoutDescriptor({} as never, {
      kind: 'pbr-surface-direct-instances',
      caps: { storageBuffer: true },
    });
    expect(layout.entries).toMatchObject([
      { binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: 2, buffer: { type: 'uniform' } },
      { binding: 6, visibility: 1, buffer: { type: 'uniform' } },
    ]);
    expect(
      layout.entries.filter(
        (entry) => (entry.visibility & 2) !== 0 && entry.buffer?.type === 'read-only-storage',
      ),
    ).toHaveLength(3);
  });

  it('creates mixed no-probe/probe bind groups without crossing layouts', () => {
    const noProbeLayout = { id: 'no-probe-layout' };
    const probeLayout = { id: 'probe-layout' };
    const instanceBuffer = { id: 'instance-128b' };
    const probeBuffer = { id: 'probe-160b' };
    const groups: Array<{ layout: object; entries: readonly unknown[] }> = [];
    const context = {
      runtime: {
        device: {
          createBindGroup: (input: { layout: object; entries: readonly unknown[] }) => {
            groups.push(input);
            return { ok: true, value: { id: groups.length } };
          },
        },
      },
      pipelineState: {
        instancesBindGroupLayout: noProbeLayout,
        probeInstancesBindGroupLayout: probeLayout,
      },
      frameState: { instancesBgShared: new WeakMap<object, unknown>() },
      bindGroupCounts: { createBindGroup: 0, keys: [] },
    } as never;

    resolveGeometryInstancesBindGroup(context, instanceBuffer as never);
    resolveGeometryInstancesBindGroup(context, instanceBuffer as never, probeBuffer as never);
    expect(groups[0]).toMatchObject({ layout: noProbeLayout, entries: [{ binding: 0 }] });
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[1]).toMatchObject({
      layout: probeLayout,
      entries: [{ binding: 0 }, { binding: 1 }],
    });
    expect(groups[1]?.entries).toHaveLength(2);
    expect(groups[1]?.entries[1]).toMatchObject({
      binding: 1,
      resource: { value: { buffer: probeBuffer, offset: 0, size: 160 } },
    });
  });

  it('does not allocate a probe sentinel for a no-probe frame', () => {
    const creates: unknown[] = [];
    const context = {
      runtime: {
        device: {
          caps: { storageBuffer: true },
          createBuffer: (descriptor: unknown) => {
            creates.push(descriptor);
            return { ok: true, value: {} };
          },
        },
      },
      frameState: { probeBlendRecordBufferCapacity: 0, probeBlendBuffers: new Map() },
    } as never;
    expect(() => resolveProbeBlendBuffer(context, undefined)).toThrow(
      'probe blend record is required for probe allocation',
    );
    expect(creates).toHaveLength(0);
  });

  it('maps the retained RenderScene slot to a distinct aligned record lane', () => {
    expect(probeBlendRecordOffset(0)).toBe(PROBE_BLEND_RECORD_STRIDE);
    expect(probeBlendRecordOffset(7)).toBe(8 * PROBE_BLEND_RECORD_STRIDE);
    expect(() => probeBlendRecordOffset(-1)).toThrow();
  });

  it('reuploads after backing-buffer growth or recovery instead of trusting stale cache bytes', () => {
    let nextBuffer = 0;
    const writes: Array<{ buffer: object; offset: number; bytes: Uint8Array }> = [];
    const device = {
      caps: { storageBuffer: true },
      createBuffer: () => ({ ok: true, value: { id: ++nextBuffer } }),
      destroyBuffer: () => ({ ok: true }),
      queue: {
        onSubmittedWorkDone: async () => undefined,
        writeBuffer: (buffer: object, offset: number, bytes: Uint8Array) => {
          writes.push({ buffer, offset, bytes: new Uint8Array(bytes) });
          return { ok: true };
        },
      },
    };
    const frameState: {
      probeBlendBuffers: Map<number, { generation: number; bytes: Uint8Array }>;
      probeBlendRecordBuffer?: object;
      probeBlendRecordBufferCapacity: number;
    } = {
      probeBlendBuffers: new Map(),
      probeBlendRecordBufferCapacity: 0,
    };
    const context = { runtime: { device }, frameState } as never;
    const record: ProbeBlendRecord = {
      objectKey: 0,
      generation: 1,
      localBlendFraction: 0,
      shPreblend: [],
      bytes: new Uint8Array(160).fill(7),
      byteLength: 160,
      candidate: true,
      accepted: true,
      lastKnownGood: true,
    };

    const first = resolveProbeBlendBuffer(context, record, 11);
    resolveProbeBlendBuffer(context, record, 11);
    expect(writes).toHaveLength(1);
    expect(first.offset).toBe(PROBE_BLEND_RECORD_STRIDE);

    const grown: ProbeBlendRecord = { ...record, objectKey: 4 };
    resolveProbeBlendBuffer(context, grown, 12);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.offset).toBe(5 * PROBE_BLEND_RECORD_STRIDE);

    delete frameState.probeBlendRecordBuffer;
    frameState.probeBlendRecordBufferCapacity = 0;
    resolveProbeBlendBuffer(context, record, 11);
    expect(writes).toHaveLength(3);
    expect(writes[2]?.offset).toBe(PROBE_BLEND_RECORD_STRIDE);
  });

  it('publishes two scene-index SH domains before binding their slot and generation addresses', () => {
    let nextBuffer = 0;
    const creates: unknown[] = [];
    const writes: Array<{ offset: number; bytes: Uint8Array }> = [];
    const device = {
      caps: { storageBuffer: true },
      createBuffer: (descriptor: unknown) => {
        creates.push(descriptor);
        return { ok: true, value: { id: ++nextBuffer } };
      },
      queue: {
        writeBuffer: (_buffer: object, offset: number, bytes: Uint8Array) => {
          writes.push({ offset, bytes: new Uint8Array(bytes) });
          return { ok: true };
        },
      },
    };
    const frameState: Pick<
      RenderFrameState,
      | 'probeBlendBuffers'
      | 'probeBlendRecordBuffer'
      | 'probeBlendRecordBufferCapacity'
      | 'probeBlendRecordProjection'
    > = {
      probeBlendBuffers: new Map<number, { generation: number; bytes: Uint8Array }>(),
      probeBlendRecordBufferCapacity: 0,
    };
    const red = new Uint8Array(160);
    const green = new Uint8Array(160);
    new Float32Array(red.buffer).set([0, 4, 1, 0, 1, 0, 0]);
    new Float32Array(green.buffer).set([3, 9, 1, 0, 0, 1, 0]);
    const record = (
      objectKey: number,
      generation: number,
      bytes: Uint8Array,
    ): ProbeBlendRecord => ({
      objectKey,
      generation,
      localBlendFraction: 1,
      shPreblend: [],
      bytes,
      byteLength: 160,
      candidate: true,
      accepted: true,
      lastKnownGood: true,
    });
    const records = [
      { cacheKey: 10, record: record(0, 4, red) },
      { cacheKey: 20, record: record(3, 9, green) },
    ];

    expect(
      ensureProbeBlendRecordBuffer(device as never, frameState as never, records),
    ).toBeDefined();
    expect(creates).toHaveLength(1);
    expect(writes.map((write) => write.offset)).toEqual([
      PROBE_BLEND_RECORD_STRIDE,
      4 * PROBE_BLEND_RECORD_STRIDE,
    ]);
    expect(writes[0]?.bytes).not.toEqual(writes[1]?.bytes);
    ensureProbeBlendRecordBuffer(device as never, frameState as never, records);
    expect(writes).toHaveLength(2);
  });

  it('publishes growth atomically and retires every replaced buffer after the queue fence', async () => {
    let nextBuffer = 0;
    let releaseFence!: () => void;
    const fence = new Promise<undefined>((resolve) => {
      releaseFence = () => resolve(undefined);
    });
    const destroyed = new Set<number>();
    const device = {
      caps: { storageBuffer: true },
      createBuffer: () => ({ ok: true, value: { id: ++nextBuffer } }),
      destroyBuffer: (buffer: { id: number }) => {
        destroyed.add(buffer.id);
        return { ok: true };
      },
      queue: {
        onSubmittedWorkDone: () => fence,
        writeBuffer: () => ({ ok: true }),
      },
    };
    const frameState: {
      probeBlendBuffers: Map<number, { generation: number; bytes: Uint8Array }>;
      probeBlendRecordBufferCapacity: number;
      probeBlendRecordBuffer?: GpuBuffer;
    } = {
      probeBlendBuffers: new Map<number, { generation: number; bytes: Uint8Array }>(),
      probeBlendRecordBufferCapacity: 0,
    };
    const record = (objectKey: number): ProbeBlendRecord => ({
      objectKey,
      generation: objectKey + 1,
      localBlendFraction: 1,
      shPreblend: [],
      bytes: new Uint8Array(160).fill(objectKey + 1),
      byteLength: 160,
      candidate: true,
      accepted: true,
      lastKnownGood: true,
    });

    ensureProbeBlendRecordBuffer(device as never, frameState, [{ cacheKey: 1, record: record(0) }]);
    ensureProbeBlendRecordBuffer(device as never, frameState, [
      { cacheKey: 1, record: record(0) },
      { cacheKey: 2, record: record(4) },
    ]);
    ensureProbeBlendRecordBuffer(device as never, frameState, [
      { cacheKey: 1, record: record(0) },
      { cacheKey: 2, record: record(4) },
      { cacheKey: 3, record: record(9) },
    ]);

    expect(nextBuffer).toBe(3);
    expect(destroyed.size).toBe(0);
    expect(frameState.probeBlendRecordBuffer?.handle).toEqual({ id: 3 });
    releaseFence();
    await fence;
    await Promise.resolve();
    expect(destroyed).toEqual(new Set([1, 2]));
    frameState.probeBlendRecordBuffer?.destroy();
    expect(destroyed).toEqual(new Set([1, 2, 3]));
  });

  it('keeps the committed buffer and cache when a growth upload fails', () => {
    let nextBuffer = 0;
    const destroyed = new Set<number>();
    let failCandidate = false;
    const device = {
      caps: { storageBuffer: true },
      createBuffer: () => ({ ok: true, value: { id: ++nextBuffer } }),
      destroyBuffer: (buffer: { id: number }) => {
        destroyed.add(buffer.id);
        return { ok: true };
      },
      queue: {
        onSubmittedWorkDone: async () => undefined,
        writeBuffer: (buffer: { id: number }) =>
          failCandidate && buffer.id === 2
            ? { ok: false, error: new Error('upload failed') }
            : { ok: true },
      },
    };
    const frameState: {
      probeBlendBuffers: Map<number, { generation: number; bytes: Uint8Array }>;
      probeBlendRecordBufferCapacity: number;
      probeBlendRecordBuffer?: GpuBuffer;
    } = {
      probeBlendBuffers: new Map<number, { generation: number; bytes: Uint8Array }>(),
      probeBlendRecordBufferCapacity: 0,
    };
    const first: ProbeBlendRecord = {
      objectKey: 0,
      generation: 1,
      localBlendFraction: 1,
      shPreblend: [],
      bytes: new Uint8Array(160).fill(1),
      byteLength: 160,
      candidate: true,
      accepted: true,
      lastKnownGood: true,
    };
    ensureProbeBlendRecordBuffer(device as never, frameState, [{ cacheKey: 1, record: first }]);
    const committed = frameState.probeBlendRecordBuffer;
    failCandidate = true;

    expect(() =>
      ensureProbeBlendRecordBuffer(device as never, frameState, [
        { cacheKey: 1, record: first },
        { cacheKey: 2, record: { ...first, objectKey: 4, generation: 2 } },
      ]),
    ).toThrow('upload failed');
    expect(frameState.probeBlendRecordBuffer).toBe(committed);
    expect(frameState.probeBlendRecordBufferCapacity).toBe(2);
    expect([...frameState.probeBlendBuffers.keys()]).toEqual([1]);
    expect(destroyed).toEqual(new Set([2]));
    expect(committed?.isDestroyed).toBe(false);
  });

  it('retries every producer-dirty row after a non-growth upload failure', () => {
    let writeAttempt = 0;
    let failSecondDirty = false;
    const device = {
      caps: { storageBuffer: true },
      createBuffer: () => ({ ok: true, value: { id: 1 } }),
      destroyBuffer: () => ({ ok: true }),
      queue: {
        onSubmittedWorkDone: async () => undefined,
        writeBuffer: () => {
          writeAttempt += 1;
          return failSecondDirty && writeAttempt === 4
            ? { ok: false, error: new Error('dirty upload failed') }
            : { ok: true };
        },
      },
    };
    const frameState: Pick<
      RenderFrameState,
      | 'probeBlendBuffers'
      | 'probeBlendRecordBuffer'
      | 'probeBlendRecordBufferCapacity'
      | 'probeBlendRecordProjection'
    > = {
      probeBlendBuffers: new Map(),
      probeBlendRecordBufferCapacity: 0,
    };
    const makeRecord = (objectKey: number, generation: number): ProbeBlendRecord => ({
      objectKey,
      generation,
      localBlendFraction: 1,
      shPreblend: [],
      bytes: new Uint8Array(160).fill(generation),
      byteLength: 160,
      candidate: true,
      accepted: true,
      lastKnownGood: true,
    });
    const firstRows = [
      Object.freeze({ cacheKey: 0, record: makeRecord(0, 1) }),
      Object.freeze({ cacheKey: 1, record: makeRecord(1, 1) }),
    ];
    const sourceIdentity = {};
    const first: ProbeBlendBufferProjection = Object.freeze({
      sourceIdentity,
      revision: 1,
      baseRevision: 0,
      capacity: 3,
      records: Object.freeze(firstRows),
      dirtyRecords: Object.freeze(firstRows),
      removedCacheKeys: Object.freeze([]),
    });
    ensureProbeBlendRecordBuffer(device as never, frameState, first);

    const changedRows = [
      Object.freeze({ cacheKey: 0, record: makeRecord(0, 2) }),
      Object.freeze({ cacheKey: 1, record: makeRecord(1, 2) }),
    ];
    const changed: ProbeBlendBufferProjection = Object.freeze({
      sourceIdentity,
      revision: 2,
      baseRevision: 1,
      capacity: 3,
      records: Object.freeze(changedRows),
      dirtyRecords: Object.freeze(changedRows),
      removedCacheKeys: Object.freeze([]),
    });
    failSecondDirty = true;
    expect(() => ensureProbeBlendRecordBuffer(device as never, frameState, changed)).toThrow(
      'dirty upload failed',
    );
    expect(frameState.probeBlendRecordProjection?.projection).toBe(first);
    expect([...frameState.probeBlendBuffers.values()].map((entry) => entry.generation)).toEqual([
      1, 1,
    ]);

    failSecondDirty = false;
    ensureProbeBlendRecordBuffer(device as never, frameState, changed);
    expect(writeAttempt).toBe(6);
    expect(frameState.probeBlendRecordProjection?.projection).toBe(changed);
    expect([...frameState.probeBlendBuffers.values()].map((entry) => entry.generation)).toEqual([
      2, 2,
    ]);
  });

  it('restores a full projection when a failed revision is skipped', () => {
    const gpu = new Map<object, Map<number, number>>();
    let failARevision2 = false;
    const device = {
      caps: { storageBuffer: true },
      createBuffer: () => {
        const handle = {};
        gpu.set(handle, new Map());
        return { ok: true, value: handle };
      },
      destroyBuffer: () => ({ ok: true }),
      queue: {
        onSubmittedWorkDone: async () => undefined,
        writeBuffer: (buffer: object, offset: number, bytes: Uint8Array) => {
          const objectKey = offset / PROBE_BLEND_RECORD_STRIDE - 1;
          const generation = bytes[0] ?? 0;
          if (failARevision2 && objectKey === 0 && generation === 2) {
            return { ok: false, error: new Error('revision 2 upload failed') };
          }
          gpu.get(buffer)?.set(objectKey, generation);
          return { ok: true };
        },
      },
    };
    const frameState: Pick<
      RenderFrameState,
      | 'probeBlendBuffers'
      | 'probeBlendRecordBuffer'
      | 'probeBlendRecordBufferCapacity'
      | 'probeBlendRecordProjection'
    > = {
      probeBlendBuffers: new Map(),
      probeBlendRecordBufferCapacity: 0,
    };
    const sourceIdentity = {};
    const row = (objectKey: number, generation: number) =>
      Object.freeze({
        cacheKey: objectKey,
        record: {
          objectKey,
          generation,
          localBlendFraction: 1,
          shPreblend: [],
          bytes: new Uint8Array(160).fill(generation),
          byteLength: 160,
          candidate: true,
          accepted: true,
          lastKnownGood: true,
        } satisfies ProbeBlendRecord,
      });
    const projection = (
      revision: number,
      baseRevision: number,
      records: readonly ReturnType<typeof row>[],
      dirtyRecords: readonly ReturnType<typeof row>[],
    ) =>
      Object.freeze({
        sourceIdentity,
        revision,
        baseRevision,
        capacity: 3,
        records: Object.freeze(records),
        dirtyRecords: Object.freeze(dirtyRecords),
        removedCacheKeys: Object.freeze([]),
      }) satisfies ProbeBlendBufferProjection;
    const a1 = row(0, 1);
    const b1 = row(1, 1);
    const a2 = row(0, 2);
    const b2 = row(1, 2);

    ensureProbeBlendRecordBuffer(device as never, frameState, projection(1, 0, [a1, b1], [a1, b1]));
    failARevision2 = true;
    expect(() =>
      ensureProbeBlendRecordBuffer(device as never, frameState, projection(2, 1, [a2, b1], [a2])),
    ).toThrow('revision 2 upload failed');
    expect(frameState.probeBlendRecordProjection?.projection.revision).toBe(1);

    failARevision2 = false;
    ensureProbeBlendRecordBuffer(device as never, frameState, projection(3, 2, [a2, b2], [b2]));
    expect(
      [...frameState.probeBlendBuffers.entries()].map(([key, value]) => [key, value.generation]),
    ).toEqual([
      [0, 2],
      [1, 2],
    ]);
    const active = frameState.probeBlendRecordBuffer?.handle;
    expect(active === undefined ? undefined : [...(gpu.get(active) ?? [])]).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(frameState.probeBlendRecordProjection?.projection.revision).toBe(3);
  });

  it('does not inspect retained records again for a stable producer revision', () => {
    let objectKeyReads = 0;
    let bytesReads = 0;
    let writes = 0;
    const device = {
      caps: { storageBuffer: true },
      createBuffer: () => ({ ok: true, value: { id: 1 } }),
      destroyBuffer: () => ({ ok: true }),
      queue: {
        onSubmittedWorkDone: async () => undefined,
        writeBuffer: () => {
          writes += 1;
          return { ok: true };
        },
      },
    };
    const bytes = new Uint8Array(160);
    const record = {
      get objectKey() {
        objectKeyReads += 1;
        return 7;
      },
      generation: 3,
      get bytes() {
        bytesReads += 1;
        return bytes;
      },
    } as ProbeBlendRecord;
    const row = Object.freeze({ cacheKey: 7, record });
    const projection: ProbeBlendBufferProjection = Object.freeze({
      sourceIdentity: {},
      revision: 11,
      baseRevision: 10,
      capacity: 9,
      records: Object.freeze([row]),
      dirtyRecords: Object.freeze([row]),
      removedCacheKeys: Object.freeze([]),
    });
    const frameState: Pick<
      RenderFrameState,
      | 'probeBlendBuffers'
      | 'probeBlendRecordBuffer'
      | 'probeBlendRecordBufferCapacity'
      | 'probeBlendRecordProjection'
    > = {
      probeBlendBuffers: new Map<number, { generation: number; bytes: Uint8Array }>(),
      probeBlendRecordBufferCapacity: 0,
    };

    ensureProbeBlendRecordBuffer(device as never, frameState, projection);
    objectKeyReads = 0;
    bytesReads = 0;
    writes = 0;
    for (let frame = 0; frame < 300; frame += 1) {
      ensureProbeBlendRecordBuffer(device as never, frameState, undefined);
      ensureProbeBlendRecordBuffer(device as never, frameState, projection);
    }

    expect({ objectKeyReads, bytesReads, writes }).toEqual({
      objectKeyReads: 0,
      bytesReads: 0,
      writes: 0,
    });
  });

  it('applies producer dirty and removal evidence and rebuilds on a new device', () => {
    let nextBuffer = 0;
    const writes: { readonly device: string; readonly offset: number }[] = [];
    const createDevice = (identity: string) => ({
      caps: { storageBuffer: true },
      createBuffer: () => ({ ok: true, value: { id: ++nextBuffer, identity } }),
      destroyBuffer: () => ({ ok: true }),
      queue: {
        onSubmittedWorkDone: async () => undefined,
        writeBuffer: (_buffer: object, offset: number) => {
          writes.push({ device: identity, offset });
          return { ok: true };
        },
      },
    });
    const deviceA = createDevice('a');
    const deviceB = createDevice('b');
    const makeRecord = (objectKey: number, generation: number): ProbeBlendRecord => ({
      objectKey,
      generation,
      localBlendFraction: 1,
      shPreblend: [],
      bytes: new Uint8Array(160).fill(generation),
      byteLength: 160,
      candidate: true,
      accepted: true,
      lastKnownGood: true,
    });
    const firstRow = Object.freeze({ cacheKey: 1, record: makeRecord(1, 1) });
    const secondRow = Object.freeze({ cacheKey: 4, record: makeRecord(4, 1) });
    const sourceIdentity = {};
    const first: ProbeBlendBufferProjection = Object.freeze({
      sourceIdentity,
      revision: 1,
      baseRevision: 0,
      capacity: 6,
      records: Object.freeze([firstRow, secondRow]),
      dirtyRecords: Object.freeze([firstRow, secondRow]),
      removedCacheKeys: Object.freeze([]),
    });
    const frameState: Pick<
      RenderFrameState,
      | 'probeBlendBuffers'
      | 'probeBlendRecordBuffer'
      | 'probeBlendRecordBufferCapacity'
      | 'probeBlendRecordProjection'
    > = {
      probeBlendBuffers: new Map<number, { generation: number; bytes: Uint8Array }>(),
      probeBlendRecordBufferCapacity: 0,
    };
    ensureProbeBlendRecordBuffer(deviceA as never, frameState, first);
    expect(writes).toHaveLength(2);

    const changedRow = Object.freeze({ cacheKey: 4, record: makeRecord(4, 2) });
    const changed: ProbeBlendBufferProjection = Object.freeze({
      sourceIdentity,
      revision: 2,
      baseRevision: 1,
      capacity: 6,
      records: Object.freeze([changedRow]),
      dirtyRecords: Object.freeze([changedRow]),
      removedCacheKeys: Object.freeze([1]),
    });
    ensureProbeBlendRecordBuffer(deviceA as never, frameState, changed);
    expect(writes).toHaveLength(3);
    expect([...frameState.probeBlendBuffers.keys()]).toEqual([4]);
    ensureProbeBlendRecordBuffer(deviceA as never, frameState, changed);
    expect(writes).toHaveLength(3);

    const abaRow = Object.freeze({ cacheKey: 1, record: makeRecord(1, 3) });
    const aba: ProbeBlendBufferProjection = Object.freeze({
      sourceIdentity,
      revision: 3,
      baseRevision: 2,
      capacity: 6,
      records: Object.freeze([abaRow, changedRow]),
      dirtyRecords: Object.freeze([abaRow]),
      removedCacheKeys: Object.freeze([]),
    });
    ensureProbeBlendRecordBuffer(deviceA as never, frameState, aba);
    expect(writes).toHaveLength(4);
    expect(frameState.probeBlendBuffers.get(1)?.generation).toBe(3);

    ensureProbeBlendRecordBuffer(deviceB as never, frameState, aba);
    expect(writes.filter((write) => write.device === 'b')).toHaveLength(2);
    expect(frameState.probeBlendRecordProjection?.device).toBe(deviceB);
  });
});
