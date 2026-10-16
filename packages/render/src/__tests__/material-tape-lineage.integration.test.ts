import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  serializeCookedMaterialRecord,
} from '@forgeax/engine-pack';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import {
  createShaderModule,
  createShaderModuleImmediate,
  RhiNullDevice,
  RhiNullQueue,
  rhi,
} from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  bindRhiCaptureFrameDriver,
  createRhiCapture,
  createRhiInstrumentation,
} from '../../../app/src/internal/rhi-capture';
import { materialRecordFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { createRenderer } from '../assembly/factory';
import { ANTIALIAS_NONE, Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { renderMaterialContext } from '../extract/material-context';
import type { FrameReceipt } from '../render-contract';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

// A deterministic cooked transport fixture, not a GPU compiler or pixel proof.
const wgsl =
  '@vertex fn vs_main(@location(0) p: vec3f) -> @builtin(position) vec4f { return vec4f(p, 1); }\n@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }';
async function fixture() {
  const attached = attachRecorder({ rhi, createShaderModule, createShaderModuleImmediate });
  if (!attached.ok) throw attached.error;
  const attachment = attached.value;
  const recorderInstrumentation = createRhiInstrumentation(attachment);
  const textureViewFailures: unknown[] = [];
  const instrumentation = {
    ...recorderInstrumentation,
    resolveSurfaceDevice(
      device: Parameters<NonNullable<typeof recorderInstrumentation.resolveSurfaceDevice>>[0],
    ) {
      const createView = device.createTextureView.bind(device);
      vi.spyOn(device, 'createTextureView').mockImplementation((texture, descriptor) => {
        const result = createView(texture, descriptor);
        if (!result.ok) textureViewFailures.push({ descriptor, error: result.error });
        return result;
      });
      const resolve = recorderInstrumentation.resolveSurfaceDevice;
      if (resolve === undefined) throw new Error('missing actual surface device resolver');
      return resolve(device);
    },
  };
  const acquireCanvasContext = attachment.backend.rhi.acquireCanvasContext;
  if (acquireCanvasContext === undefined)
    throw new Error('missing actual recorder canvas capability');
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhiInstrumentation: instrumentation },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
    {
      ...attachment.backend,
      rhi: {
        ...attachment.backend.rhi,
        acquireCanvasContext: acquireCanvasContext.bind(attachment.backend.rhi),
      },
      instrumentation,
    },
  );
  const initialized = await renderer.initialization;
  if (!initialized.ok) throw initialized.error;
  const ownerErrors: unknown[] = [];
  renderer.onError((error) => {
    ownerErrors.push(error);
  });
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const native = await adapter.value.requestDevice();
  if (!native.ok) throw native.error;
  const context = renderMaterialContext(native.value.caps, native.value.limits).materialContext;
  expect(native.value.caps.backendKind).toBe('null');
  expect(context).toBeDefined();
  if (context === undefined)
    throw new Error('Null must select the structural WGSL material domain');
  const records = [0, 1].map((index) => {
    const original = materialRecordFixture({
      guid: `019f0000-0000-7000-8000-00000000070${index + 1}`,
      passes: [
        {
          name: 'Forward',
          program: { module: 'game::ready' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      contexts: [context],
    });
    const bytes = new TextEncoder().encode(wgsl);
    const programs = original.programs.map((program) => ({
      ...program,
      specializationKey: `lineage/program/${index}`,
      artifact: { ...program.artifact, bytes, digest: createMaterialArtifactDigest(bytes) },
    }));
    const artifactDigest = createMaterialProgramSetDigest(programs, original.resolved.passes);
    return {
      ...original,
      programs,
      artifactDigest,
      receipt: { ...original.receipt, identity: { ...original.receipt.identity, artifactDigest } },
    };
  });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/lineage-index.json'))
      return new Response(
        JSON.stringify(
          records.map((record) => ({
            guid: record.guid,
            kind: 'material',
            packageUrl: '/lineage.pack.json',
          })),
        ),
      );
    if (url.endsWith('/lineage.pack.json'))
      return new Response(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: records.map((record) => ({
            guid: record.guid,
            kind: 'material',
            execution: 'cooked',
            payload: {
              kind: 'material',
              ...record.resolved,
              cooked: JSON.parse(serializeCookedMaterialRecord(record)),
            },
            refs: [],
          })),
        }),
      );
    return originalFetch(input, init);
  });
  renderer.assetRegistry.configurePackIndex('/lineage-index.json');
  const worlds = [new World(), new World()] as const;
  const leases = worlds.map((world) => {
    registerPropagateTransforms(world);
    const lease = renderer.attach(world);
    if (!lease.ok) throw lease.error;
    return lease.value;
  });
  // Null swapchain handles have no readable texture descriptor. Use a real
  // Renderer-owned public target; no fabricated tape/resource metadata.
  const target = renderer.createRenderTarget({
    shape: '2d',
    width: 64,
    height: 64,
    format: 'rgba16float',
    mipLevels: 1,
    sampleCount: 1,
    sampled: true,
    readback: false,
  });
  if (!target.ok) throw target.error;
  const targetGrant = worlds[0].allocSharedRef('RenderTarget', target.value);
  worlds[0]
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          target: targetGrant,
        },
      },
      { component: CameraView, data: {} },
    )
    .unwrap();
  const grants: { readonly world: World; readonly grant: Handle<'MaterialAsset', 'shared'> }[] = [];
  for (const [index, record] of records.entries()) {
    const loaded = await renderer.assetRegistry.loadByGuid<MaterialAsset>(
      renderer.assetRegistry.parseGuid(record.guid),
    );
    if (!loaded.ok) throw loaded.error;
    expect(renderer.assetRegistry.getMaterialReadiness(record.guid)?.status).toBe('Ready');
    const world = worlds[index];
    if (world === undefined) throw new Error('missing fixture World');
    const grant = world.allocSharedRef('MaterialAsset', loaded.value);
    grants.push({ world, grant });
    world
      .spawn(
        { component: Transform, data: { pos: [index - 0.5, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [grant] } },
      )
      .unwrap();
    world.update().unwrap();
  }
  const cameraLease = leases[0];
  if (cameraLease === undefined) throw new Error('missing actual camera lease');
  const input = {
    leases,
    camera: { lease: cameraLease },
    environment: { lease: cameraLease },
    geometryLane: 'direct' as const,
  };
  const submitted = new Set<(receipt: FrameReceipt) => void>();
  let last: FrameReceipt | undefined;
  const draw = () => {
    const result = renderer.draw(input);
    if (!result.ok)
      throw new Error(
        `actual Renderer draw failed: ${JSON.stringify({ ownerErrors, textureViewFailures })}`,
        {
          cause: new AggregateError([result.error, ...ownerErrors], 'actual owner failures', {
            cause: result.error,
          }),
        },
      );
    last = result.value === undefined ? undefined : result.value;
    if (last !== undefined) for (const listener of submitted) listener(last);
    return result;
  };
  const dispose = async () => {
    const failures: unknown[] = [];
    const rendererDisposed = await renderer.dispose();
    if (!rendererDisposed.ok) failures.push(rendererDisposed.error);
    const recorderDisposed = await attachment.dispose();
    if (!recorderDisposed.ok) failures.push(recorderDisposed.error);
    worlds[0].sharedRefs.release(targetGrant);
    for (const { world, grant } of grants) world.sharedRefs.release(grant);
    for (const world of worlds) {
      const cleared = world.despawnAll();
      if (!cleared.ok) failures.push(cleared.error);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (failures.length > 0) throw new AggregateError(failures, 'fixture cleanup failed');
  };
  // Bounded CPU initialization of actual resource/pipeline adoption.
  try {
    for (let i = 0; i < 6; i++) {
      draw();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (cause) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'fixture startup and cleanup failed', { cause });
    }
    throw cause;
  }
  const capture = createRhiCapture(attachment);
  bindRhiCaptureFrameDriver(capture, {
    getState: () => 'paused',
    pause: () => ok(undefined),
    resume: () => ok(undefined),
    stepFrame: () => {
      draw();
      return ok(undefined);
    },
    subscribeSubmitted: (listener) => {
      submitted.add(listener);
      return () => {
        submitted.delete(listener);
      };
    },
  });
  return {
    renderer,
    attachment,
    capture,
    records,
    worlds,
    leases,
    input,
    draw,
    get receipt() {
      return last;
    },
    dispose,
  };
}

describe('real material publication to submitted tape lineage', () => {
  it('resolves cached published pipelines without enumerating the shader manifest', async () => {
    const f = await fixture();
    try {
      const scans = vi.spyOn(ShaderRegistry.prototype, 'materialShaderManifestEntries');
      const lookups = vi.spyOn(ShaderRegistry.prototype, 'materialShaderManifestEntry');
      const builds = vi.spyOn(RhiNullDevice.prototype, 'createRenderPipeline');
      for (let frame = 0; frame < 3; frame++) {
        for (const world of f.worlds) world.update().unwrap();
        expect(f.draw().ok).toBe(true);
      }
      expect(f.receipt).toBeDefined();
      expect(scans).not.toHaveBeenCalled();
      expect(builds).not.toHaveBeenCalled();
      for (const record of f.records) {
        for (const program of record.programs) {
          expect(lookups).toHaveBeenCalledWith(program.specializationKey);
        }
      }
    } finally {
      await f.dispose();
    }
  });

  it('keeps two same-source program/World identities through actual draw and App capture', async () => {
    const f = await fixture();
    try {
      const captured = await f.capture.captureFrame({ seed: { maxResourceBytes: 0 } });
      if (!captured.ok) throw captured.error;
      expect(captured.value.submittedFrame.status).toBe('complete');
      if (captured.value.submittedFrame.status !== 'complete')
        throw new Error('missing actual issued receipt');
      const receipt = captured.value.submittedFrame.receipt;
      expect(receipt).toBe(f.receipt);
      expect(receipt.backendId).toBe('null');
      const observed = await f.renderer.observe(receipt, { include: ['draws'] });
      if (!observed.ok) throw observed.error;
      expect(observed.value.draws).toMatchObject({ status: 'complete' });
      if (observed.value.draws?.status !== 'complete')
        throw new Error('missing complete direct lineage');
      const rows = observed.value.draws.draws;
      expect(new Set(rows.map((row) => row.worldIdentity))).toEqual(
        new Set(f.worlds.map((world) => world.identity)),
      );
      expect(new Set(rows.map((row) => row.program.specializationKey))).toEqual(
        new Set(
          f.records.flatMap((record) =>
            record.programs.map((program) => program.specializationKey),
          ),
        ),
      );
      const decoded = decodeTape(captured.value.bytes);
      if (!decoded.ok) throw decoded.error;
      const model = buildFrameModel(decoded.value);
      for (const row of rows) {
        expect(row.pipeline.captureGeneration).toBe(
          captured.value.submittedFrame.captureGeneration,
        );
        const work = model.works.find(
          (work) => work.pipeline?.pipelineHandleId === row.pipeline.handleId,
        );
        expect(work).toBeDefined();
        expect(work?.pipeline?.shaders.some((shader) => shader.source === wgsl)).toBe(true);
        expect(row.program.artifactHash).toBe(
          createMaterialArtifactDigest(new TextEncoder().encode(wgsl)),
        );
        expect(row.publication.materialGuid).toBe(
          f.records.find((record) =>
            record.programs.some(
              (program) => program.specializationKey === row.program.specializationKey,
            ),
          )?.guid,
        );
        expect(Object.isFrozen(row.program.context)).toBe(true);
      }
      expect(Object.isFrozen(rows)).toBe(true);
    } finally {
      await f.dispose();
    }
  });
  it('does not claim a failed submit or detached lease as accepted material draws', async () => {
    const f = await fixture();
    try {
      const captured = await f.capture.captureFrame({ seed: { maxResourceBytes: 0 } });
      if (!captured.ok || captured.value.submittedFrame.status !== 'complete')
        throw new Error('missing control receipt');
      const old = captured.value.submittedFrame.receipt;
      vi.spyOn(RhiNullQueue.prototype, 'submit').mockImplementationOnce(() => {
        throw new Error('controlled submit failure');
      });
      expect(() => f.draw()).toThrow();
      expect(f.receipt).toBe(old);
      f.renderer.detachScene(f.worlds[1]);
      const observed = await f.renderer.observe(old, { include: ['draws'] });
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;
      expect(observed.value.draws?.status).toBe('unavailable');
    } finally {
      vi.restoreAllMocks();
      await f.dispose();
    }
  });
});
