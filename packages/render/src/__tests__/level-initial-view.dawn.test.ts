import { frustum, mat4 } from '@forgeax/engine-math';
import { type CompiledRenderGraph, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type Buffer, type RhiCommandEncoder, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect, it, vi } from 'vitest';
import type { LevelCandidate } from '../../../app/src/levels/candidate';
import { loadRhiPack } from '../assembly/backend-contract';
import type { SourceViewPreparation } from '../assembly/source-view-preparation';
import { DirectionalLight } from '../components/directional-light';
import { PointLight } from '../components/point-light';
import { PointLightShadow } from '../components/point-light-shadow';
import { SpotLight } from '../components/spot-light';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import type { GpuSceneResourceFrame } from '../gpu-scene';
import {
  levelNativeResourcesFixture,
  levelShaderManifestFixture,
} from './level-native-resources-fixture';

vi.mock('@forgeax/engine-render', () => import('../index'));
vi.mock('@forgeax/engine-render/internal', () => import('../internal'));

const shaders = await levelShaderManifestFixture();

async function prepareData(candidate: LevelCandidate, _draw: () => Promise<unknown>) {
  let result = candidate.step();
  for (let step = 0; result.ok && step < 10000; step++) {
    const pending = result.value.render?.pending;
    if (pending !== undefined) {
      await pending;
    }
    result = candidate.step();
  }
  assert(!result.ok);
  if (result.error.detail.reason !== 'native-preparation-incomplete') throw result.error;
  expect(result.error.detail.reason).toBe('native-preparation-incomplete');
}

// Native compute witness of the first-Source bridge; no raster/Level or cost acceptance.
type InitialSourceMode =
  | 'compute'
  | 'ordinary'
  | 'existing'
  | 'two'
  | 'shadow'
  | 'masked-shadow'
  | 'shadow-first'
  | 'point-first'
  | 'spot-first';
function hasPermanentMesh(mode: InitialSourceMode) {
  return mode === 'existing' || mode === 'two' || mode === 'shadow' || mode === 'masked-shadow';
}
async function nativeFirstSourceFixture(mode: InitialSourceMode) {
  let native: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const errors: unknown[] = [];
  const context = {
    configure(config: GPUCanvasConfiguration) {
      native = config.device;
      native.addEventListener('uncapturederror', (event) => errors.push(event.error));
      target?.destroy();
      target = native.createTexture({
        size: [64, 64],
        format: config.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: config.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      assert(target);
      return target;
    },
    unconfigure() {},
  };
  let f: Awaited<ReturnType<typeof levelNativeResourcesFixture>>;
  try {
    f = await levelNativeResourcesFixture(
      false,
      1,
      true,
      hasPermanentMesh(mode),
      {
        ...shaders,
        canvas: { width: 64, height: 64, getContext: () => context },
        backend: loadRhiPack(webgpu),
      },
      mode === 'masked-shadow' ? 0.5 : 0,
    );
  } catch (cause) {
    target?.destroy();
    native?.destroy();
    throw cause;
  }
  assert(native && target);
  return { f, native, target, errors };
}
async function prepareFirstSourceLights(
  f: Awaited<ReturnType<typeof levelNativeResourcesFixture>>,
  mode: InitialSourceMode,
) {
  if (mode !== 'compute') {
    f.world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [0, 0, -1],
          intensity: 10000,
          castShadow: mode === 'shadow' || mode === 'masked-shadow' || mode === 'shadow-first',
          mapSize: 2048,
          cascadeCount: 3,
        },
      })
      .unwrap();
    if (mode === 'point-first')
      f.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 3] } },
          { component: PointLight, data: { range: 10, intensity: 1000 } },
          { component: PointLightShadow, data: { mapSize: 128 } },
        )
        .unwrap();
    if (mode === 'spot-first')
      f.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 3] } },
          {
            component: SpotLight,
            data: {
              direction: [0, 0, -1],
              range: 10,
              intensity: 1000,
              castShadow: true,
              mapSize: 128,
            },
          },
        )
        .unwrap();
    await f.draw();
  }
}
async function finishSourceViews(work: SourceViewPreparation, draw?: () => Promise<unknown>) {
  for (let step = 0; step < 1000; step++) {
    const next = work.next();
    if (next.done) return;
    if (next.value instanceof Promise) await next.value;
    if (draw !== undefined)
      expect(((await draw()) as { presentation: string }).presentation).toBe('ready');
  }
  throw Error('Native source preparation did not complete');
}

async function prepareCurrentNativeSource(
  f: Awaited<ReturnType<typeof levelNativeResourcesFixture>>,
  source: import('../scene/staged-mesh-source').StagedMeshSource,
  draw: (() => Promise<unknown>) | undefined,
  tasks: SourceViewPreparation[],
  capture?: (view: GpuDrivenView) => void,
): Promise<SourceViewPreparation> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const work = f.manager.prepareInitialSourceViews(
      source.group,
      () => source.isCurrent(),
      capture,
    );
    tasks.push(work);
    try {
      await finishSourceViews(work, draw);
      if (work.isCurrent()) return work;
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'the completed current native demand',
        hint: 'reprepare an obsolete native demand',
      });
    } catch (cause) {
      if (
        !(cause instanceof RhiError) ||
        cause.code !== 'rhi-descriptor-invalid' ||
        !work.isObsolete()
      )
        throw cause;
      (await work.retire()).unwrap();
    }
  }
  throw Error('Native demand never settled within eight complete owner attempts');
}

async function retireCandidate(candidate: LevelCandidate) {
  for (let step = 0; candidate.inspect().phase !== 'retired' && step < 10000; step++) {
    const state = candidate.retireStep().unwrap();
    if (state.render?.pending !== undefined) await state.render.pending;
  }
  expect(candidate.inspect().phase).toBe('retired');
}

async function prepareSiblingSource(
  f: Awaited<ReturnType<typeof levelNativeResourcesFixture>>,
  source: import('../scene/staged-mesh-source').StagedMeshSource,
  work: SourceViewPreparation,
  stagedSource: () => typeof source,
  extraCandidates: LevelCandidate[],
  extraWork: SourceViewPreparation[],
) {
  const second = f.createCandidate();
  extraCandidates.push(second);
  await prepareData(second, f.draw);
  const nextSource = stagedSource();
  const prepare = (original: typeof source) =>
    prepareCurrentNativeSource(f, original, f.draw, extraWork);
  const secondWork = await prepare(nextSource);
  if (!work.isCurrent()) {
    (await work.retire()).unwrap();
    work = await prepare(source);
  }
  expect(work.isCurrent()).toBe(true);
  expect(secondWork.isCurrent()).toBe(true);
  return work;
}

async function retireNativeEvidence(
  f: Awaited<ReturnType<typeof levelNativeResourcesFixture>>,
  graph: CompiledRenderGraph<{ encoder: RhiCommandEncoder }> | undefined,
  readback: Buffer | undefined,
  resources: GpuSceneResourceFrame | undefined,
  attempt: (run: () => unknown | Promise<unknown>) => Promise<void>,
) {
  const ownedGraph = graph;
  if (ownedGraph !== undefined) await attempt(async () => (await ownedGraph.retire()).unwrap());
  await attempt(() => f.internals.device.queue.onSubmittedWorkDone());
  await attempt(() => resources?.release());
  const ownedReadback = readback;
  if (ownedReadback !== undefined)
    await attempt(() => f.internals.device.destroyBuffer(ownedReadback).unwrap());
}

async function firstSourceNative(
  mode: InitialSourceMode,
  configureDevice: (device: RhiDevice) => void = () => {},
) {
  const { f, native, target, errors } = await nativeFirstSourceFixture(mode);
  assert(native);
  native.pushErrorScope('validation');
  const failures: unknown[] = [];
  const attempt = async (run: () => unknown | Promise<unknown>) => {
    try {
      await run();
    } catch (cause) {
      failures.push(cause);
    }
  };
  const composition = f.internals.sceneComposition;
  assert(composition);
  const entry = composition.entry;
  assert(entry);
  const begin = composition.beginStagedGroup.bind(composition);
  let staged: ReturnType<typeof begin> | undefined;
  const capture = vi.spyOn(composition, 'beginStagedGroup').mockImplementation((...args) => {
    staged = begin(...args);
    return staged;
  });
  const extraCandidates: LevelCandidate[] = [];
  const extraWork: SourceViewPreparation[] = [];
  let view: GpuDrivenView | undefined;
  let work: SourceViewPreparation | undefined;
  let plan: SubmissionPlan | undefined;
  let graph: CompiledRenderGraph<{ encoder: RhiCommandEncoder }> | undefined;
  let readback: Buffer | undefined;
  let resources: GpuSceneResourceFrame | undefined;
  let observe: { mockRestore(): void } | undefined;
  try {
    configureDevice(f.internals.device);
    await prepareFirstSourceLights(f, mode);
    await prepareData(f.candidate, f.draw);
    assert(staged?.ok);
    const source = staged.value;
    expect(composition.entry).toBe(entry);
    if (hasPermanentMesh(mode))
      expect(f.manager.currentOwner.gpuDriven.resourceGeneration).toBeDefined();
    work = await prepareCurrentNativeSource(
      f,
      source,
      hasPermanentMesh(mode) ? f.draw : undefined,
      extraWork,
      (created) => {
        observe?.mockRestore();
        view = created;
        const original = created.prepareInitialTopology.bind(created);
        observe = vi
          .spyOn(created, 'prepareInitialTopology')
          .mockImplementation((prepared, ...args) => {
            plan = prepared;
            return original(prepared, ...args);
          });
      },
    );
    expect(work.isCurrent()).toBe(true);
    if (mode === 'two')
      work = await prepareSiblingSource(
        f,
        source,
        work,
        () => {
          assert(staged?.ok);
          return staged.value;
        },
        extraCandidates,
        extraWork,
      );
    assert(view);
    assert(plan);
    expect(entry.topology.captureResidencySelection().includes(source.group)).toBe(false);
    if (mode === 'compute') {
      const creates = vi.spyOn(f.internals.device, 'createBuffer');
      const groups = vi.spyOn(f.internals.device, 'createBindGroup');
      try {
        resources = f.scene.captureResources().unwrap();
        view
          .update(
            plan,
            f.scene,
            resources.inputReads(),
            frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create())),
          )
          .unwrap();
        resources.seal().unwrap();
        expect(creates).not.toHaveBeenCalled();
        expect(groups).not.toHaveBeenCalled();
      } finally {
        creates.mockRestore();
        groups.mockRestore();
      }
      const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
      view.addPasses(builder).unwrap();
      graph = builder
        .compile({ device: f.internals.device, surfaceSize: { width: 1, height: 1 } })
        .unwrap();
      const extent = Math.max(...Array.from(plan.batches, (batch) => batch.indirectOffset + 20));
      readback = f.internals.device.createBuffer({ size: extent, usage: 1 | 8 }).unwrap();
      const encoder = f.internals.device.createCommandEncoder().unwrap();
      graph.execute({ encoder }).unwrap();
      assert(view.indirectBuffer);
      encoder.copyBufferToBuffer(view.indirectBuffer, 0, readback, 0, extent);
      f.internals.device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await f.internals.device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      try {
        const data = new DataView(mapped.getMappedRange().unwrap());
        const count = Array.from(plan.batches).reduce(
          (sum, batch) => sum + data.getUint32(batch.indirectOffset + 4, true),
          0,
        );
        expect(count).toBe(plan.candidateCount);
        expect(count).toBeGreaterThan(0);
      } finally {
        mapped.unmap();
      }
    }
    if (mode !== 'compute') {
      const owner = f.manager.currentOwner;
      const prepared = hasPermanentMesh(mode)
        ? owner.frameState.compiledFrameGraph
        : owner.frameState.unsubmittedCompiledFrameGraph?.installed;
      assert(prepared);
      const indirectBytes = view.inspect().indirectCapacity * 40;
      const commandReadback = f.internals.device
        .createBuffer({ size: indirectBytes, usage: 1 | 8 })
        .unwrap();
      readback = commandReadback;
      const readCommands = async () => {
        assert(view?.indirectBuffer);
        const encoder = f.internals.device.createCommandEncoder().unwrap();
        encoder.copyBufferToBuffer(view.indirectBuffer, 0, commandReadback, 0, indirectBytes);
        f.internals.device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const mapped = (await commandReadback.mapAsync(1)).unwrap();
        try {
          return new Uint32Array(mapped.getMappedRange().unwrap()).slice();
        } finally {
          mapped.unmap();
        }
      };

      const buffers = vi.spyOn(f.internals.device, 'createBuffer');
      const bindings = vi.spyOn(f.internals.device, 'createBindGroup');
      const pipelines = vi.spyOn(f.internals.device, 'createRenderPipeline');
      const asyncPipelines = vi.spyOn(f.internals.device, 'createRenderPipelineAsync');
      const computePipelines = vi.spyOn(f.internals.device, 'createComputePipeline');
      const asyncComputePipelines = vi.spyOn(f.internals.device, 'createComputePipelineAsync');
      const samplers = vi.spyOn(f.internals.device, 'createSampler');
      const textureUploads = vi.spyOn(f.internals.device.queue, 'writeTexture');
      const bundles = vi.spyOn(f.internals.device, 'createRenderBundleEncoder');
      const textures = vi.spyOn(f.internals.device, 'createTexture');
      const textureViews = vi.spyOn(f.internals.device, 'createTextureView');
      const groupLayouts = vi.spyOn(f.internals.device, 'createBindGroupLayout');
      const pipelineLayouts = vi.spyOn(f.internals.device, 'createPipelineLayout');
      const modules = vi.spyOn(native, 'createShaderModule');

      try {
        expect((await f.draw()).presentation).toBe('ready');
        expect(owner.frameState.compiledFrameGraph?.graph).toBe(prepared.graph);
        expect(owner.frameState.unsubmittedCompiledFrameGraph).toBeUndefined();
        assert(target);
        const before = await canvasPixels(native, target);
        const nativeSpies = [
          buffers,
          bindings,
          pipelines,
          asyncPipelines,
          computePipelines,
          asyncComputePipelines,
          samplers,
          textureUploads,
          bundles,
          textures,
          textureViews,
          groupLayouts,
          pipelineLayouts,
          modules,
        ];
        for (const spy of nativeSpies) spy.mockClear();
        // Renderer-owner integration only: App/native/Physics qualification remains closed.
        entry.topology.setResidencyGroupActive(source.group, true);
        f.world.update(1 / 60).unwrap();
        propagateTransforms(f.world).unwrap();
        const submitted = f.renderer.draw({ source: f.source });
        if (!submitted.ok) throw submitted.error;
        const displayed = submitted.value;
        const completed = await displayed.completed;
        if (!completed.ok) throw completed.error;
        expect(
          displayed.presentation,
          JSON.stringify({
            reason: displayed.presentationPendingReason,
            pipelines: pipelines.mock.calls.map(([d]) => d.label),
            async: asyncPipelines.mock.calls.map(([d]) => d.label),
          }),
        ).toBe('ready');
        expect(owner.frameState.compiledFrameGraph?.graph).toBe(prepared.graph);
        const after = await canvasPixels(native, target);
        const shownCommands = await readCommands();
        const targetOffsets = Array.from(plan.batches)
          .filter((batch) => batch.key.residencyGroup === source.group.id)
          .map((batch) => batch.indirectOffset / 4 + 1);
        expect(targetOffsets.length).toBeGreaterThan(0);
        expect(targetOffsets.some((offset) => (shownCommands[offset] ?? 0) > 0)).toBe(true);

        expect(
          after.reduce((count, value, index) => count + Number(value !== before[index]), 0),
        ).toBeGreaterThan(64);
        const created = () => ({
          buffers: buffers.mock.calls.map(([entry]) => entry.label),
          bindings: bindings.mock.calls.map(([entry]) => entry.label),
          renderPipelines: pipelines.mock.calls.map(([entry]) => entry.label),
          asyncRenderPipelines: asyncPipelines.mock.calls.map(([entry]) => entry.label),
          computePipelines: computePipelines.mock.calls.map(([entry]) => entry.label),
          asyncComputePipelines: asyncComputePipelines.mock.calls.map(([entry]) => entry.label),
          samplers: samplers.mock.calls.map(([entry]) => entry?.label),
          textureUploads: textureUploads.mock.calls.length,
          bundles: bundles.mock.calls.map(([entry]) => entry.label),
          textures: textures.mock.calls.map(([entry]) => entry.label),
          textureViews: textureViews.mock.calls.map(([, entry]) => entry),
          groupLayouts: groupLayouts.mock.calls.map(([entry]) => entry.label),
          pipelineLayouts: pipelineLayouts.mock.calls.map(([entry]) => entry.label),
          modules: modules.mock.calls.map(([entry]) => entry.label),
        });
        const expectedCreates = {
          buffers: [],
          bindings: [],
          renderPipelines: [],
          asyncRenderPipelines: [],
          computePipelines: [],
          asyncComputePipelines: [],
          samplers: [],
          textureUploads: 0,
          bundles: [],
          textures: [],
          textureViews: [],
          groupLayouts: [],
          pipelineLayouts: [],
          modules: [],
        };
        expect(created()).toEqual(expectedCreates);
        expect(work.isCurrent()).toBe(true);
        for (const active of [false, true, false, true]) {
          for (const spy of nativeSpies) spy.mockClear();
          entry.topology.setResidencyGroupActive(source.group, active);
          expect((await f.draw()).presentation).toBe('ready');
          expect(owner.frameState.compiledFrameGraph?.graph).toBe(prepared.graph);
          const pixels = await canvasPixels(native, target);
          const expected = active ? after : before;
          expect(
            pixels.reduce(
              (differences, value, index) => differences + Number(value !== expected[index]),
              0,
            ),
          ).toBe(0);

          const commands = await readCommands();
          if (!active)
            for (const offset of targetOffsets) {
              expect(commands[offset]).toBe(0);
              expect(commands[offset + indirectBytes / 8]).toBe(0);
            }
          expect(created()).toEqual(expectedCreates);
          expect(work.isCurrent()).toBe(true);
        }
      } finally {
        buffers.mockRestore();
        bindings.mockRestore();
        pipelines.mockRestore();
        asyncPipelines.mockRestore();
        computePipelines.mockRestore();
        asyncComputePipelines.mockRestore();
        samplers.mockRestore();
        textureUploads.mockRestore();
        bundles.mockRestore();
        textures.mockRestore();
        textureViews.mockRestore();
        groupLayouts.mockRestore();
        pipelineLayouts.mockRestore();
        modules.mockRestore();
        entry.topology.setResidencyGroupActive(source.group, false);
      }
    }
    expect(await native.popErrorScope()).toBeNull();
    expect(errors).toEqual([]);
  } catch (cause) {
    failures.push(cause);
  } finally {
    capture.mockRestore();
    observe?.mockRestore();
    await retireNativeEvidence(f, graph, readback, resources, attempt);
    for (const task of extraWork) await attempt(async () => (await task.retire()).unwrap());
    for (const candidate of extraCandidates)
      await attempt(async () => {
        await retireCandidate(candidate);
      });
    const ownedWork = work;
    if (ownedWork !== undefined) await attempt(async () => (await ownedWork.retire()).unwrap());
    await attempt(async () => {
      await retireCandidate(f.candidate);
    });
    await attempt(async () => {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    });
    await attempt(() => target?.destroy());
    await attempt(() => native?.destroy());
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Native first-Source View failed');
}

async function canvasPixels(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const buffer = device.createBuffer({
    size: 64 * 64 * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer, bytesPerRow: 256 },
      { width: 64, height: 64 },
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    return bytes;
  } finally {
    buffer.destroy();
  }
}

it(
  'consumes actual first-Source prepared topology, Inputs and bindings without a warm Mesh',
  () => firstSourceNative('compute'),
  30000,
);
it(
  'promotes the real first-Source graph into the first ordinary raster frame without cold creation',
  () => firstSourceNative('ordinary'),
  30000,
);

it(
  'prepares a cold target on the existing ordinary GPU View without first-use work',
  () => firstSourceNative('existing'),
  30000,
);

it(
  'retains two cold Source qualifications after shared View capacity growth',
  () => firstSourceNative('two'),
  30000,
);

it(
  'prepares the actual directional shadow consumer without first-use native work',
  () => firstSourceNative('shadow'),
  30000,
);

it('prepares and draws directional Level shadows on the native direct command lane', async () => {
  const bundles = vi.spyOn(GpuDrivenView.prototype, 'resolveShadowBundle');
  try {
    await firstSourceNative('shadow', (device) => {
      Object.defineProperty(device, 'caps', {
        value: { ...device.caps, nativeVertexOnlyRenderBundles: false },
      });
    });
    expect(bundles).not.toHaveBeenCalled();
  } finally {
    bundles.mockRestore();
  }
}, 30000);

it(
  'prepares alpha-mask shadow bindings before the first ordinary raster',
  () => firstSourceNative('masked-shadow'),
  30000,
);
it(
  'prepares first-Level shadow Views and passes without a permanent Mesh',
  () => firstSourceNative('shadow-first'),
  30000,
);

it.each(['point-first', 'spot-first'] as const)(
  'prepares first-Level %s physical Views and shadow commands',
  (mode) => firstSourceNative(mode),
  30000,
);
