import { mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type BindGroup, ok, type RenderPipeline, type TextureFormat } from '@forgeax/engine-rhi';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction, type PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { GpuDrivenStandardPbrFrameResources, RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { SkinFrames, type SkinSceneFrame, SkinSceneInputs } from '../scene/skin-scene-inputs';
import {
  admitGpuFixture,
  mesh,
  preparedSnapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';

function defined<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected fixture value');
  return value;
}

async function fixture(kinds: readonly ('rigid' | 'skin')[], clustered = true) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  if (!(device instanceof RhiNullDevice)) throw new Error('Expected Null RHI');
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = () => device.createBindGroup({ layout, entries: [] }).unwrap();
  const programs = standardPbrInputs(device, shader, layout);
  const base = defined(programs.materialArtifact);
  const state = defined(programs.materialPipelineState);
  const rigid = {
    ...base,
    program: createMaterialShaderProgram(
      clustered ? '@group(0) @binding(30) var light_data: u32;' : '',
    ),
  };
  const skin = {
    ...rigid,
    program: createMaterialShaderProgram(
      '@group(2) @binding(1) var joints: u32; @group(0) @binding(30) var light_data: u32;',
    ),
    receipt: createStandardPbrArtifactReceipt(true),
  };
  const snapshots = kinds.map((kind, index): RenderableSnapshot => {
    const source = preparedSnapshot(index + 1, index + 1);
    const materialShaderId =
      kind === 'skin' ? 'forgeax::pbr-skin' : 'forgeax::default-standard-pbr';
    const cullMode = index % 2 === 0 ? ('back' as const) : ('front' as const);
    const material = new MaterialResource({
      ...source.material.snapshot,
      materialShaderId,
      renderState: { cullMode },
      passes: [
        {
          name: 'forward',
          program: { module: materialShaderId },
          renderState: { cullMode, tags: { LightMode: 'Forward' } },
        },
      ],
      materialProgramKeys: { forward: materialShaderId },
    });
    return {
      ...source,
      material,
      materials: [material],
      ...(kind === 'skin'
        ? {
            skinBinding: { skeleton: 7, joints: [19] },
          }
        : {}),
      gpuDrivenDraws: defined(source.gpuDrivenDraws).map((draw) => ({
        ...draw,
        geometry: {
          ...draw.geometry,
          deformation: kind,
          receipt: {
            ...draw.geometry.receipt,
            vertexInputs:
              kind === 'skin' ? skin.receipt.vertexInputs : defined(rigid.receipt).vertexInputs,
          },
        },
        prepared: {
          ...defined(draw.prepared),
          identity: { ...defined(draw.prepared).identity, deformation: kind },
          ...(kind === 'skin'
            ? {
                vertexInputs: skin.receipt.vertexInputs,
              }
            : {}),
        },
      })),
    };
  });
  const scene = new RenderScene();
  const available = GpuScene.create(device, kinds.length).unwrap();
  if (available.status !== 'available') throw new Error('Expected Null GPU Scene');
  const topology = new BatchTopology();
  const meshBySlot = new Map(snapshots.map((_, index) => [index, mesh(device)]));
  const skinInputs = new SkinSceneInputs(available.scene.inputs.arena, () => ({
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: mat4.identity(mat4.create()),
  }));
  const skinFrames = new SkinFrames(skinInputs);
  let skinFrame: SkinSceneFrame | undefined;
  const publish = (rows: readonly RenderableSnapshot[]) => {
    skinFrames.discardFrame();
    const delta = scene.apply(rows.map(updateSnapshot));
    skinInputs.apply(delta);
    skinInputs.joint(19, mat4.identity(mat4.create()));
    skinFrame = skinFrames.prepareFrame(scene.slotsSnapshot());
    available.scene.sync(delta).unwrap();
    topology.apply(delta);
  };
  publish(snapshots);
  const skinLayout = device
    .createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 1,
          buffer: { type: 'read-only-storage', hasDynamicOffset: true },
        },
        { binding: 1, visibility: 1, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: 1, buffer: { type: 'uniform', hasDynamicOffset: true } },
      ],
    })
    .unwrap();
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const prepare = () =>
    defined(
      production
        .prepare(
          admitGpuFixture({
            ...programs,
            materialArtifact: rigid,
            materialPipelineState: {
              ...state,
              gpuDrivenPbrSkinPipelineLayout: defined(state.gpuDrivenPbrPipelineLayout),
              pbrSkinMeshBindGroupLayout: skinLayout,
              gpuDrivenSkinPrimitiveBindGroupLayout: skinLayout,
            },
            materialArtifacts: new Map([
              ['forgeax::default-standard-pbr', rigid],
              ['forgeax::pbr-skin', skin],
            ]),
            scene: {
              scene: available.scene,
              skin: skinFrame,
              plan: topology.query(topology.sourcePlan(), undefined).active,
              slots: scene.slotsSnapshot(),
              slotAt: scene.slotAt,
            },
            camera: makeZeroCameraFallbackSnapshot(),
            meshBySlot,
            viewBindGroupLayout: layout,
          }),
        )
        .unwrap(),
    );
  return {
    device,
    group,
    snapshots,
    scene: available.scene,
    meshBySlot,
    publish,
    prepare,
    close() {
      production.dispose();
      skinInputs.dispose();
      available.scene.dispose();
    },
  };
}

/** Inspect the actual graph's encode commands; Null RHI proves CPU routing, not shader pixels. */
function recorder(
  f: Awaited<ReturnType<typeof fixture>>,
  prepared: PreparedGpuDrivenFrame,
  rendererRecording = true,
) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const gpu = prepared
    .project(graph, 'rgba8unorm', 1, undefined, undefined, false, rendererRecording)
    .unwrap();
  const color = graph
    .createTexture('cluster-color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
    .unwrap();
  const view = graph.view(color).unwrap();
  const viewGroup = f.group();
  const materialGroup = f.group();
  let overrides: Partial<GpuDrivenStandardPbrFrameResources> = {};
  const bindings: { group: BindGroup; offsets: readonly number[] }[] = [];
  const pipelines: RenderPipeline[] = [];
  let encodeError: unknown;
  let submitted = false;
  let sealed = false;
  graph
    .addRasterPass('cluster-bindings', {
      accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
      colorAttachments: [
        { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
      encode: ({ pass, resources }) => {
        const bind = pass.setBindGroup.bind(pass);
        const pipeline = pass.setPipeline.bind(pass);
        vi.spyOn(pass, 'setPipeline').mockImplementation((value) => {
          pipelines.push(value);
          pipeline(value);
        });
        vi.spyOn(pass, 'setBindGroup').mockImplementation((index, group, offsets) => {
          const values = offsets === undefined ? [] : Array.from(offsets);
          if (index === 2) bindings.push({ group, offsets: values });
          bind(index, group, values);
        });
        try {
          gpu.encode(viewGroup, pass, resources, {
            ...defined(prepared.standardPbrFrameResources),
            prepareMaterialBinding: (
              (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
              (slot: number) => {
                const group = groups[slot];
                return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
              }
            )([materialGroup]),
            materialSlotIndicesByBinding: new Map(),
            ...overrides,
          });
        } catch (error) {
          encodeError = error;
          throw error;
        }
      },
    })
    .unwrap();
  const compiled = graph
    .compile({ device: f.device, surfaceSize: { width: 1, height: 1 } })
    .unwrap();
  return {
    get encodeError() {
      return encodeError;
    },
    record(next: Partial<GpuDrivenStandardPbrFrameResources>) {
      if (submitted) {
        prepared = f.prepare();
        submitted = false;
        sealed = false;
      }
      encodeError = undefined;
      overrides = next;
      bindings.length = 0;
      pipelines.length = 0;
      const before = f.device.totalDrawCount;
      if (!sealed) {
        prepared._sealResourceReads().unwrap();
        sealed = true;
      }
      const encoder = f.device.createCommandEncoder().unwrap();
      compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
      f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
      prepared._commitResourceReplacement();
      submitted = true;
      return {
        bindings: [...bindings],
        pipelines: [...pipelines],
        draws: f.device.totalDrawCount - before,
      };
    },
    close: () => compiled.retire(),
  };
}

it('reuses one rigid Primitive across clustered pipeline changes', async () => {
  const f = await fixture(['rigid', 'rigid', 'rigid']);
  const r = recorder(f, f.prepare());
  try {
    expect(r.record({ selectedMaterialSlots: new Set() }).draws).toBe(0);
    const first = r.record({});
    expect(first.draws).toBe(3);
    expect(new Set(first.pipelines).size).toBe(2);
    expect(first.bindings).toHaveLength(1);
    expect(first.bindings[0]?.offsets).toEqual([]);
    expect(r.record({})).toEqual(first);
  } finally {
    await r.close();
    f.close();
  }
});

describe('GPU-driven frame resource observation scopes', () => {
  it.each([
    false,
    true,
  ])('preserves pipeline value errors and retries admission (private recording=%s)', async (rendererRecording) => {
    const f = await fixture(['rigid'], false);
    const prepared = f.prepare();
    const createPipeline = f.device.createRenderPipeline.bind(f.device);
    const expected = new Error('raw pipeline value observation');
    let reads = 0;
    const creation = vi.spyOn(f.device, 'createRenderPipeline').mockImplementation((descriptor) => {
      const result = createPipeline(descriptor);
      if (!result.ok) return result;
      return {
        ...result,
        get value() {
          if (++reads === 2) throw expected;
          return result.value;
        },
      };
    });
    let recorded: ReturnType<typeof recorder> | undefined;
    try {
      let error: unknown;
      try {
        recorder(f, prepared, rendererRecording);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBe(expected);
      expect(reads).toBe(2);
      expect(creation).toHaveBeenCalledTimes(1);
      recorded = recorder(f, prepared, rendererRecording);
      expect(recorded.record({}).draws).toBe(1);
      const created = creation.mock.calls.length;
      const observed = reads;
      expect(recorded.record({}).draws).toBe(1);
      expect(creation).toHaveBeenCalledTimes(created);
      expect(reads).toBe(observed);
    } finally {
      creation.mockRestore();
      await recorded?.close();
      f.close();
    }
  });

  it('does not read attachment formats when no material is selected', async () => {
    const f = await fixture(['rigid', 'rigid'], false);
    const r = recorder(f, f.prepare(), false);
    const formats: TextureFormat[] = [];
    const expected = new Error('unselected attachment');
    const read = vi.fn(() => {
      throw expected;
    });
    Object.defineProperty(formats, 0, { get: read, configurable: true });
    try {
      expect(r.record({ colorFormats: formats, selectedMaterialSlots: new Set() }).draws).toBe(0);
      expect(read).not.toHaveBeenCalled();
      expect(() => r.record({ colorFormats: formats })).toThrow();
      expect(r.encodeError).toBe(expected);
      Object.defineProperty(formats, 0, { value: 'rgba8unorm', configurable: true });
      expect(r.record({ colorFormats: formats }).draws).toBe(2);
    } finally {
      await r.close();
      f.close();
    }
  });
});
