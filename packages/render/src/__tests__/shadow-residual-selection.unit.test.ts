import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { GpuBuffer } from '../gpu-resource';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { publishShadowMembership } from '../record/shadow-ownership-index';
import {
  createShadowDispatchProjectionOwner,
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
  recordShadowCasterDraws,
} from '../record/shadow-pass';
import type { ShadowCasterMembership } from '../render-system-extract';

async function fixture(
  gpuCount: number,
  kind: 'directional' | 'point' | 'spot' = 'directional',
  mixed = false,
  cpuOnly = false,
  incomplete = false,
) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const buffer = device.createBuffer({ size: 4096, usage: 0xa8 }).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const vertex = new GpuBuffer(device, buffer);
  const material = {
    materialHandle: 1,
    paramSnapshot: mixed ? { alphaCutoff: 0.5 } : {},
    materialShaderId: 'forgeax::default-standard-pbr',
  };
  const submeshes = [{ topology: 'triangle-list', materialSlot: 0, indexCount: 3, indexOffset: 0 }];
  const membership: unknown[] = [];
  const dispatch: unknown[] = [];
  const rows: unknown[] = [];
  const claimed = new Set<string>();
  let gpuGeometryReads = 0;
  let gpuDrawIndexBuilds = 0;
  for (let index = 0; index <= gpuCount + Number(cpuOnly); index++) {
    const gpu = index < gpuCount;
    const meshSubmeshes = incomplete && index === 0 ? [...submeshes, ...submeshes] : submeshes;
    const source = {
      entityKey: index + 1,
      worldId: 0,
      transform: { world: mat4.identity(mat4.create()) },
      material,
      materials: [material],
      gpuDrivenDraws: meshSubmeshes.map((_, drawItemIndex) => ({ drawItemIndex, materialSlot: 0 })),
    };
    const drawEntries = source.gpuDrivenDraws.entries.bind(source.gpuDrivenDraws);
    source.gpuDrivenDraws.entries = () => {
      if (gpu) gpuDrawIndexBuilds++;
      return drawEntries();
    };
    if (index <= gpuCount)
      membership.push({
        worldEntity: index + 1,
        renderableIndex: index,
        drawItemIndex: 0,
        materialHandle: 1,
        passIndex: 0,
        ...(gpu ? {} : { cpuReason: 'unprepared' }),
      });
    if (gpu || (mixed && index === gpuCount)) claimed.add(`${index + 1}:1:0:0`);
    if (mixed && index === gpuCount) {
      membership.push({
        worldEntity: index + 1,
        renderableIndex: index,
        drawItemIndex: 0,
        materialHandle: 1,
        passIndex: 7,
        cpuReason: 'multi-pass',
      });
      dispatch.push({
        renderableIndex: index,
        materialHandle: 1,
        passIndex: 7,
        tags: { LightMode: 'ShadowCaster' },
        materialShaderId: 'forgeax::default-standard-pbr',
      });
    }
    dispatch.push({
      renderableIndex: index,
      materialHandle: 1,
      passIndex: 0,
      tags: { LightMode: 'ShadowCaster' },
      materialShaderId: 'forgeax::default-standard-pbr',
    });
    rows.push({
      renderableIndex: index,
      source,
      mesh: {
        vertexBuffer: vertex,
        indexed: true,
        indexBuffer: vertex,
        indexFormat: 'uint16',
        layoutProjection: { attributes: [] },
        get submeshes() {
          if (gpu) gpuGeometryReads++;
          return meshSubmeshes;
        },
      },
    });
  }
  const identity = { kind, index: 0, ...(kind === 'point' ? { face: 0 } : {}) };
  const key = `${kind}:0:${kind === 'point' ? '0' : ''}`;
  const world = new World();
  const context = {
    runtime: { device, getMaterialShaderPipeline: () => ({}) },
    world,
    store: { materialResourceEpoch: 0 },
    pipelineState: {
      projectorAvailable: false,
      perPassResources: { shadowSampler: {} },
      viewUniformBuffer: buffer,
      shadowArrayFallbackTextureView: {},
      shadowAtlasFallbackTextureView: {},
      shadowParamsBuffer: buffer,
      shadowCasterCascadeBuffer: buffer,
      viewBindGroupLayout: layout,
      materialBindGroupLayout: layout,
      instancesBindGroupLayout: layout,
      identityInstanceBuffer: buffer,
      materialUniformBuffer: { buffer, sizeInBytes: 4096 },
      meshStorageBuffer: { buffer, sizeInBytes: 4096 },
      defaultSampler: {},
      defaultNormalTextureView: {},
      fallbackTextureView: {},
      defaultWhiteTextureView: {},
      skylightFallback: {
        irradianceView: {},
        prefilterView: {},
        brdfLutView: {},
        sampler: {},
        intensityBuffer: buffer,
      },
    },
    frameState: {
      viewBindGroupCache: new Map(),
      shadowMaterialBindGroups: new WeakMap(),
      instancesBgShared: new WeakMap(),
      materialBgShared: new Map(),
      pointShadowSnapshots: [{ shadowAtlasLayer: 0 }],
      spotShadowSnapshots: [{ shadowAtlasTile: 0, lightViewProj: new Float32Array(16) }],
    },
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    dispatch,
    validatedOrdered: rows,
    materialSlots: [material],
    materialSlotIndices: rows.map(() => [0]),
    meshBindGroup: {},
    shadowCasterMembership: membership,
    gpuDrivenShadowViews: {
      submission: () => ({ identity, view: { indirectBuffer: buffer }, plan: { batches: [] } }),
    },
    gpuDrivenShadowBatchProjections: new Map([[key, new Map()]]),
    gpuDrivenShadowDrawKeysByView: new Map([[key, claimed]]),
    gpuDrivenShadowDrawKeys: claimed,
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as _InternalRenderPipelineContext;
  let draws = 0;
  const pass = {
    setBindGroup() {},
    setPipeline() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndexed() {
      draws++;
    },
  } as unknown as RhiRenderPassEncoder;
  return {
    context,
    pass,
    claimed,
    encode: () =>
      kind === 'directional'
        ? encodeDirectionalShadowPass(context, pass, 0)
        : kind === 'point'
          ? encodePointShadowPass(context, pass, 0, 0)
          : encodeSpotShadowPass(context, pass, 0),
    geometryReads: () => gpuGeometryReads,
    drawIndexBuilds: () => gpuDrawIndexBuilds,
    draws: () => draws,
    dispose: () => {
      vertex.destroy().unwrap();
    },
  };
}

it.each([
  'directional',
  'point',
  'spot',
] as const)('skips fully GPU-owned draw preparation for %s CPU residuals', async (kind) => {
  const f = await fixture(2_000, kind);
  try {
    f.encode();
    expect(f.draws()).toBe(1);
    expect(f.drawIndexBuilds()).toBe(0);
  } finally {
    f.dispose();
  }
});

it.each([
  'directional',
  'point',
  'spot',
] as const)('keeps the shared full roster separate from %s GPU residuals', async (kind) => {
  const f = await fixture(10, kind);
  const owner = createShadowDispatchProjectionOwner(f.context);
  const fullRoster = owner.resolve(f.context);
  let fullRosterResolves = 0;
  Object.assign(f.context, {
    shadowDispatchProjection: {
      casters: owner.casters,
      resolve(input: Parameters<typeof owner.resolve>[0]) {
        fullRosterResolves++;
        return owner.resolve(input);
      },
    },
  });
  const gpuClaims = [...f.claimed];
  try {
    f.encode();
    expect(f.draws()).toBe(1);
    expect(f.drawIndexBuilds()).toBe(0);
    expect(fullRosterResolves).toBe(0);

    // Another view can leave the same roster wholly to the CPU.
    f.claimed.clear();
    f.encode();
    expect(f.draws()).toBe(12);
    expect(fullRosterResolves).toBe(1);

    for (const claim of gpuClaims) f.claimed.add(claim);
    f.encode();
    expect(f.draws()).toBe(13);
    expect(fullRosterResolves).toBe(1);
    expect(owner.resolve(f.context)).toBe(fullRoster);
  } finally {
    f.dispose();
  }
});

it('retains partial alpha/multi-pass ownership and sources without membership', async () => {
  const f = await fixture(10, 'directional', true, true);
  try {
    f.encode();
    expect(f.draws()).toBe(2);
    expect(f.drawIndexBuilds()).toBe(0);
  } finally {
    f.dispose();
  }
});

it('retains an actual submesh absent from otherwise claimed membership', async () => {
  const f = await fixture(10, 'directional', false, false, true);
  try {
    f.encode();
    expect(f.draws()).toBe(2);
  } finally {
    f.dispose();
  }
});

it('shares the exact captured residual across views while comparing complete claim contents', async () => {
  const f = await fixture(100, 'directional', true, true);
  Object.assign(f.context, {
    shadowCasterMembership: publishShadowMembership([
      ...(f.context.shadowCasterMembership as readonly ShadowCasterMembership[]),
    ]),
  });
  const owner = createShadowDispatchProjectionOwner(f.context);
  Object.assign(f.context, { shadowDispatchProjection: owner });
  const residual = () => owner.residual?.(f.context, f.claimed);
  try {
    const first = residual();
    const reads = f.geometryReads();
    expect(first?.matchedIndices).toEqual(new Set([100, 101]));
    expect(residual()).toBe(first);
    expect(owner.residual?.(f.context, new Set(f.claimed))).toBe(first);
    expect(f.geometryReads()).toBe(reads);

    // Frozen Set objects still permit mutations; equal cardinality is not proof.
    const key = [...f.claimed][0] as string;
    f.claimed.delete(key);
    f.claimed.add('unrelated:1:0:0');
    Object.freeze(f.claimed);
    const changed = residual();
    expect(changed).not.toBe(first);
    expect(changed?.matchedIndices?.has(0)).toBe(true);
    expect(f.geometryReads()).toBeGreaterThan(reads);
    f.claimed.delete('unrelated:1:0:0');
    f.claimed.add(key);
    const restored = residual();
    expect(restored?.matchedIndices).toEqual(first?.matchedIndices);
    expect(residual()).toBe(restored);

    // A different view context, roster, world namespace or membership never
    // borrows another context's captured geometry/ownership proof.
    for (const view of [
      { ...f.context },
      { ...f.context, validatedOrdered: [...f.context.validatedOrdered] },
      { ...f.context, shadowCasterWorldKeys: [0] },
      {
        ...f.context,
        shadowCasterMembership: publishShadowMembership([
          ...(f.context.shadowCasterMembership as readonly ShadowCasterMembership[]),
        ]),
      },
    ]) {
      expect(owner.residual?.(view, f.claimed)).not.toBe(restored);
    }
  } finally {
    f.dispose();
  }
});

it('retains every borrowed geometry observation without producer-owned membership', async () => {
  const f = await fixture(10);
  const owner = createShadowDispatchProjectionOwner(f.context);
  try {
    owner.residual?.(f.context, f.claimed);
    const reads = f.geometryReads();
    owner.residual?.(f.context, f.claimed);
    expect(f.geometryReads()).toBe(reads * 2);
  } finally {
    f.dispose();
  }
});

it('preserves custom claim getter observations even with captured membership', async () => {
  const f = await fixture(10);
  Object.assign(f.context, {
    shadowCasterMembership: publishShadowMembership([
      ...(f.context.shadowCasterMembership as readonly ShadowCasterMembership[]),
    ]),
  });
  let reads = 0;
  const claimed = {
    size: f.claimed.size,
    get has() {
      reads++;
      return f.claimed.has.bind(f.claimed);
    },
    [Symbol.iterator]: () => f.claimed[Symbol.iterator](),
  } as ReadonlySet<string>;
  const owner = createShadowDispatchProjectionOwner(f.context);
  try {
    const first = owner.residual?.(f.context, claimed);
    const before = reads;
    expect(owner.residual?.(f.context, claimed)).toEqual(first);
    expect(reads).toBe(before * 2);
    expect(reads).toBeGreaterThan(0);
  } finally {
    f.dispose();
  }
});

it.each([
  'directional',
  'point',
  'spot',
] as const)('preserves %s residual commands when claims change or a Set is reused', async (kind) => {
  const reference = await fixture(10, kind, true, true, true);
  const captured = await fixture(10, kind, true, true, true);
  Object.assign(captured.context, {
    shadowCasterMembership: publishShadowMembership([
      ...(captured.context.shadowCasterMembership as readonly ShadowCasterMembership[]),
    ]),
    shadowDispatchProjection: createShadowDispatchProjectionOwner(captured.context),
  });
  const trace = (pass: RhiRenderPassEncoder) => {
    const calls: unknown[] = [];
    for (const method of [
      'setBindGroup',
      'setPipeline',
      'setVertexBuffer',
      'setIndexBuffer',
      'drawIndexed',
    ] as const) {
      const original = pass[method].bind(pass) as (...args: unknown[]) => void;
      Object.assign(pass, {
        [method]: (...args: unknown[]) => {
          calls.push([method, ...args.map((arg) => (typeof arg === 'object' ? null : arg))]);
          original(...args);
        },
      });
    }
    return calls;
  };
  const expected = trace(reference.pass),
    actual = trace(captured.pass);
  const original = [...reference.claimed];
  try {
    for (const keys of [original, original, original.slice(1), [], original, original]) {
      for (const f of [reference, captured]) {
        f.claimed.clear();
        for (const key of keys) f.claimed.add(key);
        f.encode();
      }
      expect(actual).toEqual(expected);
      expect(captured.draws()).toBe(reference.draws());
    }
  } finally {
    reference.dispose();
    captured.dispose();
  }
});

it.each([
  { name: 'dense', ids: [0, 1, 2], claimed: [1], expected: [0, 2] },
  { name: 'sparse', ids: [0, 2], claimed: [2], expected: [0, 1] },
  { name: 'unordered', ids: [2, 0], claimed: [2], expected: [0, 1] },
  { name: 'all GPU', ids: [0, 1, 2], claimed: [0, 1, 2], expected: [] },
  { name: 'repeated', ids: [0, 0, 2], claimed: [0], expected: [1, 2] },
])('records exact CPU residuals for $name source draw identities', async ({
  ids,
  claimed,
  expected,
}) => {
  const f = await fixture(0);
  const row = f.context.validatedOrdered[0];
  if (row === undefined) throw new Error('Missing shadow fixture row');
  const submeshes = Array.from({ length: 3 }, (_, index) => ({
    topology: 'triangle-list',
    materialSlot: 0,
    indexCount: 3,
    indexOffset: index * 3,
  }));
  Object.assign(f.context, {
    validatedOrdered: [
      {
        ...row,
        mesh: { ...row.mesh, submeshes },
        source: {
          ...row.source,
          gpuDrivenDraws: ids.map((drawItemIndex) => ({ drawItemIndex, materialSlot: 0 })),
        },
      },
    ],
    shadowCasterMembership: undefined,
  });
  const dispatch = new Map([
    [
      0,
      new Map([
        [
          1,
          [
            {
              passIndex: 0,
              materialShaderId: 'forgeax::default-standard-pbr',
            },
          ],
        ],
      ]),
    ],
  ]);
  let vertexBinds = 0;
  Object.assign(f.pass, {
    setVertexBuffer() {
      vertexBinds++;
    },
  });
  try {
    const recorded = recordShadowCasterDraws(
      f.context,
      f.pass,
      {} as never,
      {} as never,
      null,
      null,
      dispatch as never,
      new Set(claimed.map((id) => `1:1:${id}:0`)),
    );
    expect(f.draws()).toBe(expected.length);
    expect(vertexBinds).toBe(expected.length === 0 ? 0 : 1);
    expect([...recorded].sort()).toEqual(expected.map((id) => `1:1:${id}:0`).sort());
  } finally {
    f.dispose();
  }
});

it('matches legacy compact nonindexed geometry before topology filtering', async () => {
  const f = await fixture(0);
  const row = f.context.validatedOrdered[0];
  if (row === undefined) throw new Error('Missing shadow fixture row');
  const submeshes = [
    { topology: 'line-list', materialSlot: 0, vertexCount: 2 },
    { topology: 'triangle-list', materialSlot: 0, vertexCount: 3 },
    { topology: 'triangle-list', materialSlot: 0, vertexCount: 6 },
  ];
  Object.assign(f.context, {
    validatedOrdered: [
      {
        ...row,
        mesh: { ...row.mesh, indexed: false, submeshes },
        source: {
          ...row.source,
          gpuDrivenDraws: [
            { first: 2, count: 3, materialSlot: 0, topology: 'triangle-list' },
            { first: 5, count: 6, materialSlot: 0, topology: 'triangle-list' },
          ],
        },
      },
    ],
    shadowCasterMembership: undefined,
  });
  let draws = 0;
  Object.assign(f.pass, {
    draw() {
      draws++;
    },
  });
  const dispatch = new Map([
    [
      0,
      new Map([
        [
          1,
          [
            {
              passIndex: 0,
              materialShaderId: 'forgeax::default-standard-pbr',
            },
          ],
        ],
      ]),
    ],
  ]);
  try {
    const recorded = recordShadowCasterDraws(
      f.context,
      f.pass,
      {} as never,
      {} as never,
      null,
      null,
      dispatch as never,
      new Set(['1:1:0:0']),
    );
    expect(draws).toBe(1);
    expect([...recorded]).toEqual(['1:1:1:0']);
  } finally {
    f.dispose();
  }
});
