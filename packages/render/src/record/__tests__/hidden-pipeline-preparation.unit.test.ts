import {
  createBoxGeometry,
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  type MaterialShaderArtifact,
  STANDARD_SURFACE_DISCARDS_OVERRIDE,
  STANDARD_TEXTURE_MASK_OVERRIDE,
} from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import { MorphGeometry } from '../../device/morph-geometry';
import { createPointsLinesSnapshot, type PointsLinesStyle } from '../../points-lines/snapshot';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { DispatchEntry } from '../../render-system-extract';
import { morphSnapshotFor } from '../../render-system-extract-tail';
import { prepareMainPassPipelines } from '../main-pass';
import { recordGeometryDraws } from '../main-pass-geometry';
import { prepareShadowMaterialPipelines } from '../shadow-pass';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

const artifactFor = (
  program: MaterialShaderArtifact['program'],
  variantSet = 'LOD_DITHER=false+CLIPPING_PLANES=false',
): MaterialShaderArtifact => ({
  variantSet,
  material: 'test::prepared',
  pass: 'Forward',
  program,
  layoutIdentity: 'test::prepared',
  bindings: [],
  deps: [],
  vertexInputs: [],
});
const pass = (mode = 'Forward'): Omit<DispatchEntry, 'entityIndex' | 'renderableIndex'> => ({
  materialHandle: 7,
  passIndex: 0,
  queue: 2000,
  layer: 0,
  tags: { LightMode: mode },
  renderState: { cullMode: 'none' },
  defines: undefined,
  materialShaderId: 'test::prepared',
  vertexEntry: 'vertex',
  fragmentEntry: 'fragment',
});

it.each([
  { fog: false, fragment: 'fs_opaque' },
  { fog: true, fragment: undefined },
  { fog: undefined, fragment: undefined },
])('selects the transparent preparation entry from the view medium (fog=$fog)', async ({
  fog,
  fragment,
}) => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  Object.assign(f.authoredPass, {
    fragmentEntry: undefined,
    renderState: {
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    },
  });
  f.entry.source.material.adopt({ ...f.entry.source.material.snapshot, transparent: true });
  Object.assign(f.c, { viewFog: fog });
  f.acceptMaterials();
  try {
    prepareMainPassPipelines(f.c, { LightMode: ['Forward'] }, { recordMode: 'transparent' }, 1, [
      'rgba16float',
    ]);
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0]?.[19]).toBe(fragment);
  } finally {
    f.dispose();
  }
});
async function setup() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, submeshes: 1 });
  const authoredPass = pass();
  Object.assign(entry.source, { authorVisible: false, pipelinePreparation: [authoredPass] });
  entry.source.material.adopt({
    ...entry.source.material.snapshot,
    materialShaderId: 'test::prepared',
  });
  Object.assign(f.c, { validatedOrdered: [], pipelinePreparationEntries: [entry] });
  const encode = () => {
    f.acceptMaterials();
    const encoder = device
      .createCommandEncoder()
      .unwrap()
      .beginRenderPass({ colorAttachments: [] });
    const commands = [
      vi.spyOn(encoder, 'draw'),
      vi.spyOn(encoder, 'drawIndexed'),
      vi.spyOn(encoder, 'setPipeline'),
      vi.spyOn(encoder, 'setBindGroup'),
      vi.spyOn(encoder, 'setVertexBuffer'),
    ];
    recordGeometryDraws(
      f.c,
      encoder,
      null,
      [],
      1,
      f.meshGroup,
      f.meshGroup,
      () => ({ group: f.materialGroup, byteOffset: 0, dynamicOffsetCount: 1 as const }),
      'forward',
      undefined,
      ['rgba8unorm'],
      false,
      undefined,
      undefined,
      false,
      undefined,
      (p) => p.tags.LightMode === 'Forward',
    );
    for (const command of commands) expect(command).not.toHaveBeenCalled();
    encoder.end();
  };
  return { ...f, entry, authoredPass, encode };
}

it('requires the authored PSO and emits no draw, binding or visibility mutation', async () => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  try {
    lookup.mockReturnValueOnce(null);
    f.encode();
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);
    expect(f.entry.source.authorVisible).toBe(false);
    expect(f.receipts).toEqual([]);
    f.c.frameState.pipelinePreparationPending = false;
    f.encode();
    expect(f.c.frameState.pipelinePreparationPending).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[1]?.[18]).toBe('vertex');
    expect(lookup.mock.calls[1]?.[19]).toBe('fragment');
  } finally {
    f.dispose();
  }
});

it('uses the identical selection for preparation and visible direct drawing', async () => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  Object.assign(f.c.runtime, {
    getMaterialShaderArtifact: () =>
      artifactFor(
        createMaterialShaderProgram('@id(64001) override standardSurfaceDiscards: u32 = 3u;'),
      ),
  });
  try {
    f.encode();
    const hiddenRequest = lookup.mock.calls[0];
    expect(hiddenRequest?.[21]).toEqual({ [STANDARD_SURFACE_DISCARDS_OVERRIDE]: 0 });
    Object.assign(f.c, { pipelinePreparationEntries: [], validatedOrdered: [f.entry] });
    const encoder = f.c.runtime.device
      .createCommandEncoder()
      .unwrap()
      .beginRenderPass({ colorAttachments: [] });
    recordGeometryDraws(
      f.c,
      encoder,
      null,
      [[0]],
      1,
      f.meshGroup,
      f.meshGroup,
      () => ({ group: f.materialGroup, byteOffset: 0, dynamicOffsetCount: 1 as const }),
      'forward',
      [{ ...f.authoredPass, entityIndex: 1, renderableIndex: 0 }],
      ['rgba8unorm'],
    );
    encoder.end();
    expect(lookup.mock.calls[1]).toEqual(hiddenRequest);
    expect(f.receipts).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it('observes changed authored state, source program, mask and geometry layout', async () => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  try {
    f.encode();
    const before = lookup.mock.calls[0];
    Object.assign(f.authoredPass, {
      materialShaderId: 'test::replacement',
      renderState: { cullMode: 'front' },
      vertexEntry: 'replacement',
    });
    f.entry.source.material.adopt({ ...f.entry.source.material.snapshot, standardTextureMask: 5 });
    f.encode();
    const after = lookup.mock.calls[1];
    expect(after?.[0]).toBe('test::replacement');
    expect(after?.[2]).not.toEqual(before?.[2]);
    expect(after?.[18]).toBe('replacement');
    expect(after?.[21]).toEqual({ [STANDARD_TEXTURE_MASK_OVERRIDE]: 5 });
    Object.assign(f.entry.mesh, {
      layoutProjection: deriveVertexLayoutProjection({
        position: Float32Array.of(0, 0, 0),
        color: Float32Array.of(1, 1, 1, 1),
      }),
    });
    f.encode();
    expect(lookup.mock.calls[2]?.[13]).not.toEqual(before?.[13]);
  } finally {
    f.dispose();
  }
});

it('specializes unreachable direct Surface discards and observes clipping and program changes', async () => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  let program = createMaterialShaderProgram(
    `${CPU_SETUP_SHADER}\n@id(64001) override standardSurfaceDiscards: u32 = 3u;`,
  );
  let declares = true;
  Object.assign(f.c.runtime, {
    getMaterialShaderArtifact: () => artifactFor(program, declares ? undefined : ''),
  });
  f.entry.source.material.adopt({ ...f.entry.source.material.snapshot, standardTextureMask: 5 });
  try {
    f.encode();
    expect(lookup.mock.calls[0]?.[21]).toEqual({
      [STANDARD_TEXTURE_MASK_OVERRIDE]: 5,
      [STANDARD_SURFACE_DISCARDS_OVERRIDE]: 0,
    });
    Object.assign(f.c.camera, { clipping: { planes: [{ normal: [1, 0, 0], constant: 0 }] } });
    f.encode();
    expect(lookup.mock.calls[1]?.[21]).toEqual({
      [STANDARD_TEXTURE_MASK_OVERRIDE]: 5,
      [STANDARD_SURFACE_DISCARDS_OVERRIDE]: 2,
    });
    Object.assign(f.c.camera, { clipping: undefined });
    f.encode();
    expect(lookup.mock.calls[2]?.[21]?.[STANDARD_SURFACE_DISCARDS_OVERRIDE]).toBe(0);
    program = createMaterialShaderProgram(CPU_SETUP_SHADER);
    declares = false;
    f.encode();
    expect(lookup.mock.calls[3]?.[21]).toEqual({ [STANDARD_TEXTURE_MASK_OVERRIDE]: 5 });
  } finally {
    f.dispose();
  }
});

it('prepares only authored ShadowCaster passes through validated module readiness', async () => {
  const f = await setup();
  const shadow = pass('ShadowCaster');
  f.entry.source.material.adopt({
    ...f.entry.source.material.snapshot,
    passes: [
      {
        name: 'ShadowCaster',
        program: { module: 'test::prepared', vertexEntry: 'vertex', fragmentEntry: 'fragment' },
        renderState: { tags: { LightMode: 'ShadowCaster' }, cullMode: 'none' },
      },
    ],
    materialProgramKeys: { ShadowCaster: 'test::prepared' },
  });
  f.acceptMaterials();
  Object.assign(f.entry.source, { pipelinePreparation: [f.authoredPass, shadow] });
  const lookup = vi.fn().mockReturnValue(null);
  Object.assign(f.c.runtime, { getMaterialShaderPipelineEntry: lookup });
  try {
    prepareShadowMaterialPipelines(f.c, true, () => false);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[6]).toBe('shadow-caster');
    expect(lookup.mock.calls[0]?.[14]).toBe('validated');
    expect(lookup.mock.calls[0]?.[18]).toBe('vertex');
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);
    f.c.frameState.pipelinePreparationPending = false;
    lookup.mockReturnValue({ pipeline: f.pipeline, group2Contract: 'mesh' });
    prepareShadowMaterialPipelines(f.c, true, () => false);
    expect(f.c.frameState.pipelinePreparationPending).toBe(false);
    expect(f.entry.source.authorVisible).toBe(false);
  } finally {
    f.dispose();
  }
});

it('prepares visible residual authored casters before recording their shadow views', async () => {
  const f = await setup();
  f.entry.source.material.adopt({
    ...f.entry.source.material.snapshot,
    passes: [
      {
        name: 'ShadowCaster',
        program: { module: 'test::prepared', vertexEntry: 'vertex', fragmentEntry: 'fragment' },
        renderState: { tags: { LightMode: 'ShadowCaster' }, cullMode: 'none' },
      },
    ],
    materialProgramKeys: { ShadowCaster: 'test::prepared' },
  });
  Object.assign(f.entry.source, { authorVisible: true, pipelinePreparation: undefined });
  Object.assign(f.c, { validatedOrdered: [f.entry], pipelinePreparationEntries: [] });
  f.acceptMaterials();
  const lookup = vi.fn().mockReturnValue(null);
  Object.assign(f.c.runtime, { prepareMaterialShaderPipelineEntry: lookup });
  try {
    // No declared shadow view means no native preparation demand.
    prepareShadowMaterialPipelines(f.c);
    expect(lookup).not.toHaveBeenCalled();
    Object.assign(f.c, {
      shadowViewPlanesByView: new Map([['directional:0', new Float32Array(24)]]),
    });
    // An explicitly empty residual roster must not fall back to main-pass rows.
    Object.assign(f.c, { shadowValidatedOrdered: [] });
    prepareShadowMaterialPipelines(f.c);
    expect(lookup).not.toHaveBeenCalled();
    Object.assign(f.c, { shadowValidatedOrdered: [f.entry] });
    prepareShadowMaterialPipelines(f.c);
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0]?.[6]).toBe('shadow-caster');
    expect(lookup.mock.calls[0]?.[14]).toBe('validated');
    expect(lookup.mock.calls[0]?.[18]).toBe('vertex');
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);
    f.c.frameState.pipelinePreparationPending = false;
    lookup.mockClear().mockReturnValue({ pipeline: f.pipeline, group2Contract: 'mesh' });
    Object.assign(f.c, {
      shadowValidatedOrdered: Array.from({ length: 240 }, (_, index) => ({
        ...f.entry,
        source: { ...f.entry.source, entityKey: index + 1 },
      })),
    });
    prepareShadowMaterialPipelines(f.c);
    expect(lookup).toHaveBeenCalledOnce();
    expect(f.c.frameState.pipelinePreparationPending).toBe(false);
    expect(f.entry.source.authorVisible).toBe(true);
    expect(f.receipts).toEqual([]);
  } finally {
    f.dispose();
  }
});

it('uses accepted material demand before walking native residual shadow rows', async () => {
  const f = await setup();
  const material = f.entry.source.material;
  const shadow = {
    name: 'ShadowCaster',
    program: { module: 'forgeax::default-shadow-caster' },
    renderState: { tags: { LightMode: 'ShadowCaster' } },
  };
  const stock = {
    ...material.snapshot,
    immutableValues: true as const,
    passes: [shadow],
  };
  material.adopt({ ...stock, passes: [] });
  f.acceptMaterials();
  Object.assign(f.entry.source, { authorVisible: true, pipelinePreparation: undefined });
  const rows = [f.entry];
  const visit = vi.spyOn(rows, Symbol.iterator);
  Object.assign(f.c, {
    shadowValidatedOrdered: rows,
    pipelinePreparationEntries: [],
    shadowViewPlanesByView: new Map([['directional:0', new Float32Array(24)]]),
  });
  const lookup = vi.fn().mockReturnValue(null);
  Object.assign(f.c.runtime, { prepareMaterialShaderPipelineEntry: lookup });
  try {
    prepareShadowMaterialPipelines(f.c, true);
    expect(visit).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();

    material.adopt(stock);
    f.acceptMaterials();
    prepareShadowMaterialPipelines(f.c, true);
    expect(visit).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0]?.[0]).toBe('forgeax::default-shadow-caster');
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);

    visit.mockClear();
    lookup.mockClear();
    f.c.frameState.pipelinePreparationPending = false;
    material.adopt({
      ...stock,
      passes: [{ ...shadow, program: { module: 'test::prepared' } }],
      materialProgramKeys: { ShadowCaster: 'test::prepared' },
    });
    f.acceptMaterials();
    prepareShadowMaterialPipelines(f.c, true);
    expect(visit).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);

    const { immutableValues: _owned, ...borrowed } = stock;
    material.adopt(borrowed);
    f.acceptMaterials();
    visit.mockClear();
    prepareShadowMaterialPipelines(f.c, true);
    expect(visit).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it('specializes a proven shadow-free View and restores reception when its demand changes', async () => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  Object.assign(f.c.runtime, {
    getMaterialShaderArtifact: () =>
      artifactFor(
        createMaterialShaderProgram('@id(64002) override standardShadowReception: u32 = 1u;'),
      ),
  });
  try {
    Object.assign(f.c, { viewShadows: false });
    f.encode();
    expect(lookup.mock.calls.at(-1)?.[21]?.['64002']).toBe(0);
    Object.assign(f.c, { viewShadows: true });
    f.encode();
    expect(lookup.mock.calls.at(-1)?.[21]?.['64002']).toBe(1);
  } finally {
    f.dispose();
  }
});

it('shares one PSO between receiver and nonreceiver draws of a program during preparation', async () => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  const nonreceiver = f.add({ entity: 2, submeshes: 1 });
  Object.assign(nonreceiver.source, {
    authorVisible: false,
    shadowReceiver: false,
    pipelinePreparation: [f.authoredPass],
  });
  nonreceiver.source.material.adopt({
    ...nonreceiver.source.material.snapshot,
    materialShaderId: 'test::prepared',
  });
  Object.assign(f.c, { pipelinePreparationEntries: [f.entry, nonreceiver] });
  Object.assign(f.c.runtime, {
    // Reception is a per-draw Mesh flag, never a pipeline constant.
    getMaterialShaderArtifact: () => artifactFor(createMaterialShaderProgram('synthetic'), ''),
  });
  try {
    f.encode();
    const constants = lookup.mock.calls.map((call) => call[21]);
    expect(constants.length).toBeGreaterThan(0);
    expect(constants.every((value) => value === undefined)).toBe(true);
    expect(f.receipts).toEqual([]);
  } finally {
    f.dispose();
  }
});

it.each([
  'entry',
  'view',
])('prepares idle morph metadata from its %s scope for a selected explicit pass', async (scope) => {
  const f = await setup();
  const device = f.c.runtime.device;
  const box = createBoxGeometry(1, 1, 1).unwrap();
  const mesh = {
    ...box,
    morphTargets: [
      { position: new Float32Array((box.attributes.position as Float32Array).length) },
    ],
  };
  expect(morphSnapshotFor(mesh, [0])).toBeUndefined();
  const morphGeometry = new MorphGeometry();
  Object.assign(f.c.runtime, {
    deviceScope: DeviceScope.create(0, 'hidden-morph'),
    immediateShaderModuleFactory: {
      createShaderModule: (desc: { code: string }) => rhi.createShaderModuleImmediate(device, desc),
    },
  });
  Object.assign(f.c, { store: { morphGeometry } });
  Object.assign(f.entry.source, { assetHandle: 1 });
  Object.assign(scope === 'entry' ? f.entry : f.c, {
    world: { resolveAsset: () => ({ ok: true, value: mesh }) } as unknown as RenderResourceScope,
  });
  const pipelines = vi.spyOn(device, 'createComputePipeline');
  const buffers = vi.spyOn(device, 'createBuffer');
  const encoders = vi.spyOn(device, 'createCommandEncoder');
  try {
    f.acceptMaterials();
    prepareMainPassPipelines(f.c, { LightMode: ['Unmatched'] }, {}, 1, ['rgba8unorm']);
    prepareMainPassPipelines(f.c, { LightMode: ['Forward'] }, {}, 1, ['rgba8unorm'], () => true);
    expect(pipelines).not.toHaveBeenCalled();
    prepareMainPassPipelines(f.c, { LightMode: ['Forward'] }, {}, 1, ['rgba8unorm']);
    prepareMainPassPipelines(f.c, { LightMode: ['Forward'] }, {}, 1, ['rgba8unorm']);
    expect(pipelines).toHaveBeenCalledOnce();
    expect(buffers).not.toHaveBeenCalled();
    expect(encoders).not.toHaveBeenCalled();
    expect(morphGeometry.size).toBe(0);
    expect(f.entry.source.authorVisible).toBe(false);
    expect(f.entry.source.morph).toBeUndefined();
  } finally {
    morphGeometry.dispose(() => {});
    f.dispose();
  }
});

it.each([
  { style: { kind: 'points', size: 4, sizeUnits: 'pixels', shape: 'circle' }, fragment: undefined },
  { style: { kind: 'lines', width: 2, widthUnits: 0, cap: 0 }, fragment: undefined },
  { style: { kind: 'lines', width: 2, widthUnits: 0, cap: 1 }, fragment: 'fs_round' },
] as const)('prepares $style.kind using its expanded triangle ABI ($fragment)', async ({
  style,
  fragment,
}) => {
  const f = await setup();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry').mockReturnValueOnce(null);
  const buffers = vi.spyOn(f.c.runtime.device, 'createBuffer');
  const encoders = vi.spyOn(f.c.runtime.device, 'createCommandEncoder');
  Object.assign(f.entry.source, {
    shadowCaster: false,
    pointsLines: createPointsLinesSnapshot({
      entityKey: f.entry.source.entityKey,
      component: style.kind === 'points' ? 'Points' : 'Lines',
      meshHandle: 1,
      materialHandle: 7,
      style: style as PointsLinesStyle,
      layer: 0,
      visible: false,
      sourceBounds: [0, 0, 0, 1, 1, 1],
      viewport: { width: 1280, height: 720, dpr: 1 },
      projection: new Float32Array(16),
    }),
  });
  f.entry.source.material.adopt({
    ...f.entry.source.material.snapshot,
    materialShaderId: 'forgeax::default-unlit',
  });
  Object.assign(f.authoredPass, { materialShaderId: 'forgeax::default-unlit' });
  f.acceptMaterials();
  try {
    prepareMainPassPipelines(f.c, { LightMode: ['Unmatched'] }, {}, 4, ['rgba16float']);
    expect(lookup).not.toHaveBeenCalled();
    prepareMainPassPipelines(f.c, { LightMode: ['Forward'] }, {}, 4, ['rgba16float']);
    expect(lookup).toHaveBeenCalledOnce();
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);
    expect(f.c.frameState.pipelinePreparationPendingReason).toMatchObject({
      shader: 'forgeax::points-lines',
    });
    f.c.frameState.pipelinePreparationPending = false;
    prepareMainPassPipelines(f.c, { LightMode: ['Forward'] }, {}, 4, ['rgba16float']);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(f.c.frameState.pipelinePreparationPending).toBe(false);
    expect(lookup.mock.calls[1]).toEqual(lookup.mock.calls[0]);
    expect(lookup.mock.calls[0]?.[0]).toBe('forgeax::points-lines');
    expect(lookup.mock.calls[0]?.[3]).toBe('triangle-list');
    expect(lookup.mock.calls[0]?.[4]).toBe('uint32');
    expect(lookup.mock.calls[0]?.[13]).toEqual(
      deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP),
    );
    expect(lookup.mock.calls[0]?.[18]).toBeUndefined();
    expect(lookup.mock.calls[0]?.[19]).toBe(fragment);
    expect(buffers).not.toHaveBeenCalled();
    expect(encoders).not.toHaveBeenCalled();
    expect(f.entry.source.authorVisible).toBe(false);
  } finally {
    f.dispose();
  }
});

it('does not prepare ShadowCaster pipelines for an explicit noncaster', async () => {
  const f = await setup();
  f.entry.source.material.adopt({
    ...f.entry.source.material.snapshot,
    passes: [
      {
        name: 'ShadowCaster',
        program: { module: 'test::prepared', vertexEntry: 'vertex', fragmentEntry: 'fragment' },
        renderState: { tags: { LightMode: 'ShadowCaster' } },
      },
    ],
    materialProgramKeys: { ShadowCaster: 'test::prepared' },
  });
  Object.assign(f.entry.source, { shadowCaster: false });
  f.acceptMaterials();
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  try {
    prepareShadowMaterialPipelines(f.c, true, () => false);
    expect(lookup).not.toHaveBeenCalled();
    expect(f.c.frameState.pipelinePreparationPending).not.toBe(true);
  } finally {
    f.dispose();
  }
});
