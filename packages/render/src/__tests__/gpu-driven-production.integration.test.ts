import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack';
import {
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type BindGroup, type Buffer, type Result, RhiError } from '@forgeax/engine-rhi';
import {
  RhiNullCommandEncoder,
  RhiNullDevice,
  type RhiNullDevice as RhiNullDeviceType,
  RhiNullQueue,
  RhiNullRenderPassEncoder,
  rhi,
} from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { deriveMaterialDynamicInputLayout, err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { materialParametersToParamSchema } from '../../../assets-runtime/src/material/runtime-shader';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { derive } from '../../../types/src/index';
import { createRenderer as constructRenderer } from '../assembly/factory';
import { resolveMaterialPipelineVertexEntry } from '../assembly/material/pipeline-helpers';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, PointLight } from '../components';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { PreparedRasterBundleCache } from '../gpu-driven/prepared-raster-bundle';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import {
  MaterialAbiRasterAdapter,
  resolveGpuDrivenMeshGroup,
} from '../gpu-driven/production-raster-material';
import { GPU_DRIVEN_BATCH_STRIDE, GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS, gpuSceneFieldOffset } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { RhiErrorListenerRegistry } from '../lifecycle';
import { MaterialResource } from '../material-resource';
import { Materials } from '../materials';
import { createRenderPublisher } from '../publication/publisher';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import {
  makeZeroCameraFallbackSnapshot,
  type RenderFrameState,
  worldEntityKey,
} from '../record/frame-snapshot';
import * as gpuDrawReceipts from '../record/gpu-draw-receipts';
import * as mainPass from '../record/main-pass';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import { STANDARD_OPAQUE_FRAGMENT_ENTRY } from '../record/standard-opaque-entry';
import { ensureCompiledFrameGraph, executeCompiledFrameGraph } from '../record/typed-frame-graph';
import type { RenderPipeline, RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { PersistentRenderScene, RenderScene } from '../scene/render-scene';
import { ReadonlyDynamicInputPage } from '../surface/dynamic-input';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../temporal/frame';
import type { ViewLights } from '../world/render-lights';
import {
  admitGpuFixture,
  mesh,
  preparedPbrSnapshot as preparedPbrFixture,
  snapshot,
  standardPbrInputs,
  updateSnapshot,
} from './gpu-driven-production-fixture';
import { renderLifecycleManifestUrl, standardPbrFixtureVariants } from './shader-manifest-fixture';

const STANDARD_PBR_RECEIPT = createStandardPbrArtifactReceipt();

describe('GPU-driven scene-index mesh address selection', () => {
  it('keeps direct batches on their local group and rebuilds clustered group(2) around the same projection buffer', () => {
    const directGroup = {} as BindGroup;
    const clusteredGroup = {} as BindGroup;
    const legacyClusterGroup = {} as BindGroup;
    const transformBuffer = {} as Buffer;
    const clusterBindGroupForMesh = vi.fn(() => clusteredGroup);
    const frameResources = { clusterBindGroup: legacyClusterGroup, clusterBindGroupForMesh };

    expect(
      resolveGpuDrivenMeshGroup({
        clustered: false,
        deformation: 'rigid',
        meshBindGroup: directGroup,
        sceneTransformBuffer: transformBuffer,
        sceneTransformBytes: 256,
        frameResources,
      }),
    ).toBe(directGroup);
    expect(clusterBindGroupForMesh).not.toHaveBeenCalled();

    expect(
      resolveGpuDrivenMeshGroup({
        clustered: true,
        deformation: 'rigid',
        meshBindGroup: directGroup,
        sceneTransformBuffer: transformBuffer,
        sceneTransformBytes: 512,
        frameResources,
      }),
    ).toBe(clusteredGroup);
    expect(clusterBindGroupForMesh).toHaveBeenCalledExactlyOnceWith(transformBuffer, 512);
  });

  it('rebuilds clustered skin group(2) from the matching scene-index mesh and palette pages', () => {
    const directSkinGroup = {} as BindGroup;
    const clusteredSkinGroup = {} as BindGroup;
    const transformBuffer = {} as Buffer;
    const paletteBuffer = {} as Buffer;
    const task = {
      data: paletteBuffer,
      auxiliary: {} as Buffer,
      dataOffset: 0,
      auxiliaryOffset: 768,
      dataSize: 1024,
      auxiliarySize: 16,
      jointCount: 0,
      flags: 0,
    };
    const clusterBindGroupForSkin = vi.fn(() => clusteredSkinGroup);

    expect(
      resolveGpuDrivenMeshGroup({
        clustered: true,
        deformation: 'skin',
        meshBindGroup: directSkinGroup,
        sceneTransformBuffer: transformBuffer,
        sceneTransformBytes: 768,
        skinTaskBinding: task,
        frameResources: { clusterBindGroupForSkin },
      }),
    ).toBe(clusteredSkinGroup);
    expect(clusterBindGroupForSkin).toHaveBeenCalledExactlyOnceWith(transformBuffer, 768, task);
  });
});

interface BufferWrite {
  readonly buffer: Buffer;
  readonly offset: number;
  readonly bytes: Uint8Array;
}

class RecordingQueue extends RhiNullQueue {
  readonly writes: BufferWrite[] = [];

  override writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): Result<void, RhiError> {
    const source =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const start = dataOffset ?? 0;
    const length = size ?? source.byteLength - start;
    this.writes.push({
      buffer,
      offset: bufferOffset,
      bytes: source.slice(start, start + length),
    });
    return super.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
  }
}

function recordingDevice(queue: RecordingQueue): RhiNullDeviceType {
  return new RhiNullDevice(
    queue,
    (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
  );
}

const OUTPUT_TRANSFORM_WGSL =
  '@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { ' +
  'var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)); ' +
  'return vec4<f32>(p[i], 0.0, 1.0); } ' +
  '@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }';

const STANDARD_PBR_URP_VARIANT_KEY =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false';
const STANDARD_PBR_TRANSMISSION_VARIANT_KEY =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';

function manifestDataUrl(
  pbrWgsl = '/* pbr stub - calls f_schlick( */',
  withReceipt = false,
): string {
  const unlitWgsl = '/* unlit stub */';
  const tonemapWgsl = OUTPUT_TRANSFORM_WGSL;
  const standardPbrVariant = (transmissionAvailable: boolean, definesKey: string) => ({
    definesKey,
    defines: {
      CLUSTER_FORWARD_AVAILABLE: false,
      STORAGE_BUFFER_AVAILABLE: true,
      TRANSMISSION_AVAILABLE: transmissionAvailable,
      VERTEX_COLOR_AVAILABLE: false,
    },
    composedWgsl: pbrWgsl,
    ...(withReceipt ? { receipt: STANDARD_PBR_RECEIPT } : {}),
  });
  const materialShader = (
    identifier: string,
    paramSchema: readonly unknown[],
    composedWgsl: string,
    variants: readonly unknown[] = [],
  ) => ({
    identifier,
    sourcePath: `${identifier}.wgsl`,
    composedWgsl,
    paramSchema: JSON.stringify(paramSchema),
    variants,
    ...(withReceipt && identifier === 'forgeax::default-standard-pbr'
      ? { receipt: STANDARD_PBR_RECEIPT }
      : {}),
  });
  return `data:application/json,${encodeURIComponent(
    JSON.stringify({
      entries: [
        { hash: 'pbr00000', wgsl: pbrWgsl, glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: unlitWgsl, glsl: '', bindings: '' },
        { hash: 'tonemap0', wgsl: tonemapWgsl, glsl: '', bindings: '' },
      ],
      materialShaders: [
        materialShader(
          'forgeax::default-standard-pbr',
          DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
          pbrWgsl,
          [
            standardPbrVariant(false, STANDARD_PBR_URP_VARIANT_KEY),
            standardPbrVariant(true, STANDARD_PBR_TRANSMISSION_VARIANT_KEY),
          ],
        ),
        materialShader('forgeax::default-unlit', DEFAULT_UNLIT_PARAM_SCHEMA, unlitWgsl),
      ],
    }),
  )}`;
}

describe('GPU-driven production projection', () => {
  it.each([
    'build',
    'hit',
  ] as const)('aborts Renderer submission and source acknowledgment when a prepared bundle %s is rejected', async (path) => {
    const submitted = vi.fn();
    const acknowledged = vi.fn();
    const aborted = vi.fn();
    const renderer = await constructRenderer(
      {
        width: 16,
        height: 16,
        getContext: () => null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as HTMLCanvasElement,
      {
        rhi,
        features: [
          {
            identity: 'prepared-bundle-failure-source',
            extract: () => ok(1),
            plan: () =>
              ok({
                work: [{ scope: 'frame', resources: [], passes: [] }],
                sourceFeedback: 'consumed',
              }),
            onFrameSubmitted: submitted,
            onSourceFrameSubmitted: acknowledged,
            onFrameAborted: aborted,
          },
        ],
      },
      { shaderManifestUrl: manifestDataUrl(`/* f_schlick( */ ${OUTPUT_TRANSFORM_WGSL}`, true) },
    );
    const recorded = new Set<unknown>();
    const begin = PreparedRasterBundleCache.prototype.begin;
    const bundles = vi
      .spyOn(PreparedRasterBundleCache.prototype, 'begin')
      .mockImplementation(function (this: PreparedRasterBundleCache, ...args) {
        const recording = begin.apply(this, args);
        const finish = recording.finish.bind(recording);
        recording.finish = () => {
          const bundle = finish();
          recorded.add(bundle);
          return bundle;
        };
        return recording;
      });
    const executeOriginal = RhiNullRenderPassEncoder.prototype.executeBundles;
    const execute = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'executeBundles');
    const submit = vi.spyOn(renderer.device.queue, 'submit');
    const failure = new RhiError({
      code: 'rhi-not-available',
      expected: 'injected backend rejection of a prepared raster bundle',
      hint: 'retry the same source after the backend accepts commands',
    });
    let rejected = false;
    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const assets = renderer.assetRegistry;
      const world = new World({ assets });
      const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
      const attached = renderer.attach(world);
      if (!attached.ok) throw attached.error;
      const lease = attached.value;
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: cube } },
          {
            component: MeshRenderer,
            data: {
              materials: [assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap()],
            },
          },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const input = { leases: [lease], camera: { lease }, environment: { lease } };
      if (path === 'hit') {
        const drawn = renderer.draw(input);
        if (!drawn.ok) throw drawn.error;
        const first = drawn.value;
        if (first === undefined) throw new Error('missing first submission receipt');
        const completed = await first.completed;
        if (!completed.ok) throw completed.error;
        expect(bundles).toHaveBeenCalled();
      }
      // A hit replays a bundle recorded by the first frame without re-recording it.
      bundles.mockClear();
      submit.mockClear();
      submitted.mockClear();
      acknowledged.mockClear();
      aborted.mockClear();
      errors.length = 0;
      const before = renderer.inspect().renderScene.gpuDriven;
      execute.mockImplementation(function (this: RhiNullRenderPassEncoder, handles) {
        const values = [...handles];
        if (!rejected && values.some((bundle) => recorded.has(bundle))) {
          rejected = true;
          return err(failure);
        }
        return executeOriginal.call(this, values);
      });
      const refused = renderer.draw(input);
      expect(rejected).toBe(true);
      const after = renderer.inspect().renderScene.gpuDriven;
      expect(
        path === 'hit'
          ? (after.preparedBundleHits ?? 0) - (before.preparedBundleHits ?? 0)
          : (after.preparedBundleBuilds ?? 0) - (before.preparedBundleBuilds ?? 0),
      ).toBeGreaterThan(0);
      expect(refused.ok).toBe(false);
      expect(submit).not.toHaveBeenCalled();
      expect(submitted).not.toHaveBeenCalled();
      expect(acknowledged).not.toHaveBeenCalled();
      expect(aborted).toHaveBeenCalledOnce();
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ detail: expect.objectContaining({ cause: failure }) }),
        ]),
      );
      const retried = renderer.draw(input);
      if (!retried.ok) throw retried.error;
      const retry = retried.value;
      if (retry === undefined) throw new Error('missing successful retry receipt');
      const completed = await retry.completed;
      if (!completed.ok) throw completed.error;
      expect(submit).toHaveBeenCalledOnce();
      expect(submitted).toHaveBeenCalledOnce();
      expect(acknowledged).toHaveBeenCalledOnce();
      expect(renderer.inspect().renderScene.gpuDriven.encodedIndirectDraws).toBeGreaterThan(0);
    } finally {
      execute.mockRestore();
      bundles.mockRestore();
      submit.mockRestore();
      renderer.dispose();
    }
  });

  it('never replays a retained raster run that names a visible window from before a ProbeBlend buffer replacement', async () => {
    const renderer = await constructRenderer(
      {
        width: 16,
        height: 16,
        getContext: () => null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as HTMLCanvasElement,
      { rhi },
      { shaderManifestUrl: manifestDataUrl(`/* f_schlick( */ ${OUTPUT_TRANSFORM_WGSL}`, true) },
    );
    // Visible-window bind groups the material adapter hands out, and the ones a
    // ProbeBlend replacement has since reset.
    const windows = new Set<BindGroup>();
    const stale = new Set<BindGroup>();
    const createWindow = MaterialAbiRasterAdapter.prototype.visibleWindowBindGroupForBuffer;
    const windowSpy = vi
      .spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer')
      .mockImplementation(function (this: MaterialAbiRasterAdapter, ...args) {
        const group = createWindow.apply(this, args);
        if (group.ok) windows.add(group.value);
        return group;
      });
    let replacement: Buffer | undefined;
    const ensureProbe = MaterialAbiRasterAdapter.prototype.ensureProbeBlendRecordBuffer;
    const probeSpy = vi
      .spyOn(MaterialAbiRasterAdapter.prototype, 'ensureProbeBlendRecordBuffer')
      .mockImplementation(function (this: MaterialAbiRasterAdapter, buffer) {
        return ensureProbe.call(this, replacement ?? buffer);
      });
    // Bind groups each recorded bundle names.
    const named = new WeakMap<object, readonly unknown[]>();
    const createBundle = RhiNullDevice.prototype.createRenderBundleEncoder;
    const bundleSpy = vi
      .spyOn(RhiNullDevice.prototype, 'createRenderBundleEncoder')
      .mockImplementation(function (this: RhiNullDevice, desc) {
        const created = createBundle.call(this, desc);
        if (!created.ok) return created;
        const encoder = created.value;
        const groups: unknown[] = [];
        const setBindGroup = encoder.setBindGroup.bind(encoder);
        const finish = encoder.finish.bind(encoder);
        return ok(
          Object.assign(encoder, {
            setBindGroup: (...args: Parameters<typeof encoder.setBindGroup>) => {
              groups.push(args[1]);
              return setBindGroup(...args);
            },
            finish: () => {
              const bundle = finish();
              if (bundle.ok) named.set(bundle.value as object, groups);
              return bundle;
            },
          }),
        );
      });
    const executed: object[] = [];
    const executeOriginal = RhiNullRenderPassEncoder.prototype.executeBundles;
    const execute = vi
      .spyOn(RhiNullRenderPassEncoder.prototype, 'executeBundles')
      .mockImplementation(function (this: RhiNullRenderPassEncoder, handles) {
        const values = [...handles];
        executed.push(...(values as object[]));
        return executeOriginal.call(this, values);
      });
    const windowsOf = (bundles: readonly object[]) =>
      bundles.flatMap((bundle) =>
        (named.get(bundle) ?? []).filter((group) => windows.has(group as BindGroup)),
      );
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const assets = renderer.assetRegistry;
      const world = new World({ assets });
      const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
      const attached = renderer.attach(world);
      if (!attached.ok) throw attached.error;
      const lease = attached.value;
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: cube } },
          {
            component: MeshRenderer,
            data: {
              materials: [assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap()],
            },
          },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const input = { leases: [lease], camera: { lease }, environment: { lease } };
      const frame = async () => {
        executed.length = 0;
        const drawn = renderer.draw(input);
        if (!drawn.ok) throw drawn.error;
        const receipt = drawn.value;
        if (receipt === undefined) throw new Error('missing submission receipt');
        const completed = await receipt.completed;
        if (!completed.ok) throw completed.error;
        return [...executed];
      };
      await frame();
      const hits = () => renderer.inspect().renderScene.gpuDriven.preparedBundleHits ?? 0;
      const hitsBefore = hits();
      const replayed = await frame();
      // The unchanged second frame replays a retained run that names a visible window.
      expect(hits()).toBeGreaterThan(hitsBefore);
      expect(windowsOf(replayed).length).toBeGreaterThan(0);
      // The Renderer's ProbeBlend buffer is replaced: the adapter resets every
      // visible-window bind group while the live raster owners persist.
      for (const group of windows) stale.add(group);
      replacement = renderer.device
        .createBuffer({ size: 4096, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST })
        .unwrap();
      const rebound = await frame();
      const windowsAfter = windowsOf(rebound);
      expect(windowsAfter.length).toBeGreaterThan(0);
      expect(windowsAfter.filter((group) => stale.has(group as BindGroup))).toEqual([]);
      // The rebuilt run is retained again under the new window identity.
      const settled = await frame();
      expect(windowsOf(settled).filter((group) => stale.has(group as BindGroup))).toEqual([]);
    } finally {
      execute.mockRestore();
      bundleSpy.mockRestore();
      probeSpy.mockRestore();
      windowSpy.mockRestore();
      renderer.dispose();
    }
  });

  it('preserves cooked material facts across published automatic and direct geometry lanes', async () => {
    const guid = '019f0000-0000-7000-8000-0000000007a2';
    const authored = Materials.standard({
      baseColor: [0.8, 0.2, 0.1, 1],
      roughness: 0.37,
      specular: 0.63,
      staticSwitches: { alphaClipping: false, alphaHash: false, displacement: false },
    });
    const cooked = await createMaterialPackCooker().cook({ guid, source: authored });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const wire = JSON.parse(serializeCookedMaterialRecord(record));
    const identity = { source: 'static-shadow-publication', epoch: 1 };
    const manifest = renderLifecycleManifestUrl();
    const queue = new RecordingQueue();
    const device = recordingDevice(queue);
    const adapter = (await rhi.requestAdapter()).unwrap();
    const requestDevice = vi.spyOn(adapter, 'requestDevice').mockResolvedValue(ok(device));
    const renderer = await constructRenderer(
      {
        width: 32,
        height: 32,
        getContext: () => null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as HTMLCanvasElement,
      {
        rhi: { ...rhi, requestAdapter: async () => ok(adapter) },
        publicationSource: identity,
      },
      { shaderManifestUrl: manifest },
    );
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: manifest }),
    });
    const world = new World({ assets });
    const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const publisher = createRenderPublisher(world, assets, identity, device.caps);
    const prepare = vi.spyOn(GpuDrivenProduction.prototype, 'prepare');
    const directDraws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed');
    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const publishedMaterial = { ...authored, cooked: wire };
      publishRuntimeAssets(assets, [{ guid, asset: publishedMaterial }]);
      const parsed = AssetGuid.parse(guid);
      if (!parsed.ok) throw parsed.error;
      const load = await assets.load(parsed.value, 'material');
      if (!load.ok) throw load.error;
      const loaded = load.value;

      const forward = record.programs
        .flatMap((program) => program.selections)
        .find(
          (selection) =>
            selection.pass === 'forward' &&
            selection.address === 'scene-index' &&
            selection.context.capability === 'storage-buffer',
        );
      const shadow = record.programs
        .flatMap((program) => program.selections)
        .find(
          (selection) =>
            selection.pass === 'shadow-caster' &&
            selection.address === 'scene-index' &&
            selection.context.capability === 'storage-buffer',
        );
      expect(forward?.abi?.vertexInputs.some((input) => input.semantic === 'normal')).toBe(true);
      expect(shadow?.abi?.vertexInputs.map((input) => input.semantic)).toEqual(['position']);
      expect(shadow?.abi?.receiptIdentity).not.toBe(forward?.abi?.receiptIdentity);
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      world
        .spawn({
          component: DirectionalLight,
          data: { direction: [0.25, -1, -0.45], castShadow: true, mapSize: 64 },
        })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: cube } },
          {
            component: MeshRenderer,
            data: { materials: [loaded] },
          },
        )
        .unwrap();
      world.update(1 / 60).unwrap();
      const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.message),
      });
      candidate.accept();
      const drawn = renderer.draw({ publication: encodeRenderPublication(packet) });
      const prepared = prepare.mock.results.at(-1)?.value;
      expect(prepared).toMatchObject({
        ok: true,
        value: { shadowDirectRequired: false },
      });
      expect(errors).toEqual([]);
      if (!drawn.ok) throw drawn.error;
      const receipt = drawn.value;
      if (receipt === undefined) throw new Error('missing publication receipt');
      const completed = await receipt.completed;
      if (!completed.ok) throw completed.error;
      const state = renderer.inspect().renderScene;
      expect(state.projectionRecords).toBe(1);
      expect(state.gpuDriven.cpuFallbackDrawItems).toBe(0);
      expect(state.gpuDriven.gpuOwnedEntityCount).toBe(1);
      expect(state.gpuDriven.shadowViews.some((view) => view.candidateCount === 1)).toBe(true);
      const scene = prepare.mock.calls.at(-1)?.[0].scene?.scene;
      if (scene === undefined) throw new Error('missing production GPU Scene');
      const binding = prepare.mock.calls.at(-1)?.[0].scene?.plan.batches.at(0)?.binding;
      if (binding === undefined) throw new Error('expected material binding');
      const row = scene.materialIndexForResource(binding.material);
      if (row === undefined) throw new Error('missing uploaded material row');
      const writesBeforeObservation = queue.writes.length;
      const reads = scene.inputs.capture();
      const inputBuffer = reads.buffer().unwrap().buffer;
      reads.release();
      expect(queue.writes).toHaveLength(writesBeforeObservation);
      const pointerOffset = row * 4;
      const pointerWrite = queue.writes.filter(
        (write) =>
          write.buffer === inputBuffer &&
          write.offset <= pointerOffset &&
          write.offset + write.bytes.byteLength >= pointerOffset + 4,
      );
      const latestPointerWrite = pointerWrite.at(-1);
      if (latestPointerWrite === undefined) throw new Error('missing material descriptor upload');
      const address = new DataView(
        latestPointerWrite.bytes.buffer,
        latestPointerWrite.bytes.byteOffset + pointerOffset - latestPointerWrite.offset,
      ).getUint32(0, true);
      const offset = address * 16;
      const layout = derive(materialParametersToParamSchema(record.resolved.parameters));
      const writes = queue.writes.filter(
        (write) =>
          write.buffer === scene.materialBuffer &&
          write.offset <= offset &&
          write.offset + write.bytes.byteLength >= offset + layout.totalBytes,
      );
      const write = writes.at(-1);
      if (write === undefined) throw new Error('missing actual material page upload');
      const view = new DataView(write.bytes.buffer, write.bytes.byteOffset + offset - write.offset);
      for (const [name, value] of [
        ['roughness', 0.37],
        ['specular', 0.63],
      ] as const) {
        const member = layout.numericMembers.find((field) => field.name === name);
        if (member === undefined) throw new Error(`missing selected ${name}`);
        expect(view.getFloat32(member.offset, true)).toBeCloseTo(value, 6);
      }
      expect(layout.numericMembers.map((field) => field.name)).not.toContain('alphaCutoff');
      publisher
        .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
        .unwrap();
      for (const geometryLane of ['direct', 'automatic'] as const) {
        world.update(1 / 60).unwrap();
        const next = publisher.prepare(world.getResource(Time).elapsed).unwrap();
        const publication = structuredClone(next.packet, {
          transfer: renderPublicationTransfers(next.message),
        });
        next.accept();
        directDraws.mockClear();
        const drawn = renderer.draw({
          publication: encodeRenderPublication(publication),
          geometryLane,
        });
        expect(drawn.ok, JSON.stringify(errors)).toBe(true);
        if (!drawn.ok) throw drawn.error;
        const receipt = drawn.value;
        if (receipt === undefined) throw new Error('missing publication receipt');
        const completed = await receipt.completed;
        if (!completed.ok) throw completed.error;
        const prepared = prepare.mock.results.at(-1)?.value;
        expect(prepared?.ok).toBe(true);
        const gpu = renderer.inspect().renderScene.gpuDriven;
        expect(gpu.gpuOwnedEntityCount).toBe(geometryLane === 'direct' ? 0 : 1);
        if (geometryLane === 'automatic') expect(prepared.value.shadowDirectRequired).toBe(false);
        if (geometryLane === 'direct') expect(directDraws).toHaveBeenCalled();
        expect(renderer.inspect().renderScene.projectionRecords).toBe(1);
        expect(errors).toEqual([]);
        publisher
          .recycle(
            publication.revision,
            renderPublicationTransfers(encodeRenderPublication(publication)),
          )
          .unwrap();
      }
    } finally {
      prepare.mockRestore();
      directDraws.mockRestore();
      requestDevice.mockRestore();
      publisher.dispose();
      renderer.dispose();
    }
  }, 30_000);

  it('records 744 published entities with shared materials and exact draw receipts', async () => {
    const identity = { source: 'frame-projection-reuse', epoch: 1 };
    const manifest = manifestDataUrl(`/* f_schlick( */ ${OUTPUT_TRANSFORM_WGSL}`, true);
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi, publicationSource: identity },
      {
        shaderManifestUrl: manifest,
      },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: manifest }),
    });
    const world = new World({ assets });
    const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const publisher = createRenderPublisher(world, assets, identity);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    const red = assets.create(Materials.standard({ baseColor: [0.8, 0.1, 0.05, 1] })).unwrap();
    const blue = assets.create(Materials.standard({ baseColor: [0.05, 0.1, 0.8, 1] })).unwrap();
    const entities = Array.from({ length: 744 }, () =>
      world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: cube } },
          { component: MeshRenderer, data: { materials: [red] } },
        )
        .unwrap(),
    );
    const inspect = vi.spyOn(GpuDrivenProduction.prototype, 'inspect');
    const emit = vi.spyOn(gpuDrawReceipts, 'emitGpuDrivenDrawReceipts');
    const summarize = vi.spyOn(gpuDrawReceipts, 'summarizeGpuDrivenDraws');
    const ssrInputs = vi.spyOn(mainPass, 'hasSsrSceneInputs');
    try {
      const changed = entities[371];
      if (changed === undefined) throw new Error('missing published entity');
      for (let frame = 0; frame < 4; frame++) {
        if (frame === 2) world.set(changed, Transform, { pos: [0.1, 0, 0] }).unwrap();
        if (frame === 3) world.set(changed, MeshRenderer, { materials: [blue] }).unwrap();
        world.update(1 / 60).unwrap();
        const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
        const packet = structuredClone(candidate.packet, {
          transfer: renderPublicationTransfers(candidate.message),
        });
        candidate.accept();
        inspect.mockClear();
        emit.mockClear();
        summarize.mockClear();
        ssrInputs.mockClear();
        const submitted = renderer.draw({ publication: encodeRenderPublication(packet) });
        if (!submitted.ok) throw submitted.error;
        const receipt = submitted.value;
        if (receipt === undefined) throw new Error('missing publication receipt');
        const completed = await receipt.completed;
        if (!completed.ok) throw completed.error;
        expect.soft(inspect, `frame ${frame} full inspection`).not.toHaveBeenCalled();
        expect(emit).toHaveBeenCalledOnce();
        // After the first GPU selection, per-row receipts visit residual rows only.
        expect([...(emit.mock.calls[0]?.[0] ?? [])]).toHaveLength(frame === 0 ? 744 : 0);
        expect(summarize).not.toHaveBeenCalled();
        expect(ssrInputs).not.toHaveBeenCalled();
        const state = renderer.inspect().renderScene;
        expect(summarize).toHaveBeenCalledOnce();
        expect(summarize.mock.calls[0]?.[0]).toHaveLength(744);
        expect(summarize.mock.results[0]?.value).toMatchObject({
          gpuDraws: 744,
          gpuEntities: 744,
          cpuDraws: 0,
        });
        expect(new Set(summarize.mock.calls[0]?.[0].map((row) => row.material)).size).toBe(
          frame < 3 ? 1 : 2,
        );
        expect(state.projectionRecords).toBe(744);
        expect(state.gpuDriven.cpuFallbackDrawItems).toBe(0);
        expect(state.gpuDriven.gpuOwnedEntityCount).toBe(744);
        expect(state.gpuDriven.gpuOwnedSnapshotsMaterialized).toBe(0);
        expect(state.gpuDriven.cpuValidationScans).toBe(0);
        publisher
          .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
          .unwrap();
      }
    } finally {
      inspect.mockRestore();
      emit.mockRestore();
      summarize.mockRestore();
      ssrInputs.mockRestore();
      publisher.dispose();
      renderer.dispose();
    }
  });

  it.each([
    0, 1, 2,
  ])('marks only physically resident LOD %i and the root ready', async (readyLevel) => {
    const queue = new RecordingQueue();
    const device = recordingDevice(queue);
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const source = preparedPbrFixture(snapshot(1, 3));
    const draw = source.gpuDrivenDraws?.[0];
    expect(draw).toBeDefined();
    if (draw === undefined) return;
    const middleGuid = '00000000-0000-7000-8000-000000000001' as never;
    const lowestGuid = '00000000-0000-7000-8000-000000000002' as never;
    const lodSnapshot: RenderableSnapshot = {
      ...source,
      lods: [
        { mesh: middleGuid, screenCoverage: 0.5 },
        { mesh: lowestGuid, screenCoverage: 0.2 },
      ],
      gpuDrivenDraws: [
        {
          ...draw,
          lodRanges: [
            { first: 3, count: 3, baseVertex: 3 },
            { first: 6, count: 3, baseVertex: 6 },
          ],
        },
      ],
    };
    const delta = projection.apply([updateSnapshot(lodSnapshot)]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const sourceBatch = topology.query(topology.sourcePlan(), undefined).batches.at(0);
    expect(sourceBatch?.lod?.ranges).toHaveLength(2);
    expect(sourceBatch?.lod).toBeDefined();
    if (sourceBatch?.lod === undefined) return;

    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const residentMesh = mesh(device);
    const lowerRanges = [1, 2].map((level) =>
      level === readyLevel ? [{ first: 3, count: 3, baseVertex: 3 }] : [],
    );
    const prepared = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([
            [
              0,
              {
                ...residentMesh,
                lodRanges: [[{ first: 0, count: 3, baseVertex: 0 }], ...lowerRanges],
              },
            ],
          ]),
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    expect(production.inspect()).toMatchObject({ batchCount: 1, indirectDrawCount: 3 });
    prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();

    const batchStride = GPU_DRIVEN_BATCH_STRIDE;
    const lodOffset = batchStride - 8 * GPU_SCENE_LAYOUTS.lod.stride;
    const batchWrite = queue.writes.find((write) => write.bytes.byteLength === batchStride);
    expect(batchWrite).toBeDefined();
    if (batchWrite === undefined) return;
    const bytes = new DataView(batchWrite.bytes.buffer, batchWrite.bytes.byteOffset);
    const readyOffset = gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.lod, 'ready');
    expect(
      [0, 1, 2].map((level) =>
        bytes.getUint32(lodOffset + level * GPU_SCENE_LAYOUTS.lod.stride + readyOffset, true),
      ),
    ).toEqual([1, Number(readyLevel === 1), Number(readyLevel === 2)]);

    production.dispose();
    availability.scene.dispose();
  });

  it('retains suppressed LOD candidates for selector accounting while admitting only active draws', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const lodMeshGuid = '00000000-0000-7000-8000-000000000001' as never;
    const sharedMaterial = preparedPbrFixture(snapshot(0, 3)).material;
    const makeLodSnapshot = (entityKey: number): RenderableSnapshot => {
      const base = preparedPbrFixture(snapshot(entityKey, 3));
      const draw = base.gpuDrivenDraws?.[0];
      if (draw === undefined) throw new Error('LOD test snapshot has no draw');
      return {
        ...base,
        material: sharedMaterial,
        materials: [sharedMaterial],
        lods: [{ mesh: lodMeshGuid, screenCoverage: 0.5 }],
        gpuDrivenDraws: [{ ...draw, lodRanges: [{ first: 3, count: 1, baseVertex: 0 }] }],
      };
    };
    const delta = projection.apply([
      updateSnapshot(makeLodSnapshot(1)),
      updateSnapshot(makeLodSnapshot(2)),
    ]);
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const lodGpuMesh = mesh(device, true, true);
    const prepared = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([
            [0, lodGpuMesh],
            [1, lodGpuMesh],
          ]),
          viewBindGroupLayout: viewLayout,

          activeEntityKeys: new Set([worldEntityKey(0, 1)]),
          activeEntityRevision: 1,
        }),
      )
      .unwrap();
    for (const slot of projection.slotsSnapshot())
      expect(prepared?.selection.ownsAll(slot.snapshot)).toBe(true);
    // Both candidates are uploaded to the selector (two compact candidate records), while
    // only the active entity is admitted into the compacted draw stream.
    // One shared-chain batch owns one indirect command per LOD level.
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 2,
    });
    expect(production.inspect().sharedInputUploadBytes).toBeGreaterThan(0);
    if (prepared === undefined) return;
    const projected = prepared
      .project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1)
      .unwrap();
    expect(projected.accesses.length).toBeGreaterThan(0);
    expect(production.inspect()).toMatchObject({
      batchBindGroupCreates: 0,
      indirectDrawCount: 2,
    });

    // The scene/view buffers and visible range are unchanged on a warm
    // projection. The raster owner must reuse the physical batch bind group;
    // a new group is only valid after one of those handles or the range
    // changes (resize/recovery/LOD admission).
    prepared._commitResourceReplacement();
    const warm = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([
            [0, lodGpuMesh],
            [1, lodGpuMesh],
          ]),
          viewBindGroupLayout: viewLayout,

          activeEntityKeys: new Set([worldEntityKey(0, 1)]),
          activeEntityRevision: 1,
        }),
      )
      .unwrap();
    expect(warm?.topologySignature).toBe(prepared.topologySignature);
    warm?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
    expect(production.inspect()).toMatchObject({ batchBindGroupCreates: 0 });

    warm?._commitResourceReplacement();
    const suppressed = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([
            [0, lodGpuMesh],
            [1, lodGpuMesh],
          ]),
          viewBindGroupLayout: viewLayout,

          activeEntityKeys: new Set(),
          activeEntityRevision: 2,
        }),
      )
      .unwrap();
    // Admission is a per-view GPU bitmap indexed by primitive slot: hiding an
    // entity uploads dirty words but must not rebuild the plan or the graph.
    expect(suppressed?.topologySignature).toBe(prepared.topologySignature);
    expect(production.inspect()).toMatchObject({ batchCount: 1 });

    suppressed?._commitResourceReplacement();
    const restored = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([
            [0, lodGpuMesh],
            [1, lodGpuMesh],
          ]),
          viewBindGroupLayout: viewLayout,

          activeEntityKeys: new Set([worldEntityKey(0, 1)]),
          activeEntityRevision: 3,
        }),
      )
      .unwrap();
    expect(restored?.topologySignature).toBe(prepared.topologySignature);
    expect(production.inspect()).toMatchObject({ batchCount: 1 });
    // Selector accounting precedes suppression; suppression precedes the
    // compacted append in the early admission shared by both cull entry points.
    const cullView = GPU_DRIVEN_VIEW_WGSL.slice(
      GPU_DRIVEN_VIEW_WGSL.indexOf('fn admitEarly('),
      GPU_DRIVEN_VIEW_WGSL.indexOf('fn cullView('),
    );
    expect(cullView.indexOf('atomicAdd(&counters[lodCounterIndex')).toBeGreaterThan(0);
    expect(cullView.indexOf('atomicAdd(&counters[lodCounterIndex')).toBeLessThan(
      cullView.indexOf('if (isSuppressed(candidate.sourceSlot))'),
    );
    expect(cullView.indexOf('if (isSuppressed(candidate.sourceSlot))')).toBeLessThan(
      cullView.indexOf('appendCandidate('),
    );
    production.dispose();
    availability.scene.dispose();
  });

  it('suppresses an inactive resident candidate through the per-view bitmap', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const candidate = preparedPbrFixture(snapshot(1, 3));
    const delta = projection.apply([updateSnapshot(candidate)]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const input = {
      ...pbrInputs,
      scene: {
        scene: availability.scene,
        plan: topology.query(topology.sourcePlan(), undefined),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map([[0, mesh(device)]]),
      viewBindGroupLayout: viewLayout,
    };
    const prepared = production
      .prepare(admitGpuFixture({ ...input, activeEntityKeys: new Set(), activeEntityRevision: 1 }))
      .unwrap();
    // The resident candidate stays in the stable plan; the per-view bitmap
    // suppresses its primitive slot on the GPU before any compaction.
    expect(prepared).toBeDefined();
    expect(prepared?.selection.ownsAll(candidate)).toBe(true);
    expect(production.inspect()).toMatchObject({ batchCount: 1, suppressionUploadBytes: 4 });
    prepared?._commitResourceReplacement();
    // Falsifier: an unchanged admission set uploads nothing, and a flipped
    // entity uploads exactly its dirty word without a plan or graph rebuild.
    const steady = production
      .prepare(admitGpuFixture({ ...input, activeEntityKeys: new Set(), activeEntityRevision: 1 }))
      .unwrap();
    expect(production.inspect()).toMatchObject({ suppressionUploadBytes: 0 });
    steady?._commitResourceReplacement();
    const admitted = production
      .prepare(
        admitGpuFixture({
          ...input,
          activeEntityKeys: new Set([worldEntityKey(0, 1)]),
          activeEntityRevision: 2,
        }),
      )
      .unwrap();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      suppressionUploadBytes: 4,
    });
    expect(admitted?.topologySignature).toBe(prepared?.topologySignature);
    production.dispose();
    availability.scene.dispose();
  });

  it('keeps bounded graph identities across membership changes and separates resource owners', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 8).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    const topology = new BatchTopology();
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const replacementOwner = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const pipelineInvalidations = vi.spyOn(
      MaterialAbiRasterAdapter.prototype,
      'invalidatePipelineCache',
    );
    const sharedMesh = mesh(device);
    const spawn = (entityKeys: readonly number[], owner = production) => {
      availability.scene
        .sync(
          projection.apply(
            entityKeys.map((key) => updateSnapshot(preparedPbrFixture(snapshot(key, 3)))),
          ),
        )
        .unwrap();
      topology.rebuild(projection.slotsSnapshot());
      const prepared = owner
        .prepare(
          admitGpuFixture({
            ...pbrInputs,
            scene: {
              scene: availability.scene,
              plan: topology.query(topology.sourcePlan(), undefined),
              slots: projection.slotsSnapshot(),
              slotAt: projection.slotAt,
            },
            camera: makeZeroCameraFallbackSnapshot(),
            meshBySlot: new Map(
              projection.slotsSnapshot().map((entry) => [entry.slot, sharedMesh] as const),
            ),
            viewBindGroupLayout: viewLayout,
          }),
        )
        .unwrap();
      prepared?._commitResourceReplacement();
      return prepared?.topologySignature;
    };
    try {
      const first = spawn([1, 2, 3]);
      expect(first).toBeDefined();
      expect(first?.length).toBeLessThan(128);
      expect(spawn([], replacementOwner)).not.toBe(first);
      // A spawned member of an existing raster class revises the plan inside
      // the retained capacity: the compiled graph must survive it.
      const grown = spawn([4]);
      expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(4);
      expect(grown).toBe(first);
      expect(pipelineInvalidations).not.toHaveBeenCalled();
      // Crossing the power-of-two candidate capacity replaces the view
      // buffers; the graph resolves them when it executes and survives too.
      const replaced = spawn([5]);
      expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(5);
      expect(replaced).toBe(first);
    } finally {
      pipelineInvalidations.mockRestore();
      production.dispose();
      replacementOwner.dispose();
      availability.scene.dispose();
    }
  });

  it('retains the compiled graph through unrelated residency and in-place mesh writes', async () => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    let viewBindGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(preparedPbrFixture(snapshot(1, 3)))]);
    const availability = GpuScene.create(device, 1).unwrap();
    if (availability.status !== 'available') throw new Error('expected GPU Scene');
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    let resident = mesh(device);
    let epoch = 1;
    const prepare = (scene = availability.scene) =>
      production
        .prepare(
          admitGpuFixture({
            ...pbrInputs,
            scene: {
              scene,
              plan: topology.query(topology.sourcePlan(), undefined),
              slots: projection.slotsSnapshot(),
              slotAt: projection.slotAt,
            },
            camera: makeZeroCameraFallbackSnapshot(),
            meshBySlot: new Map([[0, resident]]),
            viewBindGroupLayout: viewLayout,
          }),
        )
        .unwrap();
    let current = prepare();
    if (current === undefined) throw new Error('expected prepared frame');
    const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    let materialGroup = device.createBindGroup({ layout: materialLayout, entries: [] }).unwrap();
    let forceFailure = false;
    const activePipeline: RenderPipeline = {
      build: ({ graph, projectGpuDriven }) => {
        const projected = projectGpuDriven({ format: 'rgba8unorm', sampleCount: 1 }).unwrap();
        if (projected === undefined) throw new Error('expected GPU projection');
        const color = graph
          .createTexture('retained-mesh-color', {
            format: 'rgba8unorm',
            size: { width: 1, height: 1 },
          })
          .unwrap();
        const colorView = graph.view(color).unwrap();
        graph
          .addRasterPass('retained-mesh', {
            accesses: [...projected.accesses, { resource: colorView, usage: 'color-attachment' }],
            colorAttachments: [
              {
                view: colorView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
              },
            ],
            encode: ({ pass, resources }) => {
              if (current === undefined) throw new Error('expected current frame');
              projected.encode(viewBindGroup, pass, resources, {
                ...current.standardPbrFrameResources,
                prepareMaterialBinding: (
                  (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
                  (slot: number) => {
                    const group = groups[slot];
                    return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
                  }
                )([materialGroup]),
              });
            },
          })
          .unwrap();
        if (forceFailure) {
          const missing = graph.createBuffer('unwritten-replacement', { size: 4 }).unwrap();
          graph
            .addComputePass('unwritten-replacement', {
              accesses: [{ resource: missing, usage: 'storage-read' }],
              encode: () => undefined,
            })
            .unwrap();
        }
        return ok(undefined);
      },
    };
    const state = {
      temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
      temporalView: new TemporalViewHistory(),
      compiledFrameGraph: null,
      compiledFrameGraphGeneration: 0,
      retiredCompiledFrameGraphs: new Set(),
      activePipeline,
      installedPipelineConfig: undefined,
    } as unknown as RenderFrameState;
    const errors: unknown[] = [];
    const errorRegistry = new RhiErrorListenerRegistry();
    errorRegistry.add((error) => errors.push(error));
    const dependencies = { device, errorRegistry };
    const internals = dependencies as unknown as RenderSystemInternals;
    const pipelineState = {
      format: 'rgba8unorm',
      colorAttachmentFormat: 'rgba8unorm',
    } as unknown as PipelineState;
    const lights = {
      cascades: undefined,
      pointShadow: [],
      spot: [],
      shadowViews: [],
    } as unknown as ViewLights;
    const compile = () =>
      ensureCompiledFrameGraph(
        internals,
        state,
        pipelineState,
        makeZeroCameraFallbackSnapshot(),
        lights,
        1,
        1,
        undefined,
        current,
      );
    const boundVertices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setVertexBuffer');
    const boundIndices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setIndexBuffer');
    const encode = (compiled: NonNullable<ReturnType<typeof compile>>) => {
      boundVertices.mockClear();
      boundIndices.mockClear();
      expect(state.compiledFrameGraph?.graph).toBe(compiled);
      const encoder = internals.device.createCommandEncoder().unwrap();
      expect(
        executeCompiledFrameGraph(
          internals,
          state,
          { encoder, pipelineState } as unknown as RenderPipelineFrame,
          encoder,
        ),
      ).toBe(true);
      expect(
        boundVertices.mock.calls.some(([, buffer]) => buffer === resident.vertexBuffer.handle),
      ).toBe(true);
      expect(
        boundIndices.mock.calls.some(([buffer]) => buffer === resident.indexBuffer?.handle),
      ).toBe(true);
      current?._commitResourceReplacement();
    };
    try {
      const first = compile();
      if (first === null) throw new Error('expected compiled graph');
      encode(first);
      for (let frame = 0; frame < 60; frame += 1) {
        epoch += 1;
        current = prepare();
        expect(compile()).toBe(first);
        encode(first);
      }
      expect(state.compiledFrameGraphGeneration).toBe(1);
      Object.assign(resident, { contentEpoch: ++epoch });
      device.queue.writeBuffer(resident.vertexBuffer.handle, 0, new Float32Array([0.25])).unwrap();
      current = prepare();
      expect(compile()).toBe(first);
      encode(first);
      // Same size and layout, different physical buffers: the old graph must retire.
      resident = mesh(device);
      epoch += 1;
      current = prepare();
      forceFailure = true;
      expect(compile()).toBe(first);
      expect(errors).toHaveLength(1);
      forceFailure = false;
      const replacement = compile();
      expect(replacement).not.toBe(first);
      if (replacement === null) throw new Error('expected replacement graph');
      encode(replacement);
      expect(compile()).toBe(replacement);
      const recovered = GpuScene.create(device, 1).unwrap();
      if (recovered.status !== 'available') throw new Error('expected replacement scene');
      recovered.scene.sync(delta).unwrap();
      current = prepare(recovered.scene);
      const recoveredGraph = compile();
      expect(recoveredGraph).not.toBe(replacement);
      if (recoveredGraph === null) throw new Error('expected recovered graph');
      encode(recoveredGraph);
      recovered.scene.dispose();
      expect(state.compiledFrameGraphGeneration).toBe(3);
      // A fresh device starts its own local counters; actual buffer identities
      // must still prevent reuse of the previous device's compiled resources.
      const nextDevice = (
        await (await rhi.requestAdapter()).unwrap().requestDevice()
      ).unwrap() as RhiNullDevice;
      const nextShader = (await rhi.createShaderModule(nextDevice, { code: 'synthetic' })).unwrap();
      const nextLayout = nextDevice.createBindGroupLayout({ entries: [] }).unwrap();
      const nextScene = GpuScene.create(nextDevice, 1).unwrap();
      if (nextScene.status !== 'available') throw new Error('expected recovered device scene');
      const nextProduction = new GpuDrivenProduction(nextDevice, {
        createShaderModule: () => ok(nextShader),
      });
      try {
        nextScene.scene.sync(delta).unwrap();
        resident = mesh(nextDevice);
        current = nextProduction
          .prepare(
            admitGpuFixture({
              ...standardPbrInputs(nextDevice, nextShader, nextLayout),
              scene: {
                scene: nextScene.scene,
                plan: topology.query(topology.sourcePlan(), undefined),
                slots: projection.slotsSnapshot(),
                slotAt: projection.slotAt,
              },
              camera: makeZeroCameraFallbackSnapshot(),
              meshBySlot: new Map([[0, resident]]),
              viewBindGroupLayout: nextLayout,
            }),
          )
          .unwrap();
        dependencies.device = nextDevice;
        viewBindGroup = nextDevice.createBindGroup({ layout: nextLayout, entries: [] }).unwrap();
        materialGroup = nextDevice.createBindGroup({ layout: nextLayout, entries: [] }).unwrap();
        const freshGraph = compile();
        expect(freshGraph).not.toBe(recoveredGraph);
        if (freshGraph === null) throw new Error('expected fresh-device graph');
        encode(freshGraph);
        expect(state.compiledFrameGraphGeneration).toBe(4);
      } finally {
        nextProduction.dispose();
        nextScene.scene.dispose();
      }
    } finally {
      boundVertices.mockRestore();
      boundIndices.mockRestore();
      state.compiledFrameGraph?.graph.retire();
      for (const graph of state.retiredCompiledFrameGraphs) graph.retire();
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('validates and consumes a published Surface dynamic page through production prepare', async () => {
    const queue = new RecordingQueue();
    const device = recordingDevice(queue);
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const baseArtifact = pbrInputs.materialArtifact;
    expect(baseArtifact).toBeDefined();
    if (baseArtifact === undefined) return;
    const dynamicSchema = {
      name: 'surfaceEvents',
      fields: [
        { name: 'position', type: 'vec3<f32>' as const },
        { name: 'strength', type: 'f32' as const },
      ],
      maxRecords: 4,
      maxDomains: 2,
      maxPageBytes: 64,
      maxBindings: 1,
      maxEventsPerSample: 2,
    };
    const layout = deriveMaterialDynamicInputLayout(dynamicSchema).unwrap();
    const surfaceReceipt = {
      ...STANDARD_PBR_RECEIPT,
      surface: {
        model: 'single-layer-medium' as const,
        module: 'forgeax::single-layer-medium',
        inputAbi: 'SingleLayerMediumSurfaceInput',
        outputAbi: 'SingleLayerMediumSurfaceData',
        passes: ['nearest-layer', 'color'] as const,
        dynamicInput: {
          layout,
          group: 3,
          binding: 3,
          readOnly: true as const,
          accessor: `read_${layout.name}`,
        },
      },
    };
    // One resident mesh: a replaced handle is a real preparation edit.
    const surfaceMesh = mesh(device);
    const artifact = {
      ...baseArtifact,
      receipt: surfaceReceipt,
    };
    const projection = new RenderScene();
    const source = preparedPbrFixture(snapshot(1, 3));
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const twoInstanceSurface = {
      ...source,
      instances: {
        transforms: new Float32Array([...identity, ...identity]),
        instanceCount: 2,
        cacheKey: 1,
        archVersion: 1,
        revision: 1,
      },
    } satisfies RenderableSnapshot;
    const delta = projection.apply([updateSnapshot(twoInstanceSurface)]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const page = ReadonlyDynamicInputPage.create({
      sourceId: 'surface-producer',
      pageId: 1,
      schema: dynamicSchema,
    }).unwrap();
    page.writeRecord(0, { position: [1, 2, 3], strength: 0.75 }).unwrap();
    page.writeRecord(1, { position: [4, 5, 6], strength: 0.25 }).unwrap();
    const firstRange = page
      .reserveRange({
        domain: 'surface-a',
        recordStart: 0,
        recordCount: 1,
        instanceIndex: 3,
        member: {
          worldIdentity: 'world-a',
          entityKey: 1,
          drawItemIndex: 0,
          instanceOrdinal: 0,
        },
      })
      .unwrap();
    const secondRange = page
      .reserveRange({
        domain: 'surface-b',
        recordStart: 1,
        recordCount: 1,
        instanceIndex: 7,
        member: {
          worldIdentity: 'world-a',
          entityKey: 1,
          drawItemIndex: 0,
          instanceOrdinal: 1,
        },
      })
      .unwrap();
    const stableRanges = Object.freeze([firstRange, secondRange]);
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const probeBlendRecordBuffer = device
      .createBuffer({ size: 4096, usage: GPU_BUFFER_USAGE_STORAGE })
      .unwrap();
    const prepared = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          materialArtifact: artifact,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
            worldIdentities: ['world-a'],
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([[0, surfaceMesh]]),
          viewBindGroupLayout: viewLayout,

          probeBlendRecordBuffer,
          hdrp: false,
          surfaceDynamicInput: {
            page,
            ranges: [secondRange, firstRange],
            projectionRevision: 1,
            frameTime: 1,
          },
          deviceGeneration: 1,
        }),
      )
      .unwrap();
    expect(prepared?.surfaceSubmission).toMatchObject({
      model: 'single-layer-medium',
      lane: 'gpu-driven',
      passes: [{ pass: 'nearest-layer' }, { pass: 'color' }],
    });
    expect(page.uploadedRevision).toBe(page.contentRevision);
    const consumeSpy = vi.spyOn(page, 'consume');
    expect(prepared?._consumeSurfaceDynamicInput?.(31)).toMatchObject({
      ok: true,
    });
    expect(consumeSpy).toHaveBeenCalledTimes(2);
    const frameBuffer = prepared?.standardPbrFrameResources.surfaceDynamicInput?.frame;
    expect(frameBuffer).toBeDefined();
    if (frameBuffer === undefined) return;
    const frameWrites = queue.writes.filter(
      (write) => write.buffer === frameBuffer && write.bytes.byteLength === 48,
    );
    const mappedFrameWrite = frameWrites.find((write) => {
      if (write.buffer !== frameBuffer || write.bytes.byteLength !== 48) return false;
      return (
        new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength).getUint32(
          12,
          true,
        ) === 3
      );
    });
    expect(mappedFrameWrite?.offset).toBe(0);
    expect(
      mappedFrameWrite === undefined
        ? undefined
        : new DataView(
            mappedFrameWrite.bytes.buffer,
            mappedFrameWrite.bytes.byteOffset,
            mappedFrameWrite.bytes.byteLength,
          ).getUint32(44, true),
    ).toBe(1);
    const secondMappedFrameWrite = frameWrites.find((write) => {
      if (write.buffer !== frameBuffer || write.bytes.byteLength !== 48) return false;
      return (
        new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength).getUint32(
          12,
          true,
        ) === 7
      );
    });
    expect(secondMappedFrameWrite?.offset).toBe(48);
    const frameWriteCount = frameWrites.length;
    expect(production.inspect()).toMatchObject({
      surfaceFrameRangeBuilds: 1,
      surfaceFrameMemberScans: 4,
      surfaceFrameRowAllocations: 2,
      surfaceFrameTimeWrites: 1,
    });
    prepared?._commitResourceReplacement();
    const repeated = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          materialArtifact: artifact,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
            worldIdentities: ['world-a'],
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([[0, surfaceMesh]]),
          viewBindGroupLayout: viewLayout,

          probeBlendRecordBuffer,
          hdrp: false,
          surfaceDynamicInput: { page, ranges: stableRanges, projectionRevision: 1, frameTime: 1 },
          deviceGeneration: 1,
        }),
      )
      .unwrap();
    expect(repeated).toBeDefined();
    expect(repeated?._consumeSurfaceDynamicInput?.(32)).toMatchObject({ ok: true });
    expect(consumeSpy).toHaveBeenCalledTimes(2);
    expect(
      queue.writes.filter((write) => write.buffer === frameBuffer && write.bytes.byteLength === 48),
    ).toHaveLength(frameWriteCount);
    const stableInspection = production.inspect();
    expect(stableInspection).toMatchObject({
      surfaceFrameRangeBuilds: 1,
      surfaceFrameMemberScans: 4,
      surfaceFrameRowAllocations: 2,
      surfaceFrameTimeWrites: 1,
    });

    repeated?._commitResourceReplacement();
    const writesBeforeTimeAdvance = queue.writes.length;
    const timeAdvanced = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          materialArtifact: artifact,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
            worldIdentities: ['world-a'],
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([[0, surfaceMesh]]),
          viewBindGroupLayout: viewLayout,

          probeBlendRecordBuffer,
          hdrp: false,
          surfaceDynamicInput: { page, ranges: stableRanges, projectionRevision: 1, frameTime: 2 },
          deviceGeneration: 1,
        }),
      )
      .unwrap();
    const timeAdvanceWrites = queue.writes.slice(writesBeforeTimeAdvance);
    const sharedFrameBuffer = prepared?.standardPbrFrameResources.surfaceDynamicInput?.sharedFrame;
    expect(sharedFrameBuffer).toBeDefined();
    expect(timeAdvanceWrites.filter((write) => write.buffer === sharedFrameBuffer)).toMatchObject([
      { offset: 0, bytes: { byteLength: 16 } },
    ]);
    expect(timeAdvanceWrites.some((write) => write.buffer === frameBuffer)).toBe(false);
    expect(production.inspect()).toMatchObject({
      surfaceFrameRangeBuilds: stableInspection.surfaceFrameRangeBuilds,
      surfaceFrameMemberScans: stableInspection.surfaceFrameMemberScans,
      surfaceFrameRowAllocations: stableInspection.surfaceFrameRowAllocations,
      surfaceFrameTimeWrites: stableInspection.surfaceFrameTimeWrites + 1,
    });

    timeAdvanced?._commitResourceReplacement();
    const invalid = production.prepare(
      admitGpuFixture({
        ...pbrInputs,
        materialArtifact: artifact,
        scene: {
          scene: availability.scene,
          plan: topology.query(topology.sourcePlan(), undefined),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
          worldIdentities: ['world-a'],
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([[0, surfaceMesh]]),
        viewBindGroupLayout: viewLayout,

        probeBlendRecordBuffer,
        hdrp: false,
        surfaceDynamicInput: {
          page,
          ranges: [{ ...firstRange, byteOffset: firstRange.byteOffset + 4 }, secondRange],
          projectionRevision: 2,
          frameTime: 1,
        },
        deviceGeneration: 1,
      }),
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: 'rhi-descriptor-invalid' } });
    const retried = production.prepare(
      admitGpuFixture({
        ...pbrInputs,
        materialArtifact: artifact,
        scene: {
          scene: availability.scene,
          plan: topology.query(topology.sourcePlan(), undefined),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
          worldIdentities: ['world-a'],
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([[0, surfaceMesh]]),
        viewBindGroupLayout: viewLayout,

        probeBlendRecordBuffer,
        hdrp: false,
        surfaceDynamicInput: {
          page,
          ranges: stableRanges,
          projectionRevision: 2,
          frameTime: 2,
        },
        deviceGeneration: 1,
      }),
    );
    expect(retried.ok).toBe(true);
    production.dispose();
    availability.scene.dispose();
  });

  it('keeps GPU batches World-homogeneous for same-submit counter attribution', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const first = preparedPbrFixture(snapshot(1, 3));
    const second = { ...preparedPbrFixture(snapshot(2, 3)), worldId: 1 };
    const delta = projection.apply([updateSnapshot(first), updateSnapshot(second)]);
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const prepared = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([
            [0, mesh(device)],
            [1, mesh(device)],
          ]),
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    expect(prepared).toBeDefined();
    expect(production.inspect()).toMatchObject({ batchCount: 2, indirectDrawCount: 2 });
    production.dispose();
    availability.scene.dispose();
  });

  it('batches materials whose texture masks converge and reuses their PSO', async () => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 2).unwrap();
    if (availability.status !== 'available') throw new Error('GPU scene unavailable');
    const topology = new BatchTopology();
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const sharedMesh = mesh(device);
    const meshes = new Map([
      [0, sharedMesh],
      [1, sharedMesh],
    ]);
    const pipelines = vi.spyOn(device, 'createRenderPipeline');
    const row = (id: number, mask: number) => {
      const source = preparedPbrFixture(snapshot(id, 3));
      const material = new MaterialResource({
        ...source.material.snapshot,
        standardTextureMask: mask,
      });
      return { ...source, material, materials: [material] };
    };
    const prepare = () =>
      production
        .prepare(
          admitGpuFixture({
            ...pbrInputs,
            scene: {
              scene: availability.scene,
              plan: topology.query(topology.sourcePlan(), undefined),
              slots: projection.slotsSnapshot(),
              slotAt: projection.slotAt,
            },
            camera: makeZeroCameraFallbackSnapshot(),
            meshBySlot: meshes,
            viewBindGroupLayout: viewLayout,
          }),
        )
        .unwrap();
    try {
      availability.scene
        .sync(projection.apply([updateSnapshot(row(1, 0)), updateSnapshot(row(2, 4))]))
        .unwrap();
      topology.rebuild(projection.slotsSnapshot());
      const first = prepare();
      expect(first).toBeDefined();
      expect(production.inspect().batchCount).toBe(2);
      first?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
      expect(
        pipelines.mock.calls.map(([descriptor]) => descriptor.fragment?.constants?.['64000']),
      ).toEqual(expect.arrayContaining([0, 4]));
      const zeroIndex = pipelines.mock.calls.findIndex(
        ([descriptor]) => descriptor.fragment?.constants?.['64000'] === 0,
      );
      const zeroPipeline = pipelines.mock.results[zeroIndex]?.value.unwrap();
      expect(zeroPipeline).toBeDefined();
      first?._commitResourceReplacement();
      const stable = prepare();
      expect(stable?.topologySignature).toBe(first?.topologySignature);
      stable?.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
      stable?._commitResourceReplacement();
      pipelines.mockClear();
      availability.scene.sync(projection.apply([updateSnapshot(row(2, 0))])).unwrap();
      topology.rebuild(projection.slotsSnapshot());
      const changed = prepare();
      expect(changed?.topologySignature).not.toBe(first?.topologySignature);
      // Converged materials share one batch; each row keeps its own material row.
      expect(production.inspect().batchCount).toBe(1);
      if (changed === undefined) throw new Error('expected changed GPU frame');
      const graph = new RenderGraphBuilder<RenderPipelineFrame>();
      const gpu = changed.project(graph, 'rgba8unorm', 1).unwrap();
      // The mask-0 program was already prepared. Reusing it must still encode
      // that exact PSO after the mask-4 class leaves the live roster.
      expect(pipelines).not.toHaveBeenCalled();
      const color = graph
        .createTexture('mask-output', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
        .unwrap();
      const colorView = graph.view(color).unwrap();
      const emptyGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
      let encoded = false;
      graph
        .addRasterPass('mask-output', {
          accesses: [...gpu.accesses, { resource: colorView, usage: 'color-attachment' }],
          colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store' }],
          encode: ({ pass, resources }) => {
            const bound = vi.spyOn(pass, 'setPipeline');
            gpu.encode(
              emptyGroup,
              pass,
              resources,
              {
                ...changed.standardPbrFrameResources,

                prepareMaterialBinding: (
                  (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
                  (slot: number) => {
                    const group = groups[slot];
                    return group === undefined ? undefined : { group, byteOffset: slot * 256 };
                  }
                )([emptyGroup, emptyGroup]),
              },
              'opaque',
              STANDARD_OPAQUE_FRAGMENT_ENTRY,
            );
            expect(bound).toHaveBeenCalledExactlyOnceWith(zeroPipeline);
            encoded = true;
          },
        })
        .unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      try {
        const encoder = device.createCommandEncoder().unwrap();
        compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
        encoder.finish().unwrap();
        expect(encoded).toBe(true);
      } finally {
        (await compiled.retire()).unwrap();
      }
    } finally {
      pipelines.mockRestore();
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('reuses published program facts across graph projections and observes replacement source', async () => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 2).unwrap();
    if (availability.status !== 'available') throw new Error('GPU scene unavailable');
    const topology = new BatchTopology();
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const sharedMesh = mesh(device);
    const layout = vi.spyOn(String.prototype, 'replace');
    try {
      if (pbrInputs.materialArtifact === undefined) throw new Error('Missing fixture artifact');
      const rows = [0, 4].map((mask, index) => {
        const source = preparedPbrFixture(snapshot(index + 1, 3));
        const material = new MaterialResource({
          ...source.material.snapshot,
          standardTextureMask: mask,
        });
        return updateSnapshot({ ...source, material, materials: [material] });
      });
      availability.scene.sync(projection.apply(rows)).unwrap();
      topology.rebuild(projection.slotsSnapshot());
      for (const source of ['synthetic', '@group(2) @binding(3) var<uniform> cluster: vec4f;']) {
        const program = createMaterialShaderProgram(source);
        layout.mockClear();
        const prepared = production
          .prepare(
            admitGpuFixture({
              ...pbrInputs,
              materialArtifact: { ...pbrInputs.materialArtifact, program },
              scene: {
                scene: availability.scene,
                plan: topology.query(topology.sourcePlan(), undefined),
                slots: projection.slotsSnapshot(),
                slotAt: projection.slotAt,
              },
              camera: makeZeroCameraFallbackSnapshot(),
              meshBySlot: new Map([
                [0, sharedMesh],
                [1, sharedMesh],
              ]),
              viewBindGroupLayout: viewLayout,
            }),
          )
          .unwrap();
        expect(production.inspect().batchCount).toBe(2);
        if (prepared === undefined) throw new Error('Missing GPU projection');
        prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
        prepared._commitResourceReplacement();
        expect(layout.mock.contexts.filter((value) => String(value) === source)).toHaveLength(0);
        prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
        prepared._commitResourceReplacement();
        expect(layout.mock.contexts.filter((value) => String(value) === source)).toHaveLength(0);
      }
    } finally {
      layout.mockRestore();
      production.dispose();
      availability.scene.dispose();
    }
  });

  it.each([
    1, 64,
  ])('validates and serializes batches independently of %i instances', async (instanceCount) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const projection = new RenderScene();
    const source = preparedPbrFixture(snapshot(1, 3));
    const transforms = new Float32Array(instanceCount * 16);
    for (let index = 0; index < instanceCount; index += 1) {
      transforms.set(source.transform.world, index * 16);
    }
    const delta = projection.apply([
      updateSnapshot({
        ...source,
        instances: { transforms, instanceCount, cacheKey: 1, archVersion: 1 },
      }),
    ]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const sourcePlan = topology.query(topology.sourcePlan(), undefined);
    expect(sourcePlan.batches).toHaveLength(1);
    const serialize = vi.fn((key: object) => key);
    const compatibilityScan = vi.fn();
    const plan = {
      ...sourcePlan,
      batches: sourcePlan.batches.map((batch) => ({
        ...batch,
        key: { ...batch.key, toJSON: () => serialize(batch.key) },
        candidates: Object.assign([...batch.candidates], {
          some: (...args: Parameters<typeof batch.candidates.some>) => {
            compatibilityScan();
            return batch.candidates.some(...args);
          },
        }),
      })),
    };
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    production
      .prepare(
        admitGpuFixture({
          ...standardPbrInputs(device, shader, viewLayout),
          scene: {
            scene: availability.scene,
            plan,
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([[0, mesh(device)]]),
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 1,
    });
    expect(production.inspect().sharedInputUploadBytes).toBeGreaterThan(0);
    // One scene preparation shared by main and shadow views, independent of instances.
    expect(serialize).toHaveBeenCalledTimes(1);
    // Mesh compatibility of a non-LOD batch is a batch fact: no member scan.
    expect(compatibilityScan).not.toHaveBeenCalled();
    production.dispose();
    availability.scene.dispose();
  });

  it('shares scene admission across LOD, visibility and shadow projections', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const lodMeshGuid = '00000000-0000-7000-8000-000000000001' as never;
    const sharedMaterial = preparedPbrFixture(snapshot(0, 3)).material;
    const makeLodSnapshot = (entityKey: number): RenderableSnapshot => {
      const base = preparedPbrFixture(snapshot(entityKey, 3));
      const draw = base.gpuDrivenDraws?.[0];
      if (draw === undefined) throw new Error('LOD test snapshot has no draw');
      return {
        ...base,
        material: sharedMaterial,
        materials: [sharedMaterial],
        lods: [{ mesh: lodMeshGuid, screenCoverage: 0.5 }],
        gpuDrivenDraws: [{ ...draw, lodRanges: [{ first: 3, count: 1, baseVertex: 0 }] }],
      };
    };
    const delta = projection.apply([
      updateSnapshot(makeLodSnapshot(1)),
      updateSnapshot(makeLodSnapshot(2)),
    ]);
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const lodGpuMesh = mesh(device, true, true);
    const input = {
      ...pbrInputs,
      scene: {
        scene: availability.scene,
        plan: topology.query(topology.sourcePlan(), undefined),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 5) },
      meshBySlot: new Map([
        [0, lodGpuMesh],
        [1, lodGpuMesh],
      ]),
      viewBindGroupLayout: viewLayout,
    };
    const prepared = production.prepare(admitGpuFixture(input)).unwrap();
    expect(prepared).toBeDefined();
    // One shared-chain batch owns one indirect command per LOD level.
    expect(production.inspect()).toMatchObject({
      batchCount: 1,
      indirectDrawCount: 2,
    });
    expect(production.inspect().sharedInputUploadBytes).toBeGreaterThan(0);
    if (prepared === undefined) throw new Error('expected initial GPU projection');
    expect(production.inspect().gpuOwnedSnapshotsMaterialized).toBe(0);
    prepared._commitResourceReplacement();
    const nearInput = { ...input, camera: { ...input.camera, position: vec3.create(0, 0, 0.5) } };
    const near = production.prepare(admitGpuFixture(nearInput)).unwrap();
    expect(near).toBeDefined();
    // Crossing a LOD threshold is a GPU cull decision: the plan is retained.
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      sharedInputUploadBytes: 0,
      gpuOwnedSnapshotsMaterialized: 0,
    });
    near?._commitResourceReplacement();
    const visible = production
      .prepare(admitGpuFixture({ ...nearInput, activeEntityKeys: new Set([1]) }))
      .unwrap();
    expect(visible).toBeDefined();
    // Visibility admission is the per-view suppression bitmap, not plan data.
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      gpuOwnedSnapshotsMaterialized: 0,
    });
    expect(production.inspect().suppressionUploadBytes).toBeGreaterThan(0);
    visible?._commitResourceReplacement();
    const shadow = production
      .prepare(admitGpuFixture({ ...nearInput, shadowViews: true }))
      .unwrap();
    shadow
      ?.updateShadowViews?.([
        {
          identity: { kind: 'directional', index: 0, layer: 'static' },
          planes: new Float32Array(24),
          candidatePrimitiveIndices: [0],
        },
      ])
      .unwrap();
    expect(shadow?.shadowViewPool).toBeDefined();
    const shadowSource = projection.slotsSnapshot().at(0)?.snapshot;
    if (shadowSource === undefined) throw new Error('expected retained shadow source');
    expect(shadow?.selection.ownsAll(shadowSource)).toBe(true);
    expect(production.inspect().gpuOwnedSnapshotsMaterialized).toBe(0);
    shadow?._commitResourceReplacement();
    const rebound = production.prepare(admitGpuFixture({ ...nearInput })).unwrap();
    expect(rebound).toBeDefined();
    expect(production.inspect().gpuOwnedSnapshotsMaterialized).toBe(0);
    rebound?._commitResourceReplacement();
    if (input.materialArtifact === undefined) throw new Error('expected fixture artifact');
    const republished = production
      .prepare(
        admitGpuFixture({
          ...nearInput,

          materialArtifact: {
            ...input.materialArtifact,
            program: createMaterialShaderProgram('republished'),
          },
        }),
      )
      .unwrap();
    expect(republished).toBeDefined();
    expect(production.inspect().gpuOwnedSnapshotsMaterialized).toBe(0);
    production.dispose();
    availability.scene.dispose();
  });

  it.each([
    false,
    true,
  ])('records shared physical bindings with indirect first instance %s', async (firstInstanceIndirect) => {
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    Object.defineProperty(device, 'caps', { value: { ...device.caps, firstInstanceIndirect } });
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const viewBindGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const projection = new RenderScene();
    const availability = GpuScene.create(device, 8).unwrap();
    if (availability.status !== 'available') throw new Error('expected GPU Scene');
    const rows = Array.from({ length: 8 }, (_, index) => {
      const source = preparedPbrFixture(snapshot(index + 1, index + 10));
      const material = new MaterialResource({
        ...source.material.snapshot,
        standardTextureMask: index === 6 ? 4 : 0,
      });
      return { ...source, material, materials: [material] };
    });
    availability.scene.sync(projection.apply(rows.map(updateSnapshot))).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const sharedMesh = mesh(device);
    const prepared = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map(projection.slotsSnapshot().map(({ slot }) => [slot, sharedMesh])),
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    if (prepared === undefined) throw new Error('expected prepared frame');
    expect(production.inspect().batchCount).toBe(8);
    const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const group = () => device.createBindGroup({ layout: materialLayout, entries: [] }).unwrap();
    let sharedMaterial = group();
    const otherMaterial = group();
    const slots = [0, 0, 1, 1, 2, 2, 2, 2];
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const gpu = prepared.project(graph, 'rgba8unorm', 1).unwrap();
    const color = graph
      .createTexture('binding-transitions', {
        format: 'rgba8unorm',
        size: { width: 1, height: 1 },
      })
      .unwrap();
    const colorView = graph.view(color).unwrap();
    let encodes = 0;
    graph
      .addRasterPass('binding-transitions', {
        accesses: [...gpu.accesses, { resource: colorView, usage: 'color-attachment' }],
        colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store' }],
        encode: ({ pass, resources }) => {
          const frameResources = {
            ...prepared.standardPbrFrameResources,

            prepareMaterialBinding: (
              (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
              (slot: number) => {
                const group = groups[slot];
                return group === undefined ? undefined : { group, byteOffset: slot * 256 };
              }
            )([sharedMaterial, sharedMaterial, otherMaterial]),
            materialSlotIndicesByBinding: new Map(
              rows.map((row, index) => [row.material, new Map([['', slots.at(index) ?? 0]])]),
            ),
          };
          const bound = new Map<number, { group: BindGroup; offsets: readonly number[] }>();
          const originalBind = pass.setBindGroup.bind(pass);
          const bindings = vi
            .spyOn(pass, 'setBindGroup')
            .mockImplementation((index, value, offsets) => {
              bound.set(index, { group: value, offsets: [...(offsets ?? [])] });
              originalBind(index, value, [...(offsets ?? [])]);
            });
          const originalPipeline = pass.setPipeline.bind(pass);
          const pipelines = vi.spyOn(pass, 'setPipeline').mockImplementation((value) => {
            // setPipeline retains logical bindings. Changed groups and offsets
            // still update them; the real Browser gate proves backend compatibility.
            originalPipeline(value);
          });
          const originalDraw = pass.drawIndexedIndirect.bind(pass);
          const draws = vi
            .spyOn(pass, 'drawIndexedIndirect')
            .mockImplementation((buffer, offset) => {
              const slot = slots.at(draws.mock.calls.length - 1);
              expect(bound.get(1)).toEqual({
                group: slot === 2 ? otherMaterial : sharedMaterial,
                offsets: [(slot ?? 0) * 256],
              });
              expect(bound.get(2)?.offsets).toEqual([0]);
              expect(bound.get(3)).toBeDefined();
              originalDraw(buffer, offset);
            });
          const buffer = vi.fn(resources.buffer.bind(resources));
          gpu.encode(viewBindGroup, pass, { ...resources, buffer }, frameResources);
          expect(draws).toHaveBeenCalledTimes(8);
          expect(pipelines).toHaveBeenCalledTimes(3);
          expect(bindings.mock.calls.filter(([index]) => index === 1)).toHaveLength(3);
          expect(bindings.mock.calls.filter(([index]) => index === 2)).toHaveLength(1);
          expect(bindings.mock.calls.filter(([index]) => index === 3)).toHaveLength(
            firstInstanceIndirect ? 1 : 8,
          );
          // One shared vertex buffer, one index buffer and one indirect buffer.
          expect(buffer).toHaveBeenCalledTimes(3);
          expect(new Set(draws.mock.calls.map(([, offset]) => offset)).size).toBe(8);
          encodes += 1;
        },
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    try {
      for (let frame = 0; frame < 2; frame += 1) {
        const encoder = device.createCommandEncoder().unwrap();
        const result = compiled.execute({ encoder } as RenderPipelineFrame);
        if (!result.ok && result.error.detail !== undefined && 'cause' in result.error.detail) {
          throw result.error.detail.cause;
        }
        result.unwrap();
        encoder.finish().unwrap();
        sharedMaterial = group();
      }
      expect(encodes).toBe(2);
    } finally {
      (await compiled.retire()).unwrap();
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('projects aligned multi-batch compute work into one indirect raster pass', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const viewUniform = device
      .createBuffer({ size: 784, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const viewBindGroup = device
      .createBindGroup({
        layout: viewLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: viewUniform } } }],
      })
      .unwrap();
    const first = preparedPbrFixture(snapshot(1, 3));
    const firstDraw = first.gpuDrivenDraws?.[0];
    expect(firstDraw).toBeDefined();
    if (firstDraw === undefined) return;
    const second = { ...preparedPbrFixture(snapshot(2, 4)), worldId: 1 };
    const secondDraw = second.gpuDrivenDraws?.[0];
    expect(secondDraw).toBeDefined();
    if (secondDraw === undefined) return;
    const preparedMaterial = new MaterialResource({
      ...second.material.snapshot,
      materialHandle: 42,
      renderState: { cullMode: 'none' as const, depthCompare: 'less-equal' as const },
    });
    const renderables = [
      { ...first, gpuDrivenDraws: [firstDraw, { ...firstDraw, first: 3 }] },
      {
        ...second,
        material: preparedMaterial,
        materials: [preparedMaterial],
        gpuDrivenDraws: [
          {
            ...secondDraw,
            kind: 'non-indexed' as const,
            pipelineClass:
              'forgeax::default-unlit|triangle-list|{"cullMode":"none","depthCompare":"less-equal"}',
          },
        ],
      },
    ].map(preparedPbrFixture);
    const projection = new RenderScene();
    const delta = projection.apply(renderables.map((renderable) => updateSnapshot(renderable)));
    const availability = GpuScene.create(device, 2).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.query(topology.sourcePlan(), undefined)).toMatchObject({
      candidateCount: 3,
      visibleCapacity: 192,
    });
    expect([...topology.query(topology.sourcePlan(), undefined).batches]).toMatchObject([
      { visibleBase: 0 },
      { visibleBase: 64 },
      { visibleBase: 128 },
    ]);
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const meshes = new Map([
      [0, mesh(device)],
      [1, mesh(device, false)],
    ]);
    const prepared = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    for (const row of renderables) expect(prepared.selection.ownsAll(row)).toBe(true);
    expect(production.inspect()).toMatchObject({
      gpuOwnedSnapshotsMaterialized: 0,
      filteredPlanBuilds: 1,

      batchUploadBytes: 3 * GPU_DRIVEN_BATCH_STRIDE,
      viewBindGroupCreates: 1,
    });
    expect(production.inspect().sharedInputUploadBytes).toBeGreaterThan(0);

    prepared?._commitResourceReplacement();
    const stable = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    expect(stable?.topologySignature).toBe(prepared.topologySignature);
    expect(production.inspect()).toMatchObject({
      gpuOwnedSnapshotsMaterialized: 0,
      filteredPlanBuilds: 0,
      sharedInputUploadBytes: 0,
      batchUploadBytes: 0,
      viewConstantsUploadBytes: 784,
      viewBindGroupCreates: 0,
      batchBindGroupCreates: 0,
      indirectDrawCount: 3,
    });

    // This mixed batch has no LOD relation. Camera movement updates view
    // constants while retaining the scene topology and candidate uploads.
    const movedCamera = {
      ...makeZeroCameraFallbackSnapshot(),
      position: vec3.create(0, 0, 6),
    };
    stable?._commitResourceReplacement();
    const moved = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: movedCamera,
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    expect(moved).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      sharedInputUploadBytes: 0,
      batchUploadBytes: 0,
    });
    if (moved === undefined) return;

    const pipelineLookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'pipeline');
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const gpu = moved.project(graph, 'rgba8unorm', 1).unwrap();
    const projectedPipelineLookups = pipelineLookup.mock.calls.length;
    expect(projectedPipelineLookups).toBeGreaterThan(0);
    const materialBindGroup = device.createBindGroupLayout({ entries: [] }).unwrap();
    const frameResources = {
      ...moved.standardPbrFrameResources,
      prepareMaterialBinding: (
        (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
        (slot: number) => {
          const group = groups[slot];
          return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
        }
      )([
        ...Array.from({ length: 3 }, () =>
          device.createBindGroup({ layout: materialBindGroup, entries: [] }).unwrap(),
        ),
      ]),
    };
    expect(gpu.hasWork()).toBe(true);
    expect(gpu.hasWork('single-layer-medium')).toBe(false);
    expect(gpu.hasWork('opaque', 'fs_temporal')).toBe(false);
    let activeFrameResources = frameResources;
    const color = graph
      .createTexture('gpu-driven-production-color', {
        format: 'rgba8unorm',
        size: { width: 1, height: 1 },
      })
      .unwrap();
    const colorView = graph.view(color).unwrap();
    graph
      .addRasterPass('main', {
        accesses: [...gpu.accesses, { resource: colorView, usage: 'color-attachment' }],
        colorAttachments: [
          {
            view: colorView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        // Main-pass forward encodes request the base-slot entry admitted with
        // the batch; reusing it must not repeat the pipeline lookup.
        encode: ({ pass, resources }) =>
          gpu.encode(
            viewBindGroup,
            pass,
            resources,
            activeFrameResources,
            undefined,
            STANDARD_OPAQUE_FRAGMENT_ENTRY,
          ),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes.at(-1)).toMatchObject({
      name: 'main',
      dependencies: ['gpu-driven.frustum-compact', 'gpu-driven.finalize-indirect'],
    });
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-production' }).unwrap();
    compiled
      .execute({
        viewBindGroup,
        encoder,
        gpuDrivenStandardPbrFrameResources: frameResources,
      } as unknown as RenderPipelineFrame)
      .unwrap();
    encoder.finish().unwrap();
    expect(pipelineLookup).toHaveBeenCalledTimes(projectedPipelineLookups);
    expect(device.framePassNames).toEqual([
      'gpu-driven.view-reset',
      'gpu-driven.frustum-compact',
      'gpu-driven.finalize-indirect',
      'main',
    ]);
    expect(device.totalDispatchCount).toBe(3);
    expect(device.totalDrawCount).toBe(3);
    expect(production.inspect().indirectDrawCount).toBe(3);
    expect(production.inspect().indirectDrawCount).toBeLessThanOrEqual(
      production.inspect().batchCount,
    );

    const missingMaterialFrameResources = {
      ...frameResources,
      prepareMaterialBinding: (
        (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
        (slot: number) => {
          const group = groups[slot];
          return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
        }
      )([undefined]),
    };
    activeFrameResources = missingMaterialFrameResources;
    const missingMaterialEncoder = device
      .createCommandEncoder({ label: 'gpu-driven-production-missing-material' })
      .unwrap();
    const missingMaterialResult = compiled.execute({
      viewBindGroup,
      encoder: missingMaterialEncoder,
      gpuDrivenStandardPbrFrameResources: missingMaterialFrameResources,
    } as unknown as RenderPipelineFrame);
    expect(missingMaterialResult.ok).toBe(false);
    if (!missingMaterialResult.ok) {
      expect(missingMaterialResult.error.code).toBe('pass-encode-failed');
      const detail = missingMaterialResult.error.detail;
      expect(detail).toBeDefined();
      expect(detail !== undefined && 'cause' in detail).toBe(true);
      if (detail === undefined || !('cause' in detail)) return;
      expect(detail.cause).toBeInstanceOf(RhiError);
      expect((detail.cause as RhiError).code).toBe('rhi-not-available');
    }
    expect(pipelineLookup).toHaveBeenCalledTimes(projectedPipelineLookups);
    pipelineLookup.mockRestore();

    // The facet projection is the same admission set consumed by the GPU
    // candidate upload. A suppressed entity must disappear from the indirect
    // plan without making the remaining entity fall back to CPU validation.
    moved?._commitResourceReplacement();
    const activeOnly = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: movedCamera,
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,

          activeEntityKeys: new Set([worldEntityKey(0, 1)]),
          activeEntityRevision: 1,
        }),
      )
      .unwrap();
    for (const row of renderables) expect(activeOnly?.selection.ownsAll(row)).toBe(true);

    activeOnly?._commitResourceReplacement();
    const changedActive = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: movedCamera,
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,

          activeEntityKeys: new Set([worldEntityKey(1, 2)]),
          activeEntityRevision: 2,
        }),
      )
      .unwrap();
    for (const row of renderables) expect(changedActive?.selection.ownsAll(row)).toBe(true);
    // A changed admission revision only rewrites dirty suppression words; the
    // filtered plan and its per-frame build counter stay untouched.
    expect(production.inspect().filteredPlanBuilds).toBe(0);
    expect(production.inspect().suppressionUploadBytes).toBeGreaterThan(0);

    const replacement = GpuScene.create(device, 2).unwrap();
    expect(replacement.status).toBe('available');
    if (replacement.status !== 'available') return;
    replacement.scene.sync(delta).unwrap();
    changedActive?._commitResourceReplacement();
    const replacementPrepared = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: {
            scene: replacement.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    expect(replacementPrepared?.topologySignature).not.toBe(prepared.topologySignature);

    production.dispose();
    replacement.scene.dispose();
    availability.scene.dispose();
  });

  it('keeps an ineligible production topology empty while the camera moves', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const base = snapshot(1, 3);
    const material = new MaterialResource({
      ...base.material.snapshot,
      materialShaderId: 'forgeax::default-standard-pbr',
    });
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot({ ...base, material, materials: [material] })]);
    const availability = GpuScene.create(device, 1).unwrap();
    expect(availability.status).toBe('available');
    if (availability.status !== 'available') return;
    availability.scene.sync(delta).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    });
    const input = {
      scene: {
        scene: availability.scene,
        plan: topology.query(topology.sourcePlan(), undefined),
        slots: projection.slotsSnapshot(),
        slotAt: projection.slotAt,
      },
      meshBySlot: new Map([[0, mesh(device)]]),
      viewBindGroupLayout: viewLayout,
    } as const;

    expect(
      production
        .prepare(
          admitGpuFixture({
            ...input,
            camera: makeZeroCameraFallbackSnapshot(),
          }),
        )
        .unwrap(),
    ).toBeUndefined();
    expect(production.inspect().filteredPlanBuilds).toBe(0);
    expect(
      production
        .prepare(
          admitGpuFixture({
            ...input,
            camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 6) },
          }),
        )
        .unwrap(),
    ).toBeUndefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      gpuOwnedSnapshotsMaterialized: 0,
      gpuOwnedEntityCount: 0,
    });

    production.dispose();
    availability.scene.dispose();
  });

  it('preserves texture specialization through Renderer assembly and its PSO cache', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      {
        shaderManifestUrl: manifestDataUrl(`/* f_schlick( */ ${OUTPUT_TRANSFORM_WGSL}`, true),
      },
    );
    const pipelines = vi.spyOn(renderer.device, 'createRenderPipeline');
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const assets = renderer.assetRegistry;
      const world = new World({ assets });
      const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
      expect(renderer.attach(world)).toMatchObject({ ok: true });
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      const normalTexture = assets
        .create({
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
          format: 'rgba8unorm',
          data: new Uint8Array([128, 128, 255, 255]),
          colorSpace: 'linear',
          mips: { kind: 'none' },
        })
        .unwrap();
      for (const values of [{}, { normalTexture: { texture: normalTexture } }]) {
        const material = assets
          .create(
            Materials.standard({
              baseColor: [1, 1, 1, 1],
              renderState: { blend: { color: {}, alpha: {} } },
              ...values,
            }),
          )
          .unwrap();
        world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: cube } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
      }
      for (let frame = 0; frame < 4; frame += 1) {
        world.update(1 / 60).unwrap();
        expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })).toMatchObject({
          ok: true,
        });
        await Promise.resolve();
      }
      const specialized = () =>
        pipelines.mock.calls
          .map(([descriptor]) => descriptor.fragment?.constants?.['64000'])
          .filter((value) => value !== undefined);
      expect(specialized()).toEqual(expect.arrayContaining([0, 4]));
      const count = specialized().length;
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })).toMatchObject({
        ok: true,
      });
      expect(specialized()).toHaveLength(count);
    } finally {
      pipelines.mockRestore();
      renderer.dispose();
    }
  });

  it('preserves color writes and polygon bias through Renderer assembly and cache reuse', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      {
        shaderManifestUrl: manifestDataUrl(`/* f_schlick( */ ${OUTPUT_TRANSFORM_WGSL}`, true),
      },
    );
    const pipelines = vi.spyOn(renderer.device, 'createRenderPipeline');
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const assets = renderer.assetRegistry;
      const world = new World({ assets });
      const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
      expect(renderer.attach(world)).toMatchObject({ ok: true });
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      for (const renderState of [
        { colorWriteMask: 0, depthBias: -2, depthBiasSlopeScale: -1, depthBiasClamp: -0.1 },
        { colorWriteMask: 5, depthBias: 2, depthBiasSlopeScale: 1, depthBiasClamp: 0.1 },
      ]) {
        const material = assets
          .create(
            Materials.standard({
              baseColor: [1, 1, 1, 1],
              renderState,
            }),
          )
          .unwrap();
        world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: cube } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
      }
      for (let frame = 0; frame < 4; frame += 1) {
        world.update(1 / 60).unwrap();
        expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })).toMatchObject({
          ok: true,
        });
        await Promise.resolve();
      }
      const specialized = () =>
        pipelines.mock.calls
          .map(([descriptor]) => descriptor)
          .filter((descriptor) =>
            descriptor.fragment?.targets.some((target) => target?.writeMask !== undefined),
          );
      expect(specialized()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fragment: expect.objectContaining({
              targets: expect.arrayContaining([expect.objectContaining({ writeMask: 0 })]),
            }),
            depthStencil: expect.objectContaining({
              depthBias: 2,
              depthBiasSlopeScale: 1,
              depthBiasClamp: 0.1,
            }),
          }),
          expect.objectContaining({
            fragment: expect.objectContaining({
              targets: expect.arrayContaining([expect.objectContaining({ writeMask: 5 })]),
            }),
            depthStencil: expect.objectContaining({
              depthBias: -2,
              depthBiasSlopeScale: -1,
              depthBiasClamp: -0.1,
            }),
          }),
        ]),
      );
      const count = specialized().length;
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })).toMatchObject({
        ok: true,
      });
      expect(specialized()).toHaveLength(count);
    } finally {
      pipelines.mockRestore();
      renderer.dispose();
    }
  });

  it('keeps an ordinary mesh on the common CPU residual while the Standard graph stays active', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      { shaderManifestUrl: manifestDataUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const assets = renderer.assetRegistry;
    const world = new World({ assets });
    const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    expect(renderer.attach(world).ok).toBe(true);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 1] } },
        { component: PointLight, data: {} },
      )
      .unwrap();

    for (let frame = 0; frame < 4; frame += 1) {
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
      await Promise.resolve();
    }
    const device = renderer.device as RhiNullDevice;
    device.totalDrawCount = 0;
    world.update(1 / 60).unwrap();
    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
    expect(renderer.perFramePassNames).toEqual(
      expect.arrayContaining(['cluster-membership-producer', 'main', 'output-transform']),
    );
    expect(renderer.perFramePassNames).toContain('output-transform');
    // Storage-buffer LDR frames keep the scene linear until the one output
    // transform writes the encoded surface. The ordinary unprepared mesh
    // remains the CPU residual under common visibility projection, while the
    // clustered Standard graph and output transform stay active.
    expect(device.totalDrawCount).toBe(2);
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      fullRebuilds: 1,
      projectionRecords: 1,
      topology: { batchCount: 1, candidateCount: 1 },
      gpu: { status: 'resident' },
      gpuDriven: {
        gpuOwnedSnapshotsMaterialized: 0,
        filteredPlanBuilds: 0,
        sharedInputUploadBytes: 0,
        batchUploadBytes: 0,
        batchBindGroupCreates: 0,
        viewBindGroupCreates: 0,
        validatedGpuOwnedRows: 0,
        cpuFallbackDrawItems: 1,
      },
    });
    renderer.dispose();
  });

  it('keeps a stable multi-World composition resident and patches one World transform', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      { shaderManifestUrl: manifestDataUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const cameraWorld = new World({ assets: new AssetRegistry() });
    const assets = new AssetRegistry();
    const sceneWorld = new World({ assets });
    const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    expect(renderer.attach(cameraWorld).ok).toBe(true);
    expect(renderer.attach(sceneWorld).ok).toBe(true);
    cameraWorld
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    const rendered = sceneWorld
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();

    for (let frame = 0; frame < 4; frame += 1) {
      cameraWorld.update(1 / 60).unwrap();
      sceneWorld.update(1 / 60).unwrap();
      expect(
        renderer.draw([cameraWorld, sceneWorld], { cameraOwner: 0, resourceOwner: 0 }).ok,
      ).toBe(true);
      await Promise.resolve();
    }
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      projectionRecords: 1,
      topology: { batchCount: 1, candidateCount: 1 },
      gpu: { status: 'resident' },
      gpuDriven: { cpuFallbackDrawItems: 1, validatedGpuOwnedRows: 0 },
    });

    sceneWorld.set(rendered, Transform, { pos: [1, 0, 0] }).unwrap();
    cameraWorld.update(1 / 60).unwrap();
    sceneWorld.update(1 / 60).unwrap();
    expect(renderer.draw([cameraWorld, sceneWorld], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(
      true,
    );
    expect(renderer.renderScene).toMatchObject({
      worldEntitiesScanned: 0,
      fullRebuilds: 1,
      transformUpdates: 1,
      projectionRecords: 1,
    });
    renderer.dispose();
  });

  it('routes mixed ordinary camera and light edits through common visibility projection', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      { shaderManifestUrl: manifestDataUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const assets = renderer.assetRegistry;
    const world = new World({ assets });
    const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    expect(renderer.attach(world).ok).toBe(true);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    const lamp = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 1] } },
        { component: PointLight, data: { intensity: 1, range: 10 } },
      )
      .unwrap();
    const projectVisibility = vi.spyOn(PersistentRenderScene.prototype, 'projectVisibility');
    try {
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
      const warmProjectCalls = projectVisibility.mock.calls.length;
      const before = renderer.inspect().renderScene;

      world.set(camera, Transform, { pos: [0, 1, 5] }).unwrap();
      world.set(lamp, PointLight, { intensity: 3, range: 8 }).unwrap();
      propagateTransforms(world).unwrap();
      world.update(1 / 60).unwrap();
      expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);

      expect(projectVisibility.mock.calls.length).toBeGreaterThan(warmProjectCalls);
      const after = renderer.inspect().renderScene;
      expect(after).toMatchObject({
        fullRebuilds: 1,
        projectionRecords: before.projectionRecords,
      });
      expect(after.topology.revision).toBe(before.topology.revision);
    } finally {
      projectVisibility.mockRestore();
      renderer.dispose();
    }
  });
});

describe('GPU-driven early GBuffer ordering diagnostic command contract', () => {
  it('reports real Renderer extraction, material registry, factory and cached graph gate inputs', async () => {
    const manifest = JSON.parse(
      decodeURIComponent(
        manifestDataUrl('// f_schlick( diagnostic factory', true).split(',')[1] ?? '',
      ),
    );
    const row = manifest.materialShaders.find(
      (entry: { identifier: string }) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    row.variants = standardPbrFixtureVariants(row.composedWgsl).map((variant) => ({
      ...variant,
      receipt: STANDARD_PBR_RECEIPT,
    }));
    const lifecycle = JSON.parse(
      decodeURIComponent(renderLifecycleManifestUrl().split(',')[1] ?? ''),
    );
    manifest.entries.push(...lifecycle.entries);
    manifest.materialShaders.push(
      ...lifecycle.materialShaders.filter(
        (entry: { identifier: string }) =>
          !manifest.materialShaders.some(
            (known: { identifier: string }) => known.identifier === entry.identifier,
          ),
      ),
    );
    const renderer = await constructRenderer(
      {
        width: 16,
        height: 16,
        getContext: () => null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as HTMLCanvasElement,
      { rhi },
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`,
      },
    );
    try {
      expect((await renderer.initialization).ok).toBe(true);
      expect(
        renderer.setProfile({
          ...renderer.inspect().profile,
          renderPath: 'deferred',
          gbufferBatchOrderDiagnostic: { order: 'near', programDigests: [] },
        }).ok,
      ).toBe(true);
      const assets = renderer.assetRegistry;
      const world = new World({ assets });
      const meshHandle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
      expect(renderer.attach(world).ok).toBe(true);
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();
      const material = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
      for (const z of [0, -2])
        world
          .spawn(
            { component: Transform, data: { pos: [0, 0, z] } },
            { component: MeshFilter, data: { assetHandle: meshHandle } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
      for (let frame = 0; frame < 4; frame++) {
        world.update(1 / 60).unwrap();
        const result = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
        if (!result.ok) throw result.error;
        await result.value?.completed;
      }
      const proof = renderer.inspect().renderScene.gpuDriven?.gbufferBatchOrderDiagnostic;
      expect(proof?.status).toBe('evaluated');
      expect(proof?.denominator?.selected).toBeGreaterThan(0);
      expect(proof?.classes?.length).toBeGreaterThan(0);
      expect(
        proof?.classes?.every((entry) => entry.facts.selectedVertexEntry === 'vs_scene_index'),
      ).toBe(true);
      expect(proof?.rejections?.['program-digest']).toBe(proof?.denominator?.live);
      expect(proof?.rejections).toEqual({ 'program-digest': proof?.denominator?.live });
      expect(proof?.batches?.length).toBe(proof?.denominator?.live);
      expect(proof?.encodes.some((entry) => entry.phase === 'late' && !entry.admitted)).toBe(true);
    } finally {
      renderer.dispose();
    }
  });
  it('sorts authored Forward overlays through the real factory entry selection, preserving raw and unknown programs', async () => {
    const { gbufferProgramDigest } = await import('../gpu-driven/gbuffer-order-diagnostic');
    const device = (
      await (await rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap() as RhiNullDevice;
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const pbrInputs = standardPbrInputs(device, shader, viewLayout);
    const baseArtifact = pbrInputs.materialArtifact;
    const pipelineLayout = pbrInputs.materialPipelineState?.gpuDrivenPbrPipelineLayout;
    if (baseArtifact === undefined || pipelineLayout === undefined || pipelineLayout === null)
      throw Error('missing fixture material pipeline');
    const forwardArtifact = {
      ...baseArtifact,
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_main',
    };
    const selectedEntries: string[] = [];
    const pipelineFactory: NonNullable<
      Parameters<GpuDrivenProduction['prepare']>[0]['materialPipelineFactory']
    > = (...args) => {
      const entryPoint = resolveMaterialPipelineVertexEntry(args[15], args[16], args[18]);
      if (entryPoint === undefined) throw Error('missing selected scene-index entry');
      selectedEntries.push(entryPoint);
      return {
        group2Contract: 'mesh',
        pipeline: device
          .createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module: shader, entryPoint, buffers: [] },
            fragment: {
              module: shader,
              entryPoint: args[19] ?? 'fs_main',
              targets: [args[9] ?? 'rgba16float', ...(args[17] ?? [])].map((format) => ({
                format,
              })),
            },
          })
          .unwrap(),
      };
    };
    const projection = new RenderScene();
    const topology = new BatchTopology();
    const availability = GpuScene.create(device, 8).unwrap();
    if (availability.status !== 'available') throw Error('GPU scene unavailable');
    const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
    const rows = [8, 2, 4, 9, 1].map((depth, index) => {
      const source = preparedPbrFixture(snapshot(index + 1, index + 1));
      source.transform.world[14] = -depth;
      const material = new MaterialResource({
        ...source.material.snapshot,
        deferredPass: true,
        renderState: {
          depthCompare: 'greater' as const,
          ...(index === 2 ? { depthWriteEnabled: false } : {}),
        },
        passes: source.material.snapshot.passes.map((pass) => ({
          ...pass,
          renderState: {
            ...pass.renderState,
            depthCompare: 'greater' as const,
            ...(index === 2 ? { depthWriteEnabled: false } : {}),
          },
        })),
      });
      return { ...source, material, materials: [material] };
    });
    availability.scene.sync(projection.apply(rows.map(updateSnapshot))).unwrap();
    topology.rebuild(projection.slotsSnapshot());
    const meshes = new Map(rows.map((_, index) => [index, mesh(device)]));
    const emptyGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
    const encode = async (
      order: 'near' | 'far' | undefined,
      known = true,
      stock = true,
      sourceFailure?: 'morph' | 'displacement' | 'bounds',
    ) => {
      for (const row of rows)
        row.material.adopt({
          ...row.material.snapshot,
          paramSnapshot: {
            ...row.material.snapshot.paramSnapshot,
            displacementScale: sourceFailure === 'displacement' ? 2 : 0,
          },
        });
      const admitted = admitGpuFixture({
        ...pbrInputs,
        materialArtifact: forwardArtifact,
        materialPipelineFactory: pipelineFactory,
        scene: {
          scene: availability.scene,
          plan: topology.query(topology.sourcePlan(), undefined),
          slots: projection.slotsSnapshot(),
          slotAt:
            sourceFailure === undefined || sourceFailure === 'displacement'
              ? projection.slotAt
              : (index: number) => {
                  const slot = projection.slotAt(index);
                  if (slot === undefined) return undefined;
                  const source = { ...slot.snapshot };
                  if (sourceFailure === 'bounds') delete source.localAabb;
                  return {
                    ...slot,
                    snapshot: {
                      ...source,
                      ...(sourceFailure === 'morph'
                        ? { morph: {} as NonNullable<RenderableSnapshot['morph']> }
                        : {}),
                    },
                  };
                },
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: meshes,
        viewBindGroupLayout: viewLayout,
        ...(order === undefined
          ? {}
          : {
              gbufferBatchOrderDiagnostic: {
                order,
                programDigests: [gbufferProgramDigest(known ? 'synthetic' : 'unknown')],
              },
            }),
      });
      if (admitted.materialFrame === undefined) throw new Error('Missing accepted material frame');
      availability.scene
        .sync({ ...projection.apply([]), materials: admitted.materialFrame })
        .unwrap();
      const prepared = production.prepare(admitted).unwrap();
      if (prepared === undefined) throw new Error('Missing prepared GPU fixture');
      const graph = new RenderGraphBuilder<RenderPipelineFrame>();
      const formats = ['r32uint', 'r32uint', 'r32uint', 'r32uint', 'rg32uint'] as const;
      const gpu = prepared
        .project(graph, 'rgba16float', 1, undefined, formats, false, stock)
        .unwrap();
      const colors = (['rgba16float', ...formats] as const).map((format, index) =>
        graph
          .view(
            graph
              .createTexture(`order-${index}`, { format, size: { width: 1, height: 1 } })
              .unwrap(),
          )
          .unwrap(),
      );
      const offsets: number[] = [];
      graph
        .addRasterPass('order', {
          accesses: [
            ...gpu.accesses,
            ...colors.map((resource) => ({ resource, usage: 'color-attachment' as const })),
          ],
          colorAttachments: colors.map((view) => ({
            view,
            loadOp: 'clear' as const,
            storeOp: 'store' as const,
          })),
          encode: ({ pass, resources }) => {
            const draw = vi.spyOn(pass, 'drawIndexedIndirect');
            gpu.encode(
              emptyGroup,
              pass,
              resources,
              {
                ...prepared.standardPbrFrameResources,
                prepareMaterialBinding: (slot) => ({ group: emptyGroup, byteOffset: slot * 256 }),
                colorFormats: ['rgba16float', ...formats],
              },
              'deferred-opaque',
              'fs_gbuffer',
            );
            offsets.push(...draw.mock.calls.map(([, offset]) => offset));
          },
        })
        .unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      try {
        const encoder = device.createCommandEncoder().unwrap();
        compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
        encoder.finish().unwrap();
      } finally {
        prepared._commitResourceReplacement();
        (await compiled.retire()).unwrap();
      }
      return offsets;
    };
    try {
      const base = await encode(undefined);
      expect(base).toHaveLength(5);
      const near = await encode('near');
      expect(near).toEqual([base[1], base[0], base[2], base[4], base[3]]);
      expect(production.inspect().gbufferBatchOrderDiagnostic).toMatchObject({
        mode: 'near',
        eligibleBatches: 4,
        movedBatches: 4,
        status: 'evaluated',
        denominator: { live: 5, selected: 5 },
        rejections: { 'interface/depthWrite': 1 },
      });
      const evidence = production.inspect().gbufferBatchOrderDiagnostic;
      expect(evidence?.batches).toHaveLength(5);
      expect(
        evidence?.classes?.every(
          (row) => row.auditedSource && row.facts.depthCompare === 'greater',
        ),
      ).toBe(true);
      expect(evidence?.encodes).toMatchObject([
        {
          filter: 'deferred-opaque',
          fragmentEntry: 'fs_gbuffer',
          phase: 'all',
          colorTargetCount: 6,
          admitted: true,
        },
      ]);
      expect(await encode('far')).toEqual(base);
      expect(await encode('near', false)).toEqual(base);
      expect(production.inspect().gbufferBatchOrderDiagnostic?.eligibleBatches).toBe(0);
      expect(production.inspect().gbufferBatchOrderDiagnostic?.rejections?.['program-digest']).toBe(
        5,
      );
      for (const [failure, reason] of [
        ['morph', 'source-or-deformation'],
        ['displacement', 'displacement'],
        ['bounds', 'bounds-invalid'],
      ] as const) {
        expect(await encode('near', false, true, failure)).toEqual(base);
        const proof = production.inspect().gbufferBatchOrderDiagnostic;
        expect(proof?.rejections?.[`bounds/${reason}`]).toBe(5);
        expect(proof?.rejections?.['program-digest']).toBe(5);
        expect(proof?.rejections?.['interface/depthWrite']).toBe(1);
        expect(proof?.batches?.every((row) => row.rejectedSource !== undefined)).toBe(true);
      }
      expect(await encode('near', true, false)).toEqual(base);
      expect(production.inspect().gbufferBatchOrderDiagnostic).toMatchObject({
        status: 'not-encoded',
        encodes: [{ rendererRecording: false, admitted: false }],
      });
      expect(selectedEntries.length).toBeGreaterThan(0);
      expect(new Set(selectedEntries)).toEqual(new Set(['vs_scene_index']));
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  });
});
