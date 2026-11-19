import type {
  BindGroup,
  Buffer,
  BufferDescriptor,
  RhiDevice,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import {
  buildWaterMeshView,
  buildWaterWaveUploadPlan,
  cookGerstnerWaveSet,
  WATER_BODY_DATA_STRIDE_BYTES,
  WATER_WAVE_LWC_TILE_LENGTH_M,
  type WaterWaveUploadBody,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import {
  createWaterMeshLayoutReceipt,
  isWaterMeshLayoutReceiptValid,
  WATER_MESH_INSTANCE_LAYOUT,
} from '@forgeax/engine-water/internal';
import { describe, expect, it, vi } from 'vitest';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { RendererContractFailureError } from '../errors/render';
import { getOrCreateHdrpBuffers, resetHdrpBuffers } from '../hdrp-buffers';
import {
  admitWaterMeshDraws,
  excludeWaterMeshRowsFromMaterialSelection,
  requireWaterRendererFrameNumber,
  selectedWaterMeshAdmissionDraws,
  waterMaterialRecordContext,
} from '../record/main-pass';
import type { _InternalRenderPipelineContext, RenderSystemRuntime } from '../record/render-context';
import {
  finalizeWaterMaterialAdmissionDraws,
  isOwnedWaterMeshAdmissionUpload,
  ownWaterMaterialAdmissionSource,
  ownWaterMaterialOwner,
  ownWaterMeshAdmissionDraw,
  projectWaterMeshAdmissionTiles,
  waterMeshAdmissionUpload,
} from '../water/mesh-source-admission';
import {
  buildWaterMaterialFrameUpload,
  buildWaterMeshInstanceUpload,
  createWaterMaterialFrameBindings,
  selectWaterMaterialFrameTargets,
  uploadWaterMaterialFrame,
  WATER_BODY_ONLY_BINDING_KEY,
  WATER_MESH_INSTANCE_STRIDE_BYTES,
  type WaterMaterialFrameBindings,
  waterMaterialBakedSourceBindings,
  waterMaterialDrawBinding,
  waterMaterialFrameBindGroupLayoutEntries,
  waterMaterialFrameBindingResources,
} from '../water/wave-material';
import { STANDARD_CLUSTER_TEST_ABI } from './cluster-test-abi';

const bodyA = 'body-a';
const bodyB = 'body-b';
const ownerA = waterBodyOwnerKey('water-test-world', bodyA, 4, 2);
const ownerB = waterBodyOwnerKey('water-test-world', bodyB, 7, 3);

describe('WaterMesh fragment bindings', () => {
  it('exposes the body flag, draw row, and tile records to the wireframe fragment', () => {
    const entries = waterMaterialFrameBindGroupLayoutEntries('rgba16float', 16);
    for (const binding of [16, 21, 22])
      expect(entries.find((entry) => entry.binding === binding)?.visibility).toBe(3);
  });
});

describe('WaterInfo submission frame alignment', () => {
  it('retains one lighting owner while held Water record contexts retain their own frame', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const create = vi.spyOn(device, 'createBuffer');
    const targetName = 'water-info:zone-a';
    const frames = new Map<number, WaterMaterialFrameBindings>();
    const source = {
      waterOwner: {
        guid: bodyA,
        generation: 4,
        worldIdentity: 'water-test-world',
        zoneGuid: 'zone-a',
        zoneGeneration: 2,
        targetFormat: 'rgba32float',
        viewIdentity: 'camera:1',
      },
    } as unknown as _InternalRenderPipelineContext['validatedOrdered'][number]['source'];
    const runtime = {
      device,
      deviceGeneration: 2,
      rendererFrameNumber: 9,
      standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
      errorRegistry: { fire: vi.fn() },
      getWaterMaterialFrameBindings: ({ frameGeneration }: { frameGeneration: number }) => {
        const frame = {
          waterInfoTargetName: targetName,
          bodyTargetNames: new Map([[ownerA, targetName]]),
          bodyTargetFormats: new Map([[ownerA, 'rgba32float']]),
          bodyIndices: new Map([[ownerA, 0]]),
          bodyGenerations: new Map([[ownerA, 4]]),
          bodyZoneGenerations: new Map([[ownerA, 2]]),
          bodyIndexDynamicOffsets: new Map([[ownerA, frameGeneration * 256]]),
          waterInfoDescriptorDynamicOffsets: new Map([[ownerA, 0]]),
          waterMeshInstanceOffsetAlignment: 64,
          waterMeshInstanceBytes: new Uint8Array(64),
          viewIdentity: 'camera:1',
          deviceGeneration: 2,
          frameGeneration,
        } as unknown as WaterMaterialFrameBindings;
        frames.set(frameGeneration, frame);
        return new Map([[targetName, frame]]);
      },
    } as unknown as RenderSystemRuntime;
    const context = {
      runtime,
      camera: { entityKey: 1, position: [0, 0, 5] },
      validatedOrdered: [{ renderableIndex: 0, source }],
      splitLdrSprite: false,
    } as unknown as _InternalRenderPipelineContext;
    const records: _InternalRenderPipelineContext[] = [];
    const lighting = [];
    try {
      for (const frameGeneration of [9, 10, 11, 12]) {
        runtime.rendererFrameNumber = frameGeneration;
        const record = waterMaterialRecordContext(context, undefined);
        records.push(record);
        lighting.push(getOrCreateHdrpBuffers(record.runtime, { x: 2, y: 2, z: 2 }));
      }
      expect(
        create.mock.calls.filter(([descriptor]) => descriptor.label?.startsWith('hdrp-')),
      ).toHaveLength(5);
      for (const [index, record] of records.entries()) {
        expect(record.runtime).toBe(runtime);
        expect(lighting[index]).toBe(lighting[0]);
        const binding = record.resolveWaterMaterialDrawBinding?.(source);
        expect(binding?.frameBindings).toBe(frames.get(index + 9));
        expect(binding?.dynamicOffset).toBe((index + 9) * 256);
      }
      expect(
        waterMaterialRecordContext({ ...context, validatedOrdered: [] }, undefined).runtime,
      ).toBe(runtime);
    } finally {
      for (const record of records) resetHdrpBuffers(record.runtime);
      create.mockRestore();
    }
  });

  it('uses the Renderer submission ID from the first frame through consecutive frames', () => {
    // The first graph settlement still reports 0 when Renderer submission 1 is recorded.
    expect(requireWaterRendererFrameNumber({ rendererFrameNumber: 1 })).toBe(1);
    expect(
      [2, 3].map((rendererFrameNumber) => requireWaterRendererFrameNumber({ rendererFrameNumber })),
    ).toEqual([2, 3]);
  });

  it('keeps the Renderer frame key independent of body and Zone generations', () => {
    const rendererFrameNumber = requireWaterRendererFrameNumber({ rendererFrameNumber: 6 });
    const changedBodyKey = waterBodyOwnerKey('water-test-world', bodyA, 5, 3);
    const targetName = 'water-info:zone-next';
    const draw = {
      renderableIndex: 7,
      owner: {
        guid: bodyA,
        generation: 5,
        worldIdentity: 'water-test-world',
        zoneGuid: 'zone-a',
        zoneGeneration: 3,
        targetFormat: 'rgba32float' as const,
        viewIdentity: 'view-a',
        drawKey: 'draw-a',
      },
      tiles: {
        drawKey: 'draw-a',
        bodyGuid: bodyA,
        bodyGeneration: 5,
        worldIdentity: 'water-test-world',
        zoneGeneration: 3,
        viewIdentity: 'view-a',
        bytes: new Uint8Array(96),
        coverageBytes: new Uint8Array(96),
        layout: {} as NonNullable<
          Parameters<typeof admitWaterMeshDraws>[0][number]['tiles']
        >['layout'],
        transitionTargets: [],
      },
    } satisfies Parameters<typeof admitWaterMeshDraws>[0][number];
    const frame = {
      waterInfoTargetName: targetName,
      waterInfoFormat: 'rgba32float',
      bodyTargetNames: new Map([[changedBodyKey, targetName]]),
      bodyTargetFormats: new Map([[changedBodyKey, 'rgba32float']]),
      bodyIndices: new Map([[changedBodyKey, 0]]),
      bodyGenerations: new Map([[changedBodyKey, 5]]),
      bodyZoneGenerations: new Map([[changedBodyKey, 3]]),
      bodyIndexDynamicOffsets: new Map([[changedBodyKey, 0]]),
      waterInfoDescriptorDynamicOffsets: new Map([[changedBodyKey, 0]]),
      waterMeshInstanceDynamicOffsets: new Map([['draw-a', 0]]),
      waterMeshTransitionTargetsByDraw: new Map([['draw-a', []]]),
      waterMeshInstanceOffsetAlignment: 64,
      waterMeshInstanceBindingSize: 64,
      waterMeshInstanceBytes: new Uint8Array(64),
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: rendererFrameNumber,
    } as unknown as WaterMaterialFrameBindings;

    expect(
      admitWaterMeshDraws([draw], new Map([[targetName, frame]]), {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        frameGeneration: rendererFrameNumber,
      }),
    ).toEqual(new Set());
    expect(() => requireWaterRendererFrameNumber({})).toThrow(RendererContractFailureError);
  });
});

describe('Water shadow record admission reuse', () => {
  it('keeps captured Water addresses and owners until the next frame requalifies live rows', () => {
    const f = waterRecordCacheFixture();
    try {
      const waterRow = f.rows[0];
      if (!waterRow) throw new Error('Expected accepted Water row');
      const ordinary = {
        renderableIndex: 1,
        source: ownWaterMaterialAdmissionSource({}) as typeof waterRow.source,
      };
      f.rows.push(ordinary);
      const closure = finalizeWaterMaterialAdmissionDraws(f.rows);
      const context = mutableWaterRecordContext(f, f.rows, closure);
      const first = waterMaterialRecordContext(context, f.waterFrame);
      waterRow.renderableIndex = 9;
      waterRow.source = ownWaterMaterialAdmissionSource({
        waterOwner: ownWaterMaterialOwner({
          ...f.owner,
          guid: bodyB,
          generation: 7,
        }),
      }) as typeof waterRow.source;
      f.rows.reverse();
      expect(waterMaterialRecordContext(context, f.waterFrame)).toBe(first);
      expect(closure?.draws).toEqual([{ renderableIndex: 0, owner: f.owner }]);
      f.runtime.rendererFrameNumber = 10;
      const next = waterMaterialRecordContext(context, f.waterFrame);
      expect(next).not.toBe(first);
      expect(next.validatedOrdered).toEqual([ordinary]);
      expect(closure?.draws).toEqual([{ renderableIndex: 0, owner: f.owner }]);
    } finally {
      f.dispose();
    }
  });

  it('resolves current graph views and invokes renderer callbacks on every pass while reusing admission', () => {
    const f = waterRecordCacheFixture();
    try {
      const first = waterMaterialRecordContext(f.context, f.waterFrame);
      const second = waterMaterialRecordContext(f.context, f.waterFrame);

      expect(second).toBe(first);
      expect(f.textureView).toHaveBeenCalledTimes(2);
      expect(f.getPublication).toHaveBeenCalledTimes(2);
      expect(f.getBindings).toHaveBeenCalledTimes(2);
      expect(f.getBindings.mock.calls[0]?.[0].waterMeshDrawsOwned).toBe(true);
      expect(f.getBindings.mock.calls[1]?.[0].waterMeshDraws).toBe(
        f.getBindings.mock.calls[0]?.[0].waterMeshDraws,
      );
    } finally {
      f.dispose();
    }
  });

  it('keeps resolver failures observable and requalifies replaced graph targets and TextureViews', () => {
    const f = waterRecordCacheFixture();
    try {
      const first = waterMaterialRecordContext(f.context, f.waterFrame);

      f.failTextureView = true;
      expect(() => waterMaterialRecordContext(f.context, f.waterFrame)).toThrow(
        'current WaterInfo view is unavailable',
      );
      f.failTextureView = false;

      f.resolvedView = {} as TextureView;
      const changedTextureView = waterMaterialRecordContext(f.context, f.waterFrame);
      expect(changedTextureView).not.toBe(first);

      const replacement = {};
      f.targets = new Map([
        [f.targetName, { view: replacement as never, format: 'rgba32float' as const }],
      ]);
      const changedGraphTarget = waterMaterialRecordContext(f.context, f.waterFrame);
      expect(changedGraphTarget).not.toBe(changedTextureView);
      expect(f.textureView).toHaveBeenCalledTimes(4);
      expect(f.getBindings).toHaveBeenCalledTimes(3);
    } finally {
      f.dispose();
    }
  });

  it.each([
    'frame',
    'view',
    'device',
    'pipeline',
    'origin',
    'publication',
    'binding-callback',
  ] as const)('does not reuse admission after %s changes', (change) => {
    const f = waterRecordCacheFixture();
    try {
      const first = waterMaterialRecordContext(f.context, f.waterFrame);
      switch (change) {
        case 'frame':
          f.runtime.rendererFrameNumber = 10;
          break;
        case 'view':
          f.camera.entityKey = 2;
          break;
        case 'device':
          Object.assign(f.runtime, { deviceGeneration: 3 });
          break;
        case 'pipeline':
          Object.assign(f.context, { pipelineState: {} });
          break;
        case 'origin':
          f.camera.position[0] = 20;
          break;
        case 'publication':
          f.replacePublication();
          break;
        case 'binding-callback':
          f.replaceBindingCallback();
          break;
      }

      const changed = waterMaterialRecordContext(f.context, f.waterFrame);
      expect(changed).not.toBe(first);
      expect(f.getBindings).toHaveBeenCalledTimes(2);
      if (change === 'frame') {
        // The legacy live path does not add a new publication lookup.
        expect(f.getPublication).toHaveBeenCalledTimes(1);
        expect(f.getBindings.mock.calls[1]?.[0].waterInfoPublication).toBeUndefined();
        expect(waterMaterialRecordContext(f.context, f.waterFrame)).not.toBe(changed);
        expect(f.getBindings).toHaveBeenCalledTimes(3);
      } else expect(f.getPublication).toHaveBeenCalledTimes(2);
    } finally {
      f.dispose();
    }
  });

  it('qualifies copied contexts independently and keeps borrowed getter sources on the live path', () => {
    const f = waterRecordCacheFixture();
    try {
      const first = waterMaterialRecordContext(f.context, f.waterFrame);
      const copied = { ...f.context, splitLdrSprite: true } as _InternalRenderPipelineContext;
      const changed = waterMaterialRecordContext(copied, f.waterFrame);
      expect(changed).not.toBe(first);
      expect(changed.splitLdrSprite).toBe(true);
      expect(f.getBindings).toHaveBeenCalledTimes(2);

      let getterReads = 0;
      const customSource =
        {} as _InternalRenderPipelineContext['validatedOrdered'][number]['source'];
      Object.defineProperty(customSource, 'waterOwner', {
        get: () => {
          getterReads++;
          return f.owner;
        },
      });
      const customRow = { renderableIndex: 4, source: customSource };
      const customRows = [customRow] as const;
      const customContext = {
        ...f.context,
        validatedOrdered: customRows,
        waterMaterialRecordCache: {
          validatedOrdered: customRows,
          frameGeneration: 9,
          drawClosure: undefined,
          candidate: undefined,
        },
      } as unknown as _InternalRenderPipelineContext;
      waterMaterialRecordContext(customContext, f.waterFrame);
      waterMaterialRecordContext(customContext, f.waterFrame);
      expect(getterReads).toBe(2);
      expect(f.getPublication).toHaveBeenCalledTimes(2);
      expect(f.getBindings).toHaveBeenCalledTimes(4);
      expect(
        f.getBindings.mock.calls
          .slice(2)
          .every(([input]) => input.waterMeshDrawsOwned === undefined),
      ).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it('keeps writable source associations live even when their current Water values are renderer-owned', () => {
    const f = waterRecordCacheFixture();
    try {
      const ownerSource = {
        waterOwner: f.owner,
      } as _InternalRenderPipelineContext['validatedOrdered'][number]['source'];
      const ownerRows = [{ renderableIndex: 0, source: ownerSource }] as const;
      const ownerClosure = finalizeWaterMaterialAdmissionDraws(ownerRows);
      expect(ownerClosure).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(ownerRows[0], 'source')?.writable).toBe(true);
      expect(Object.getOwnPropertyDescriptor(ownerRows[0], 'renderableIndex')?.writable).toBe(true);
      expect(Object.getOwnPropertyDescriptor(ownerSource, 'waterOwner')?.writable).toBe(true);
      const ownerContext = mutableWaterRecordContext(f, ownerRows, ownerClosure);
      waterMaterialRecordContext(ownerContext, f.waterFrame);
      Object.assign(ownerSource, {
        waterOwner: ownWaterMaterialOwner({
          guid: bodyB,
          generation: 7,
          worldIdentity: 'water-test-world',
          zoneGuid: 'zone-a',
          zoneGeneration: 2,
          targetFormat: 'rgba32float',
        }),
      });
      const changedOwner = waterMaterialRecordContext(ownerContext, f.waterFrame);
      expect(changedOwner.validatedOrdered).toEqual([]);
      expect(f.getBindings).toHaveBeenCalledTimes(2);
      expect(f.getPublication).not.toHaveBeenCalled();

      const tileOwner = ownWaterMaterialOwner({
        ...f.owner,
        viewIdentity: 'camera:1',
      });
      const firstTiles = ownedWaterTiles('mutable-draw-a');
      const secondTiles = ownedWaterTiles('mutable-draw-b');
      const tileSource = {
        waterOwner: tileOwner,
        waterMeshTiles: firstTiles,
      } as _InternalRenderPipelineContext['validatedOrdered'][number]['source'];
      const tileRows = [{ renderableIndex: 1, source: tileSource }] as const;
      const tileClosure = finalizeWaterMaterialAdmissionDraws(tileRows);
      expect(tileClosure).toBeUndefined();
      const tileContext = mutableWaterRecordContext(f, tileRows, tileClosure);
      waterMaterialRecordContext(tileContext, f.waterFrame);
      Object.assign(tileSource, { waterMeshTiles: secondTiles });
      const changedTiles = waterMaterialRecordContext(tileContext, f.waterFrame);
      expect(changedTiles.validatedOrdered).toBe(tileRows);
      expect(
        f.getBindings.mock.calls.slice(-2).map(([input]) => input.waterMeshDraws[0]?.drawKey),
      ).toEqual(['mutable-draw-a', 'mutable-draw-b']);
      expect(f.getPublication).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
});

it('captures immutable Water closure facts without sealing the mutable draw owner addresses', () => {
  const owner = ownWaterMaterialOwner({
    guid: bodyA,
    generation: 4,
    worldIdentity: 'water-test-world',
    zoneGuid: 'zone-a',
    zoneGeneration: 2,
    targetFormat: 'rgba32float',
  });
  const source = ownWaterMaterialAdmissionSource({
    waterOwner: owner,
  }) as _InternalRenderPipelineContext['validatedOrdered'][number]['source'];
  const row = { renderableIndex: 3, source };
  const rows = [row];
  const first = finalizeWaterMaterialAdmissionDraws(rows);
  expect(first?.draws).toEqual([{ renderableIndex: 3, owner }]);
  row.renderableIndex = 9;
  const second = finalizeWaterMaterialAdmissionDraws(rows);
  expect(second?.draws).toEqual([{ renderableIndex: 9, owner }]);
  expect(first?.draws[0]?.renderableIndex).toBe(3);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first?.draws)).toBe(true);
  expect(Object.isFrozen(first?.draws[0])).toBe(true);
  expect(Object.isFrozen(first?.uploads)).toBe(true);
  expect(Object.isFrozen(rows)).toBe(false);
  expect(Object.getOwnPropertyDescriptor(row, 'source')?.writable).toBe(true);
});

function waterRecordCacheFixture() {
  const targetName = 'water-info:record-cache';
  const owner = ownWaterMaterialOwner({
    guid: bodyA,
    generation: 4,
    worldIdentity: 'water-test-world',
    zoneGuid: 'zone-a',
    zoneGeneration: 2,
    targetFormat: 'rgba32float',
  });
  const source = ownWaterMaterialAdmissionSource({
    waterOwner: owner,
  }) as _InternalRenderPipelineContext['validatedOrdered'][number]['source'];
  const rows = [{ renderableIndex: 0, source }];
  const drawClosure = finalizeWaterMaterialAdmissionDraws(rows);
  const camera = { entityKey: 1, position: [0, 0, 5] as [number, number, number] };
  const graphView = {};
  const publicationFor = new Map<string, object>();
  const bindingsFor = new Map<string, ReadonlyMap<string, WaterMaterialFrameBindings>>();
  let currentPublication = {};
  let resolvedView = {} as TextureView;
  let failTextureView = false;
  let targets: ReadonlyMap<string, Readonly<{ view: never; format: 'rgba32float' }>> = new Map([
    [targetName, { view: graphView as never, format: 'rgba32float' }],
  ]);
  const textureView = vi.fn((_view: unknown) =>
    failTextureView
      ? err(new Error('current WaterInfo view is unavailable') as never)
      : ok(resolvedView),
  );
  const waterFrame = {
    resources: { textureView },
    get targets() {
      return targets;
    },
  } as never;
  const getPublication = vi.fn(
    (viewIdentity: string, frameGeneration: number, deviceGeneration: number) => {
      const key = JSON.stringify([viewIdentity, frameGeneration, deviceGeneration]);
      let publication = publicationFor.get(key);
      if (publication === undefined) {
        publication = Object.freeze({
          viewIdentity,
          frameGeneration,
          deviceGeneration,
          token: currentPublication,
        });
        publicationFor.set(key, publication);
      }
      return publication as never;
    },
  );
  const getBindings = vi.fn(
    (input: Parameters<NonNullable<RenderSystemRuntime['getWaterMaterialFrameBindings']>>[0]) => {
      const drawKeys = input.waterMeshDraws.map((draw) => draw.drawKey).sort();
      const key = JSON.stringify([
        input.viewIdentity,
        input.frameGeneration,
        input.deviceGeneration,
        drawKeys,
      ]);
      let bindings = bindingsFor.get(key);
      if (bindings === undefined) {
        const bodyKey = waterBodyOwnerKey('water-test-world', bodyA, 4, 2);
        const frame = {
          waterInfoTargetName: targetName,
          bodyTargetNames: new Map([[bodyKey, targetName]]),
          bodyTargetFormats: new Map([[bodyKey, 'rgba32float']]),
          bodyIndices: new Map([[bodyKey, 0]]),
          bodyGenerations: new Map([[bodyKey, 4]]),
          bodyZoneGenerations: new Map([[bodyKey, 2]]),
          bodyIndexDynamicOffsets: new Map([[bodyKey, 0]]),
          waterInfoDescriptorDynamicOffsets: new Map([[bodyKey, 0]]),
          waterMeshInstanceOffsetAlignment: 64,
          waterMeshInstanceDynamicOffsets: new Map(drawKeys.map((drawKey) => [drawKey, 0])),
          waterMeshTransitionTargetsByDraw: new Map(drawKeys.map((drawKey) => [drawKey, []])),
          waterMeshInstanceBytes: new Uint8Array(0),
          viewIdentity: input.viewIdentity,
          deviceGeneration: input.deviceGeneration,
          frameGeneration: input.frameGeneration,
        } as unknown as WaterMaterialFrameBindings;
        bindings = new Map([[targetName, frame]]);
        bindingsFor.set(key, bindings);
      }
      return bindings;
    },
  );
  const runtime = {
    rendererFrameNumber: 9,
    deviceGeneration: 2,
    getWaterMaterialFramePublication: getPublication,
    getWaterMaterialFrameBindings: getBindings,
  } as unknown as RenderSystemRuntime;
  const context = {
    runtime,
    camera,
    pipelineState: {},
    validatedOrdered: rows,
    splitLdrSprite: false,
    waterMaterialRecordCache: {
      validatedOrdered: rows,
      frameGeneration: 9,
      drawClosure,
      candidate: undefined,
    },
  } as unknown as _InternalRenderPipelineContext;
  return {
    targetName,
    owner,
    rows,
    context,
    runtime,
    camera,
    waterFrame,
    textureView,
    getPublication,
    getBindings,
    get targets() {
      return targets;
    },
    set targets(value: typeof targets) {
      targets = value;
    },
    get resolvedView() {
      return resolvedView;
    },
    set resolvedView(value: TextureView) {
      resolvedView = value;
    },
    get failTextureView() {
      return failTextureView;
    },
    set failTextureView(value: boolean) {
      failTextureView = value;
    },
    replacePublication() {
      currentPublication = {};
      publicationFor.clear();
    },
    replaceBindingCallback() {
      Object.assign(runtime, {
        getWaterMaterialFrameBindings: (input: Parameters<typeof getBindings>[0]) =>
          getBindings(input),
      });
    },
    dispose() {},
  };
}

function mutableWaterRecordContext(
  fixture: ReturnType<typeof waterRecordCacheFixture>,
  rows: Parameters<typeof finalizeWaterMaterialAdmissionDraws>[0],
  drawClosure: ReturnType<typeof finalizeWaterMaterialAdmissionDraws>,
): _InternalRenderPipelineContext {
  return {
    ...fixture.context,
    validatedOrdered: rows,
    waterMaterialRecordCache: {
      validatedOrdered: rows,
      frameGeneration: 9,
      drawClosure,
      candidate: undefined,
    },
  } as _InternalRenderPipelineContext;
}

function ownedWaterTiles(drawKey: string) {
  const draw = waterMeshDraws()[0];
  if (draw === undefined) throw new Error('WaterMesh association fixture has no draw');
  const owned = ownWaterMeshAdmissionDraw(
    {
      guid: bodyA,
      generation: 4,
      worldIdentity: 'water-test-world',
      zoneGeneration: 2,
    },
    'camera:1',
    { ...draw, drawKey },
  );
  return projectWaterMeshAdmissionTiles(
    {
      drawKey,
      bodyGuid: bodyA,
      bodyGeneration: 4,
      worldIdentity: 'water-test-world',
      zoneGeneration: 2,
      viewIdentity: 'camera:1',
      bytes: owned.bytes,
      coverageBytes: owned.coverageBytes,
      layout: owned.layout,
      transitionTargets: owned.transitionTargets,
    },
    owned,
  );
}

function waterPlan(
  targetZoneGeneration = 3,
  targetBaseHeightM = 3,
  targetSupportsWaves = false,
  targetBodyGuid = bodyB,
) {
  const cooked = cookGerstnerWaveSet({
    kind: 'water-wave-set',
    sourceMode: 'predefined',
    waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.5, steepness: 0.25 }],
    inputDigest: 'a'.repeat(64),
    depthMaskM: 4,
    maxWaveHeightM: 0.5,
    timeSource: 'scene-clock',
  });
  if (!cooked.ok) throw new Error('Water wave test fixture failed to cook');
  const fixedBody: WaterWaveUploadBody = {
    worldId: 1,
    worldIdentity: 'water-test-world',
    bodyGuid: bodyA,
    waveSetGuid: 'wave-set-a',
    bodyGeneration: 4,
    zoneGeneration: 2,
    waveSet: cooked.value,
    timeSeconds: 2,
    previousTimeSeconds: 1,
    baseHeightM: 3,
    tileOriginWorldXZ: [0, 0],
    tileLengthM: WATER_WAVE_LWC_TILE_LENGTH_M,
    heightSource: { kind: 'fixed', fixedHeightM: 3, fixedDepthM: 12, fixedVelocityXZ: [1, 2] },
    supportsWaves: true,
    usesFlatSurfaceHeight: false,
    meshEdgeOverlayEnabled: false,
  };
  const bakedBody: WaterWaveUploadBody = {
    worldId: fixedBody.worldId,
    worldIdentity: fixedBody.worldIdentity,
    bodyGuid: targetBodyGuid,
    ...(targetSupportsWaves ? { waveSetGuid: 'wave-set-b' } : {}),
    bodyGeneration: 7,
    zoneGeneration: targetZoneGeneration,
    waveSet: targetSupportsWaves ? cooked.value : { ...cooked.value, waves: [], maxWaveHeightM: 0 },
    timeSeconds: fixedBody.timeSeconds,
    previousTimeSeconds: fixedBody.previousTimeSeconds,
    baseHeightM: targetBaseHeightM,
    tileOriginWorldXZ: targetSupportsWaves ? [1, 2] : fixedBody.tileOriginWorldXZ,
    tileLengthM: fixedBody.tileLengthM,
    supportsWaves: targetSupportsWaves,
    usesFlatSurfaceHeight: true,
    meshEdgeOverlayEnabled: false,
    heightSource: {
      kind: 'baked',
      zoneIndex: 1,
      slice: 2,
      fixedHeightM: targetBaseHeightM,
      fixedDepthM: fixedBody.heightSource.fixedDepthM,
      fixedVelocityXZ: fixedBody.heightSource.fixedVelocityXZ,
    },
    bakedGrid: {
      originXZ: [0, 0],
      originY: 10,
      spacingXZ: [2, 2],
      width: 3,
      height: 3,
      samples: new Float32Array(Array.from({ length: 36 }, (_, index) => index + 0.25)),
      lineage: {
        version: 'water-river-bake/1',
        textureGuid: 'baked-texture',
        textureRevision: 19,
        sourceRecipeGuid: 'bake-recipe',
        sourceRecipeVersion: 'sha256:bake-recipe',
        sourceBodyGuid: targetBodyGuid,
        sourceBodyGeneration: 7,
        simulationGeneration: 2,
        sequence: 3,
        frameId: 4,
        deviceGeneration: 5,
        graphGeneration: 6,
      },
    },
  };
  const result = buildWaterWaveUploadPlan([fixedBody, bakedBody]);
  if (!result.ok) throw new Error(`Water wave plan fixture failed: ${result.error.code}`);
  return result.value;
}

function waterMeshDraws(withTransition = false, targetBodyGuid = bodyB) {
  const view = buildWaterMeshView(
    {
      zoneGuid: 'zone-a',
      zoneGeneration: 2,
      originXZ: [0, 0],
      extentM: [8, 8],
      tileSizeM: 4,
      tessellationFactor: 1,
      lodScale: 1,
      bodies: withTransition
        ? [
            {
              guid: bodyA,
              generation: 4,
              type: 'river' as const,
              visible: true,
              affectsWaterMesh: true,
              priority: 1,
              materialKey: 'river',
              transitionMaterials: { lake: 'river-lake' },
              waveOriginXZ: [0, 0] as const,
              baseHeightM: 3,
              maxWaveHeightM: 0.5,
              polygon: {
                outer: [
                  [0, 0],
                  [8, 0],
                  [8, 8],
                  [0, 8],
                ] as const,
              },
            },
            {
              guid: targetBodyGuid,
              generation: 7,
              type: 'lake' as const,
              visible: true,
              affectsWaterMesh: true,
              priority: 2,
              materialKey: 'lake',
              waveOriginXZ: [1, 2] as const,
              baseHeightM: 100,
              maxWaveHeightM: 0.5,
              polygon: {
                outer: [
                  [0, 0],
                  [4, 0],
                  [4, 8],
                  [0, 8],
                ] as const,
              },
            },
          ]
        : [
            {
              guid: bodyA,
              generation: 4,
              type: 'lake',
              visible: true,
              affectsWaterMesh: true,
              priority: 1,
              materialKey: 'water',
              waveOriginXZ: [0, 0],
              baseHeightM: 3,
              maxWaveHeightM: 0.5,
              polygon: {
                outer: [
                  [0, 0],
                  [8, 0],
                  [8, 8],
                  [0, 8],
                ],
              },
            },
          ],
    },
    { viewId: 'view-a', observerM: [4, 10, 4] },
  );
  if (!view.ok) throw new Error('WaterMesh test fixture failed to build');
  const ownerDraw = view.value.buckets
    .flatMap((bucket) => bucket.ownerDraws)
    .find(
      (draw) =>
        draw.ownerGuid === bodyA &&
        (!withTransition ||
          draw.instances.some((instance) => instance.transitionBodyGuid === targetBodyGuid)),
    );
  if (ownerDraw === undefined) throw new Error('WaterMesh fixture has no owner draw');
  const draw = {
    drawKey: ownerDraw.drawKey,
    bodyGuid: ownerA,
    bodyGeneration: ownerDraw.ownerGeneration,
    zoneGeneration: view.value.zoneGeneration,
    viewIdentity: view.value.viewId,
    transitionTargets: ownerDraw.instances.flatMap((instance, instanceIndex) =>
      instance.transitionBodyGuid === undefined || instance.transitionBodyGeneration === undefined
        ? []
        : [
            {
              instanceIndex,
              bodyGuid: waterBodyOwnerKey(
                'water-test-world',
                instance.transitionBodyGuid,
                instance.transitionBodyGeneration,
                view.value.zoneGeneration,
              ),
              bodyGeneration: instance.transitionBodyGeneration,
              zoneGeneration: view.value.zoneGeneration,
            },
          ],
    ),
    bytes: ownerDraw.instanceBytes,
    coverageBytes: ownerDraw.coverageBytes,
    layout: ownerDraw.layout,
  };
  return [draw, { ...draw, drawKey: `${draw.drawKey}:second` }] as const;
}

function uploadFixture() {
  const plan = waterPlan();
  const descriptorA = Uint8Array.from({ length: 48 }, (_, index) => index + 1);
  const descriptorB = Uint8Array.from({ length: 48 }, (_, index) => 200 - index);
  const draws = waterMeshDraws();
  const upload = buildWaterMaterialFrameUpload(
    plan,
    new Map([
      [ownerB, descriptorB],
      [ownerA, descriptorA],
    ]),
    draws,
    64,
  );
  return { plan, descriptorA, descriptorB, draws, upload };
}

function bufferDevice(failAt?: string) {
  const created: Buffer[] = [];
  const descriptors: BufferDescriptor[] = [];
  const destroyed: Buffer[] = [];
  const writes = vi.fn<RhiDevice['queue']['writeBuffer']>(() => ok(undefined));
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'Water material buffer allocation succeeds',
    hint: 'retry after repairing the test device',
  });
  const createBuffer = vi.fn((descriptor: BufferDescriptor) => {
    descriptors.push(descriptor);
    if (descriptor.label === failAt) return err(failure);
    const buffer = { id: created.length + 1 } as unknown as Buffer;
    created.push(buffer);
    return ok(buffer);
  });
  const device = {
    createBuffer,
    destroyBuffer: vi.fn((buffer: Buffer) => {
      destroyed.push(buffer);
      return ok(undefined);
    }),
    queue: { writeBuffer: writes },
  } as unknown as Pick<RhiDevice, 'createBuffer' | 'destroyBuffer' | 'queue'>;
  return { device, created, descriptors, destroyed, writes, failure };
}

describe('Water material frame ABI', () => {
  it('refreshes an independent-only cache when an actual Info view arrives within the same frame', () => {
    const { upload } = uploadFixture();
    const gpu = bufferDevice();
    const buffers = uploadWaterMaterialFrame(gpu.device, upload).unwrap();
    const independent = {
      ...waterMaterialFrameBindingResources({
        upload,
        buffers,
        bodyTargetNames: new Map(),
        bodyTargetFormats: new Map(),
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        frameGeneration: 9,
      }),
      bindGroup: {} as BindGroup,
    };
    const bindings = new Map([[WATER_BODY_ONLY_BINDING_KEY, independent]]);
    expect(selectWaterMaterialFrameTargets(bindings, new Map())).toBe(bindings);
    const view = {} as TextureView;
    const targetName = 'water-info:zone-a';
    const views = new Map([[targetName, view]]);
    expect(selectWaterMaterialFrameTargets(bindings, views)).toBeUndefined();
    const complete = new Map([
      ...bindings,
      [targetName, { ...independent, waterInfoTextureView: view }],
    ]);
    expect(selectWaterMaterialFrameTargets(complete, views)).toBe(complete);
    expect(
      selectWaterMaterialFrameTargets(complete, new Map([[targetName, {} as TextureView]])),
    ).toBeUndefined();
    expect(selectWaterMaterialFrameTargets(complete, new Map())).toEqual(bindings);
    expect(
      waterMaterialDrawBinding(bindings, ownerA, {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        frameGeneration: 9,
        bodyGeneration: 4,
        zoneGeneration: 2,
      }).ok,
    ).toBe(true);
  });

  it.each([
    'owner',
    'transition',
  ] as const)('keeps independent Body inputs usable while a WaterMesh %s waits for WaterInfo', (pending) => {
    const plan = waterPlan(2);
    const targetBody = waterBodyOwnerKey('water-test-world', bodyB, 7, 2);
    const targetName = 'water-info:zone-a';
    const bodyTargetNames = new Map(pending === 'transition' ? [[ownerA, targetName]] : []);
    const upload = buildWaterMaterialFrameUpload(
      plan,
      new Map(pending === 'transition' ? [[ownerA, new Uint8Array(48)]] : []),
      [],
      64,
    );
    const gpu = bufferDevice();
    const buffers = uploadWaterMaterialFrame(gpu.device, upload).unwrap();
    const resources = {
      upload,
      buffers,
      bodyTargetNames,
      bodyTargetFormats: new Map(
        pending === 'transition' ? [[ownerA, 'rgba16float' as const]] : [],
      ),
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: 9,
    };
    const independent = {
      ...waterMaterialFrameBindingResources(resources),
      bindGroup: {} as BindGroup,
    };
    const bindings = new Map([['body-only', independent]]);
    if (pending === 'transition')
      bindings.set(targetName, {
        ...waterMaterialFrameBindingResources({
          ...resources,
          waterInfoTargetName: targetName,
          waterInfoFormat: 'rgba16float',
          waterInfoTextureView: {} as TextureView,
          waterInfoSampler: {} as Sampler,
          waterInfoContentFrameGeneration: 9,
          waterInfoContentGraphResourceVersion: 'info-9',
        }),
        bindGroup: {} as BindGroup,
      });
    const expected = { viewIdentity: 'view-a', deviceGeneration: 2, frameGeneration: 9 };
    for (const [bodyGuid, bodyGeneration] of [
      [ownerA, 4],
      [targetBody, 7],
    ] as const) {
      const ordinary = waterMaterialDrawBinding(bindings, bodyGuid, {
        ...expected,
        bodyGeneration,
        zoneGeneration: 2,
      });
      expect(ordinary.ok).toBe(true);
    }
    expect(independent.bakedDescriptorBytes).toEqual(plan.bakedDescriptorBuffer);
    const draw = waterMeshDraws(pending === 'transition')[0];
    const generated = {
      renderableIndex: 7,
      owner: {
        guid: bodyA,
        generation: 4,
        worldIdentity: 'water-test-world',
        zoneGeneration: 2,
        zoneGuid: 'zone-a',
        viewIdentity: 'view-a',
        targetFormat: 'rgba16float' as const,
        drawKey: draw.drawKey,
      },
      tiles: {
        ...draw,
        bodyGuid: bodyA,
        worldIdentity: 'water-test-world',
        transitionTargets: draw.transitionTargets.map((target) => ({ ...target, bodyGuid: bodyB })),
      },
    } satisfies Parameters<typeof admitWaterMeshDraws>[0][number];
    expect(admitWaterMeshDraws([generated], bindings, expected)).toEqual(new Set([7]));
  });

  it('skips WaterMesh rows with unavailable bindings and keeps ordinary rows admitted', () => {
    const waterDraw = {
      renderableIndex: 7,
      owner: {
        guid: bodyA,
        generation: 4,
        worldIdentity: 'water-test-world',
        zoneGuid: 'zone-a',
        zoneGeneration: 2,
        targetFormat: 'rgba32float' as const,
        viewIdentity: 'view-a',
        drawKey: 'draw-a',
      },
      tiles: {
        drawKey: 'draw-a',
        bodyGuid: bodyA,
        bodyGeneration: 4,
        worldIdentity: 'water-test-world',
        zoneGeneration: 2,
        viewIdentity: 'view-a',
        bytes: new Uint8Array(96),
        coverageBytes: new Uint8Array(96),
        layout: {} as NonNullable<
          Parameters<typeof admitWaterMeshDraws>[0][number]['tiles']
        >['layout'],
        transitionTargets: [],
      },
    } satisfies Parameters<typeof admitWaterMeshDraws>[0][number];
    const staleUnselectedDraw = {
      ...waterDraw,
      renderableIndex: 9,
      owner: { ...waterDraw.owner, viewIdentity: 'old-view' },
      tiles: { ...waterDraw.tiles, viewIdentity: 'old-view' },
    };
    const selectedWaterDraws = selectedWaterMeshAdmissionDraws(
      [waterDraw, staleUnselectedDraw],
      new Map([[waterDraw.renderableIndex, new Set([41])]]),
    );
    expect(selectedWaterDraws).toEqual([waterDraw]);
    const excluded = admitWaterMeshDraws(selectedWaterDraws, undefined, {
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: 9,
    });
    expect(excluded.has(waterDraw.renderableIndex)).toBe(true);

    const unpublishedFrame = {
      waterInfoTargetName: 'water-info:unpublished',
      bodyTargetNames: new Map(),
      bodyIndices: new Map(),
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: 9,
    } as unknown as WaterMaterialFrameBindings;
    expect(
      admitWaterMeshDraws([waterDraw], new Map([['water-info:unpublished', unpublishedFrame]]), {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        frameGeneration: 9,
      }).has(waterDraw.renderableIndex),
    ).toBe(true);

    const selection = excludeWaterMeshRowsFromMaterialSelection(
      {
        validatedOrdered: [{ renderableIndex: 7 }, { renderableIndex: 8 }],
        materialSlotIndices: { at: () => [0] },
        materialSlots: [{ materialHandle: 41 }],
      } as unknown as Parameters<typeof excludeWaterMeshRowsFromMaterialSelection>[0],
      null,
      excluded,
    );
    expect(selection?.has(7)).toBe(false);
    expect(selection?.get(8)?.has(41)).toBe(true);

    const targetName = 'water-info:zone-a';
    const staleFrame = {
      waterInfoTargetName: targetName,
      bodyTargetNames: new Map([[ownerA, targetName]]),
      bodyIndices: new Map([[ownerA, 0]]),
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: 8,
    } as unknown as WaterMaterialFrameBindings;
    expect(() =>
      admitWaterMeshDraws([waterDraw], new Map([[targetName, staleFrame]]), {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        frameGeneration: 9,
      }),
    ).toThrow(GpuDrivenPreparationError);

    const incompleteFrame = {
      waterInfoTargetName: targetName,
      bodyTargetNames: new Map([[ownerA, targetName]]),
      bodyTargetFormats: new Map([[ownerA, 'rgba32float']]),
      bodyIndices: new Map([[ownerA, 0]]),
      bodyGenerations: new Map([[ownerA, 4]]),
      bodyZoneGenerations: new Map([[ownerA, 2]]),
      waterInfoDescriptorDynamicOffsets: new Map([[ownerA, 0]]),
      bodyIndexDynamicOffsets: new Map(),
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: 9,
    } as unknown as WaterMaterialFrameBindings;
    let incompleteError: unknown;
    try {
      admitWaterMeshDraws([waterDraw], new Map([[targetName, incompleteFrame]]), {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        frameGeneration: 9,
      });
    } catch (error) {
      incompleteError = error;
    }
    expect(incompleteError).toBeInstanceOf(GpuDrivenPreparationError);
    expect((incompleteError as GpuDrivenPreparationError).code).toBe('resource-not-ready');

    const targetPublishedWithoutBody = {
      waterInfoTargetName: targetName,
      bodyTargetNames: new Map([[ownerA, targetName]]),
      bodyIndices: new Map(),
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: 9,
    } as unknown as WaterMaterialFrameBindings;
    let missingBodyError: unknown;
    try {
      admitWaterMeshDraws([waterDraw], new Map([[targetName, targetPublishedWithoutBody]]), {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        frameGeneration: 9,
      });
    } catch (error) {
      missingBodyError = error;
    }
    expect(missingBodyError).toBeInstanceOf(GpuDrivenPreparationError);
    expect((missingBodyError as GpuDrivenPreparationError).code).toBe('resource-not-ready');
  });

  it('packs body, wave, draw, WaterInfo and baked data with aligned per-owner rows', () => {
    const { plan, descriptorA, descriptorB, draws, upload } = uploadFixture();
    expect(upload.bodyData).toEqual(plan.bodyBuffer);
    expect(upload.waveData).toEqual(plan.waveBuffer);
    expect(upload.bakedDescriptors).toEqual(plan.bakedDescriptorBuffer);
    expect(upload.bakedSamples).toEqual(plan.bakedSamplesBuffer);
    expect(upload.bodyData).toHaveLength(2 * WATER_BODY_DATA_STRIDE_BYTES);
    expect(upload.waveData).toHaveLength(48);
    expect(upload.bakedDescriptors).toHaveLength(2 * 48);
    expect(upload.bakedSamples).toHaveLength(3 * 3 * 4 * 4);
    expect(upload.bakedSources).toEqual([
      {
        bodyIndex: 1,
        worldIdentity: 'water-test-world',
        bodyGuid: bodyB,
        bodyGeneration: 7,
        zoneGeneration: 3,
        descriptorRange: [48, 96],
        sampleRange: [0, 144],
        lineage: {
          version: 'water-river-bake/1',
          textureGuid: 'baked-texture',
          textureRevision: 19,
          sourceRecipeGuid: 'bake-recipe',
          sourceRecipeVersion: 'sha256:bake-recipe',
          sourceBodyGuid: bodyB,
          sourceBodyGeneration: 7,
          simulationGeneration: 2,
          sequence: 3,
          frameId: 4,
          deviceGeneration: 5,
          graphGeneration: 6,
        },
      },
    ]);
    const bodyBytes = new DataView(upload.bodyData.buffer);
    expect(bodyBytes.getUint32(8, true)).toBe(4);
    expect(bodyBytes.getUint32(WATER_BODY_DATA_STRIDE_BYTES + 8, true)).toBe(7);
    expect(bodyBytes.getUint32(WATER_BODY_DATA_STRIDE_BYTES + 96, true)).toBe(4);
    expect(bodyBytes.getUint32(WATER_BODY_DATA_STRIDE_BYTES + 100, true)).toBe(1);
    expect(bodyBytes.getUint32(WATER_BODY_DATA_STRIDE_BYTES + 104, true)).toBe(2);
    for (const bodyOffset of [0, WATER_BODY_DATA_STRIDE_BYTES]) {
      expect(
        [80, 84, 88, 92].map((offset) => bodyBytes.getFloat32(bodyOffset + offset, true)),
      ).toEqual([3, 12, 1, 2]);
    }
    const waveBytes = new DataView(upload.waveData.buffer);
    expect(waveBytes.getFloat32(0, true)).toBe(1);
    expect(waveBytes.getFloat32(8, true)).toBe(0.5);
    const bakedDescriptorBytes = new DataView(upload.bakedDescriptors.buffer);
    expect(bakedDescriptorBytes.getUint32(48 + 32, true)).toBe(3);
    expect(bakedDescriptorBytes.getUint32(48 + 36, true)).toBe(3);
    expect(bakedDescriptorBytes.getUint32(48 + 44, true)).toBe(1);
    expect(new DataView(upload.bakedSamples.buffer).getFloat32(0, true)).toBe(0.25);

    expect(upload.drawData).toHaveLength(2 * 256);
    expect(new DataView(upload.drawData.buffer).getUint32(0, true)).toBe(0);
    expect(new DataView(upload.drawData.buffer).getUint32(256, true)).toBe(1);
    expect(upload.bodyIndexDynamicOffsets.get(ownerA)).toBe(0);
    expect(upload.bodyIndexDynamicOffsets.get(ownerB)).toBe(256);

    expect(upload.waterInfoDescriptors).toHaveLength(2 * 256);
    expect(upload.waterInfoDescriptorDynamicOffsets.get(ownerA)).toBe(0);
    expect(upload.waterInfoDescriptorDynamicOffsets.get(ownerB)).toBe(256);
    expect(upload.waterInfoDescriptors.slice(0, 48)).toEqual(descriptorA);
    expect(upload.waterInfoDescriptors.slice(256, 304)).toEqual(descriptorB);

    const firstLength = draws[0].bytes.byteLength + draws[0].coverageBytes.byteLength;
    const firstOffset = 64;
    const secondOffset = Math.ceil((firstOffset + firstLength) / 64) * 64;
    expect(upload.waterMeshInstances.dynamicOffsets.get(draws[0].drawKey)).toBe(firstOffset);
    expect(upload.waterMeshInstances.dynamicOffsets.get(draws[1].drawKey)).toBe(secondOffset);
    expect(secondOffset % 64).toBe(0);
    expect(upload.waterMeshInstances.bindingSize).toBe(firstLength);
    expect(upload.waterMeshInstances.bytes.slice(0, firstOffset)).toEqual(
      new Uint8Array(firstOffset),
    );
    expect(
      upload.waterMeshInstances.bytes.slice(firstOffset, firstOffset + draws[0].bytes.length),
    ).toEqual(draws[0].bytes);
    expect(
      upload.waterMeshInstances.bytes.slice(
        firstOffset + draws[0].bytes.length,
        firstOffset + draws[0].bytes.length + draws[0].coverageBytes.length,
      ),
    ).toEqual(draws[0].coverageBytes);
    const orderedDraws = [...draws].sort((a, b) => a.drawKey.localeCompare(b.drawKey));
    const expectedCoverage = new Uint8Array(
      orderedDraws.reduce((sum, draw) => sum + draw.coverageBytes.byteLength, 0),
    );
    let expectedCoverageOffset = 0;
    for (const draw of orderedDraws) {
      expectedCoverage.set(draw.coverageBytes, expectedCoverageOffset);
      expectedCoverageOffset += draw.coverageBytes.byteLength;
    }
    expect(upload.waterMeshInstances.layout).toEqual(
      createWaterMeshLayoutReceipt(upload.waterMeshInstances.bytes, expectedCoverage),
    );
    expect(
      isWaterMeshLayoutReceiptValid(
        upload.waterMeshInstances.layout,
        upload.waterMeshInstances.bytes,
        expectedCoverage,
      ),
    ).toBe(true);
    const independent = buildWaterMaterialFrameUpload(plan, new Map(), [], 64);
    expect(independent.bodyData).toEqual(plan.bodyBuffer);
    expect(independent.waterInfoDescriptorDynamicOffsets.size).toBe(0);
    expect(() => buildWaterMaterialFrameUpload(plan, new Map(), draws, 64)).toThrow(
      'is missing its same-view owner WaterInfo descriptor',
    );
    expect(() =>
      buildWaterMaterialFrameUpload(
        plan,
        new Map([
          [ownerA, descriptorA],
          [ownerB, descriptorB],
        ]),
        [],
        3,
      ),
    ).toThrow('power-of-two alignment');
  });

  it('validates borrowed source bytes and preserves non-zero byte offsets in frame packing', () => {
    const plan = waterPlan();
    const source = waterMeshDraws()[0];
    if (source === undefined) throw new Error('WaterMesh test fixture has no draw');
    const byteStorage = new Uint8Array(source.bytes.byteLength + 13);
    const bytes = byteStorage.subarray(5, 5 + source.bytes.byteLength);
    bytes.set(source.bytes);
    const coverageStorage = new Uint8Array(source.coverageBytes.byteLength + 9);
    const coverageBytes = coverageStorage.subarray(3, 3 + source.coverageBytes.byteLength);
    coverageBytes.set(source.coverageBytes);
    const draw = {
      ...source,
      bytes,
      coverageBytes,
      layout: createWaterMeshLayoutReceipt(bytes, coverageBytes),
    };
    const descriptor = new Uint8Array(48);
    const upload = buildWaterMaterialFrameUpload(plan, new Map([[ownerA, descriptor]]), [draw], 64);
    const offset = upload.waterMeshInstances.dynamicOffsets.get(draw.drawKey);
    if (offset === undefined) throw new Error('WaterMesh source fixture has no packed offset');
    expect(upload.waterMeshInstances.bytes.slice(offset, offset + bytes.byteLength)).toEqual(bytes);
    expect(
      upload.waterMeshInstances.bytes.slice(
        offset + bytes.byteLength,
        offset + bytes.byteLength + coverageBytes.byteLength,
      ),
    ).toEqual(coverageBytes);

    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() => buildWaterMeshInstanceUpload([draw], 64)).toThrow(
      'stale or invalid instance layout receipt',
    );
    expect(() =>
      buildWaterMaterialFrameUpload(plan, new Map([[ownerA, descriptor]]), [draw], 3),
    ).toThrow('stale or invalid instance layout receipt');
    expect(() => buildWaterMaterialFrameUpload(plan, new Map(), [draw], 3)).toThrow(
      'missing its same-view owner WaterInfo descriptor',
    );
  });

  it('detaches borrowed transition bytes before reading a custom wave plan', () => {
    const targetOwner = waterBodyOwnerKey('water-test-world', bodyB, 7, 2);
    const plan = waterPlan(2, 100, true, bodyB);
    const draw = waterMeshDraws(true, bodyB)[0];
    if (draw === undefined) throw new Error('WaterMesh transition fixture has no draw');
    const originalBytes = draw.bytes.slice();
    const descriptor = new Uint8Array(48);
    const bodyIndices = new Map(plan.bodyIndices);
    const readBodyIndex = bodyIndices.get.bind(bodyIndices);
    let changed = false;
    bodyIndices.get = (bodyGuid) => {
      if (bodyGuid === targetOwner && !changed) {
        changed = true;
        draw.bytes[0] = (draw.bytes[0] ?? 0) ^ 1;
      }
      return readBodyIndex(bodyGuid);
    };

    const upload = buildWaterMaterialFrameUpload(
      { ...plan, bodyIndices },
      new Map([
        [ownerA, descriptor],
        [targetOwner, descriptor],
      ]),
      [draw],
      64,
    );
    expect(changed).toBe(true);
    expect(draw.bytes).not.toEqual(originalBytes);
    const offset = upload.waterMeshInstances.dynamicOffsets.get(draw.drawKey);
    if (offset === undefined) throw new Error('WaterMesh transition fixture has no draw offset');
    const expected = originalBytes.slice();
    const data = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
    for (const target of draw.transitionTargets) {
      const bodyIndex = plan.bodyIndices.get(target.bodyGuid);
      if (bodyIndex === undefined) throw new Error('WaterMesh target fixture has no WaveSet row');
      data.setUint32(
        target.instanceIndex * WATER_MESH_INSTANCE_STRIDE_BYTES +
          WATER_MESH_INSTANCE_LAYOUT.offsets.transitionWaveIndexPlusOne,
        bodyIndex + 1,
        true,
      );
    }
    expect(upload.waterMeshInstances.bytes.slice(offset, offset + expected.byteLength)).toEqual(
      expected,
    );
  });

  it('rechecks Baked descriptor/sample ranges against the selected uploaded Body row', () => {
    const { upload } = uploadFixture();
    const gpu = bufferDevice();
    const buffers = uploadWaterMaterialFrame(gpu.device, upload).unwrap();
    const resources = waterMaterialFrameBindingResources({
      upload,
      buffers,
      bodyTargetNames: new Map(),
      bodyTargetFormats: new Map(),
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: 9,
    });

    expect(waterMaterialBakedSourceBindings(resources, [1])).toMatchObject([
      {
        drawDataRowOffset: 256,
        descriptorBufferByteLength: 96,
        sampleBufferByteLength: 144,
        complete: true,
      },
    ]);
    expect(
      waterMaterialBakedSourceBindings(
        { ...resources, bakedSampleBytes: resources.bakedSampleBytes.slice(0, 16) },
        [1],
      )[0]?.complete,
    ).toBe(false);
    expect(
      waterMaterialBakedSourceBindings(
        { ...resources, bodyIndexDynamicOffsets: new Map([[ownerB, 0]]) },
        [1],
      )[0]?.complete,
    ).toBe(false);
  });

  it('allocates ABI-sized buffers and binds the matching target and graph version', () => {
    const { upload } = uploadFixture();
    const gpu = bufferDevice();
    const allocated = uploadWaterMaterialFrame(gpu.device, upload);
    expect(allocated.ok).toBe(true);
    if (!allocated.ok) return;
    expect(gpu.descriptors.map(({ label, size }) => [label, size])).toEqual([
      ['water-body-data', 2 * WATER_BODY_DATA_STRIDE_BYTES],
      ['water-gerstner-waves', 48],
      ['water-material-draw-data', 512],
      ['water-info-descriptors', 512],
      ['water-mesh-tile-instances', upload.waterMeshInstances.bytes.byteLength],
      ['water-baked-descriptors', 96],
      ['water-baked-samples', 144],
    ]);
    expect(gpu.writes).toHaveBeenCalledTimes(7);
    const writeBytes = gpu.writes.mock.calls.map(([, , data]) =>
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    expect(writeBytes).toEqual([
      upload.bodyData,
      upload.waveData,
      upload.drawData,
      upload.waterInfoDescriptors,
      upload.waterMeshInstances.bytes,
      upload.bakedDescriptors,
      upload.bakedSamples,
    ]);

    const target = 'water-info:zone-a';
    const resources = waterMaterialFrameBindingResources({
      upload,
      buffers: allocated.value,
      waterInfoContentFrameGeneration: 8,
      waterInfoContentGraphResourceVersion: 'graph-resource-v3',
      waterInfoTextureView: {} as TextureView,
      waterInfoTargetName: target,
      waterInfoFormat: 'rgba32float',
      bodyTargetNames: new Map([
        [ownerA, target],
        [ownerB, target],
      ]),
      bodyTargetFormats: new Map([
        [ownerA, 'rgba32float'],
        [ownerB, 'rgba32float'],
      ]),
      waterInfoSampler: {} as Sampler,
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: 9,
    });
    const layout = {} as Parameters<typeof createWaterMaterialFrameBindings>[1];
    const bindings = createWaterMaterialFrameBindings(
      { createBindGroup: () => ok({} as BindGroup) },
      layout,
      resources,
    );
    expect(bindings.ok).toBe(true);
    if (!bindings.ok) return;
    const drawBinding = waterMaterialDrawBinding(
      bindings.value,
      ownerA,
      {
        viewIdentity: 'view-a',
        zoneGeneration: 2,
        bodyGeneration: 4,
        deviceGeneration: 2,
        frameGeneration: 9,
        targetName: target,
      },
      upload.waterMeshInstances.dynamicOffsets.keys().next().value,
    );
    expect(drawBinding.ok).toBe(true);
    if (drawBinding.ok) {
      expect(drawBinding.value.waterInfoDynamicOffset).toBe(0);
      expect(drawBinding.value.dynamicOffset).toBe(0);
      expect(drawBinding.value.waterMeshInstanceDynamicOffset % 64).toBe(0);
    }
    const staleBinding = waterMaterialDrawBinding(bindings.value, ownerA, {
      viewIdentity: 'view-a',
      zoneGeneration: 2,
      deviceGeneration: 2,
      frameGeneration: 9,
      targetName: 'water-info:stale',
    });
    expect(staleBinding.ok).toBe(false);
    if (!staleBinding.ok) expect(staleBinding.error.code).toBe('water-material-binding-stale');
    const invalidBindings = createWaterMaterialFrameBindings(
      { createBindGroup: () => ok({} as BindGroup) },
      layout,
      {
        ...resources,
        waterInfoContentGraphResourceVersion: '',
      },
    );
    expect(invalidBindings.ok).toBe(false);
    if (!invalidBindings.ok) expect(invalidBindings.error.code).toBe('rhi-descriptor-invalid');
  });

  it('routes transition tiles through the same-generation target WaveSet and WaterInfo row', () => {
    const targetBodyGuid = 'body-0';
    const targetOwner = waterBodyOwnerKey('water-test-world', targetBodyGuid, 7, 2);
    const plan = waterPlan(2, 100, true, targetBodyGuid);
    const descriptor = Uint8Array.from({ length: 48 }, (_, index) => index + 11);
    const draw = waterMeshDraws(true, targetBodyGuid)[0];
    if (draw === undefined) throw new Error('WaterMesh transition fixture has no draw');
    const transition = draw.transitionTargets[0];
    if (transition === undefined) throw new Error('WaterMesh transition fixture has no target row');
    const upload = buildWaterMaterialFrameUpload(
      plan,
      new Map([
        [ownerA, descriptor],
        [targetOwner, descriptor],
      ]),
      [draw],
      64,
    );
    const waveIndex = plan.bodyIndices.get(targetOwner);
    if (waveIndex === undefined) throw new Error('WaterMesh target fixture has no WaveSet row');
    expect(waveIndex).toBe(0);
    const drawOffset = upload.waterMeshInstances.dynamicOffsets.get(draw.drawKey);
    if (drawOffset === undefined)
      throw new Error('WaterMesh target fixture has no draw upload range');
    const uploadedMeshBytes = new DataView(upload.waterMeshInstances.bytes.buffer);
    for (const target of draw.transitionTargets) {
      const encodedIndex = uploadedMeshBytes.getUint32(
        drawOffset + target.instanceIndex * WATER_MESH_INSTANCE_STRIDE_BYTES + 32,
        true,
      );
      expect(encodedIndex).toBe(1);
    }
    expect(plan.bodyData[waveIndex]?.waveCount).toBe(1);
    expect(upload.waterMeshInstances.transitionTargetsByDraw.get(draw.drawKey)).toEqual(
      draw.transitionTargets,
    );
    const allDraws = [draw];
    const expectedCoverage = new Uint8Array(
      allDraws.reduce((sum, candidate) => sum + candidate.coverageBytes.byteLength, 0),
    );
    let expectedCoverageOffset = 0;
    for (const candidate of [...allDraws].sort((left, right) =>
      left.drawKey.localeCompare(right.drawKey),
    )) {
      expectedCoverage.set(candidate.coverageBytes, expectedCoverageOffset);
      expectedCoverageOffset += candidate.coverageBytes.byteLength;
    }
    expect(upload.waterMeshInstances.layout).toEqual(
      createWaterMeshLayoutReceipt(upload.waterMeshInstances.bytes, expectedCoverage),
    );
    expect(
      isWaterMeshLayoutReceiptValid(
        upload.waterMeshInstances.layout,
        upload.waterMeshInstances.bytes,
        expectedCoverage,
      ),
    ).toBe(true);
    for (const candidate of allDraws) {
      const offset = upload.waterMeshInstances.dynamicOffsets.get(candidate.drawKey);
      if (offset === undefined) throw new Error('WaterMesh target fixture has no draw offset');
      const expected = candidate.bytes.slice();
      const expectedData = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
      for (const target of candidate.transitionTargets) {
        const index = plan.bodyIndices.get(target.bodyGuid);
        if (index === undefined) throw new Error('WaterMesh target fixture has no WaveSet row');
        expectedData.setUint32(
          target.instanceIndex * WATER_MESH_INSTANCE_STRIDE_BYTES +
            WATER_MESH_INSTANCE_LAYOUT.offsets.transitionWaveIndexPlusOne,
          index + 1,
          true,
        );
      }
      expect(upload.waterMeshInstances.bytes.slice(offset, offset + expected.byteLength)).toEqual(
        expected,
      );
      expect(
        upload.waterMeshInstances.bytes.slice(
          offset + expected.byteLength,
          offset + expected.byteLength + candidate.coverageBytes.byteLength,
        ),
      ).toEqual(candidate.coverageBytes);
      expect(upload.waterMeshInstances.transitionTargetsByDraw.get(candidate.drawKey)).toEqual(
        candidate.transitionTargets,
      );
    }
    const ownedSourceDraw = ownWaterMeshAdmissionDraw(
      {
        guid: bodyA,
        generation: 4,
        worldIdentity: 'water-test-world',
        zoneGeneration: 2,
      },
      'view-a',
      {
        ...draw,
        transitionTargets: draw.transitionTargets.map((target) => ({
          ...target,
          bodyGuid: targetBodyGuid,
        })),
      },
    );
    const ownedTiles = projectWaterMeshAdmissionTiles(
      {
        drawKey: ownedSourceDraw.drawKey,
        bodyGuid: bodyA,
        bodyGeneration: 4,
        worldIdentity: 'water-test-world',
        zoneGeneration: 2,
        viewIdentity: 'view-a',
        bytes: ownedSourceDraw.bytes,
        coverageBytes: ownedSourceDraw.coverageBytes,
        layout: ownedSourceDraw.layout,
        transitionTargets: ownedSourceDraw.transitionTargets,
      },
      ownedSourceDraw,
    );
    const ownedDraw = waterMeshAdmissionUpload(ownedTiles);
    expect(isOwnedWaterMeshAdmissionUpload(ownedDraw)).toBe(true);
    const ownedUpload = buildWaterMaterialFrameUpload(
      plan,
      new Map([
        [ownerA, descriptor],
        [targetOwner, descriptor],
      ]),
      [ownedDraw],
      64,
    );
    expect(ownedUpload.waterMeshInstances.bytes).toEqual(upload.waterMeshInstances.bytes);
    expect(ownedUpload.waterMeshInstances.dynamicOffsets).toEqual(
      upload.waterMeshInstances.dynamicOffsets,
    );
    expect(ownedUpload.waterMeshInstances.layout).toEqual(upload.waterMeshInstances.layout);

    const gpu = bufferDevice();
    const allocated = uploadWaterMaterialFrame(gpu.device, upload);
    expect(allocated.ok).toBe(true);
    if (!allocated.ok) return;
    const targetName = 'water-info:shared-zone';
    const targetNames = new Map([
      [ownerA, targetName],
      [targetOwner, targetName],
    ]);
    const targetFormats = new Map([
      [ownerA, 'rgba32float' as const],
      [targetOwner, 'rgba32float' as const],
    ]);
    const resources = waterMaterialFrameBindingResources({
      upload,
      buffers: allocated.value,
      waterInfoContentFrameGeneration: 8,
      waterInfoContentGraphResourceVersion: 'graph-resource-transition',
      waterInfoTextureView: {} as TextureView,
      waterInfoTargetName: targetName,
      waterInfoFormat: 'rgba32float',
      bodyTargetNames: targetNames,
      bodyTargetFormats: targetFormats,
      waterInfoSampler: {} as Sampler,
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      frameGeneration: 9,
    });
    const bindings = createWaterMaterialFrameBindings(
      { createBindGroup: () => ok({} as BindGroup) },
      {} as Parameters<typeof createWaterMaterialFrameBindings>[1],
      resources,
    );
    expect(bindings.ok).toBe(true);
    if (!bindings.ok) return;
    expect(
      waterMaterialDrawBinding(
        bindings.value,
        ownerA,
        {
          viewIdentity: 'view-a',
          zoneGeneration: 2,
          bodyGeneration: 4,
          deviceGeneration: 2,
          frameGeneration: 9,
          targetName,
        },
        draw.drawKey,
      ).ok,
    ).toBe(true);

    expect(() =>
      buildWaterMaterialFrameUpload(
        plan,
        new Map([
          [ownerA, descriptor],
          [targetOwner, Uint8Array.from({ length: 48 }, (_, index) => index + 12)],
        ]),
        [draw],
        64,
      ),
    ).toThrow('does not share the owner WaterInfo descriptor');
    expect(() =>
      buildWaterMaterialFrameUpload(
        plan,
        new Map([
          [ownerA, descriptor],
          [targetOwner, descriptor],
        ]),
        [{ ...draw, transitionTargets: [{ ...transition, bodyGeneration: 8 }] }],
        64,
      ),
    ).toThrow('missing or stale transition WaveSet/WaterBody row');
  });

  it('destroys every partial buffer allocation when a later ABI buffer hits a device limit', () => {
    const { upload } = uploadFixture();
    const gpu = bufferDevice('water-info-descriptors');
    const result = uploadWaterMaterialFrame(gpu.device, upload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(gpu.failure);
    expect(gpu.created).toHaveLength(3);
    expect(gpu.destroyed).toEqual(gpu.created);
    expect(gpu.descriptors).toHaveLength(4);
  });
});
