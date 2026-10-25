import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { createProfiler } from '@forgeax/engine-profiler';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import {
  type PipelineLibrary,
  type PipelineLibraryInspection,
  type PipelineLibraryManifest,
  RhiError,
  type RhiWebgpuRuntimeCause,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import {
  RhiNullAdapter,
  RhiNullCommandEncoder,
  RhiNullDevice,
  RhiNullQueue,
  rhi,
} from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { RhiBackendPack } from '../assembly/backend-contract';
import { createRenderer as constructRenderer } from '../assembly/factory';
import {
  BarrelDistortion,
  DirectionalLight,
  DynamicResolution,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  PointLight,
  SpotLight,
} from '../components';
import {
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera as LocalCamera,
  TONEMAP_ACES_FILMIC,
  TONEMAP_NONE,
} from '../components/camera';
import { TemporalFrameSubmitError } from '../errors/render';
import type { RenderFeaturePlanContext, RenderFeatureWork } from '../features/plan';
import type { RenderFeature } from '../features/types';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

const assemblyDirectory = dirname(fileURLToPath(import.meta.url));
const factorySourcePath = resolve(assemblyDirectory, '../assembly/factory.ts');
const webgpuRendererSourcePath = resolve(assemblyDirectory, '../assembly/webgpu-renderer.ts');
const renderTargetHostSourcePath = resolve(assemblyDirectory, '../assembly/render-target-host.ts');

function manifestUrl(): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createBloomScenario(
  tonemap: typeof TONEMAP_NONE | typeof TONEMAP_ACES_FILMIC = TONEMAP_ACES_FILMIC,
) {
  const canvas = { width: 64, height: 64, getContext: () => null };
  const renderer = await constructRenderer(
    canvas,
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  if (!(await renderer.initialization).ok) throw new Error('Bloom renderer initialization failed');
  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  registerPropagateTransforms(world);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: LocalCamera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          tonemap,
          bloom: BLOOM_ENABLED,
          bloomThreshold: 1,
          bloomIntensity: 1,
          bloomSmoothWidth: 0.01,
          bloomRadius: 0,
        },
      },
    )
    .unwrap();
  const frameInput = () => ({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  const draw = () => renderer.draw(frameInput());
  const setBloom = (bloom: 'on' | 'off') => {
    world
      .set(camera, LocalCamera, {
        bloom: bloom === 'on' ? BLOOM_ENABLED : BLOOM_DISABLED,
        tonemap,
      })
      .unwrap();
    const updated = world.update();
    if (!updated.ok) throw updated.error;
  };
  const setBloomIntensity = (bloomIntensity: number) => {
    world.set(camera, LocalCamera, { bloomIntensity }).unwrap();
    const updated = world.update();
    if (!updated.ok) throw updated.error;
  };
  const dispose = async () => {
    await renderer.dispose();
  };
  return { renderer, draw, setBloom, setBloomIntensity, dispose, canvas };
}

async function createMotionBlurScenario() {
  const renderer = await constructRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  if (!(await renderer.initialization).ok)
    throw new Error('Motion Blur renderer initialization failed');
  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  registerPropagateTransforms(world);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: LocalCamera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_ACES_FILMIC,
        },
      },
    )
    .unwrap();
  world
    .addComponent(camera, {
      component: MotionBlur,
      data: { shutterAngle: 180, maxRadiusPixels: 8, sampleCount: 4, targetFps: 60 },
    })
    .unwrap();
  const frameInput = () => ({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  return {
    renderer,
    draw: () => renderer.draw(frameInput()),
    dispose: () => renderer.dispose(),
  };
}

function createGenericPostProbeFeature(): RenderFeature<undefined> {
  return {
    identity: 'synthetic.generic-post-probe',
    placement: 'post',
    shaderModuleMode: 'immediate',
    extract: () => ok(undefined),
    plan: (_data: unknown, context: RenderFeaturePlanContext) =>
      ok({
        work: context.views
          .filter((view) => view.render)
          .map<RenderFeatureWork>((view) => ({
            scope: { view: view.identity },
            resources: [
              {
                kind: 'compute-program' as const,
                name: 'generic-post-probe-program',
                program: {
                  wgsl: '@compute @workgroup_size(1) fn main() {}',
                  entryPoints: ['main'],
                },
              },
              {
                kind: 'compute-bindings' as const,
                name: 'generic-post-probe-bindings',
                program: 'generic-post-probe-program',
                entries: [],
              },
            ],
            passes: [
              {
                kind: 'compute' as const,
                name: 'generic-post-probe',
                program: 'generic-post-probe-program',
                bindings: 'generic-post-probe-bindings',
                dispatches: [{ kind: 'direct' as const, entryPoint: 'main', workgroups: [1] }],
              },
            ],
          })),
      }),
  };
}

describe('factory contract', () => {
  it.each([
    'webgpu',
    'wgpu-webgl2',
  ] as const)('keeps the %s backend and ordinary compilation when a pipeline library is unavailable', async (backendKind) => {
    const adapter = new RhiNullAdapter();
    const device = (await adapter.requestDevice()).unwrap();
    Object.defineProperty(device, 'caps', { value: { ...device.caps, backendKind } });
    const compile = vi.spyOn(device, 'createRenderPipeline');
    const backend = {
      ...rhi,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => ok(device),
        }),
    };
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      {
        rhi: backend,
        pipelineLibrary: {
          version: 1,
          backend: 'webgpu',
          shaders: [],
          bindGroupLayouts: [],
          pipelineLayouts: [],
          renderPipelines: [],
          computePipelines: [],
        },
      },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    try {
      expect((await renderer.initialization).ok).toBe(true);
      expect(renderer.inspect().capabilities.backendKind).toBe(backendKind);
      expect(renderer.inspect().state).toBe('alive');
      expect(compile).toHaveBeenCalled();
    } finally {
      await renderer.dispose();
    }
  });

  it('includes a feature installed during library preparation in initialization prewarm', async () => {
    const libraryFence = deferred<void>();
    const inspection: PipelineLibraryInspection = {
      state: 'active',
      shaders: 0,
      renderPipelines: 0,
      computePipelines: 0,
      shaderHits: 0,
      pipelineHits: 0,
      synchronousCreations: 0,
      asynchronousCreations: 0,
      compilationCompleted: 0,
      compilationPending: 0,
      failures: 0,
      unrecordable: 0,
      overflow: 0,
      sourceBytes: 0,
      warmup: { requested: 0, completed: 0, failed: 0, elapsedMs: 0 },
      backgroundWarmup: {
        requested: 0,
        completed: 0,
        failed: 0,
        elapsedMs: 0,
        state: 'idle' as const,
      },
    };
    const pipelineLibrary: PipelineLibraryManifest = {
      version: 1,
      backend: 'webgpu',
      shaders: [],
      bindGroupLayouts: [],
      pipelineLayouts: [],
      renderPipelines: [],
      computePipelines: [],
    };
    const library = {
      prepare: vi.fn(async () => {
        await libraryFence.promise;
        return ok(inspection);
      }),
      inspect: () => inspection,
      export: () => ok(pipelineLibrary),
    } satisfies PipelineLibrary;
    const adapter = new RhiNullAdapter();
    const device = Object.assign((await adapter.requestDevice()).unwrap(), {
      pipelineLibrary: library,
    });
    const compile = vi.fn(rhi.createShaderModule);
    const backend = {
      ...rhi,
      createShaderModule: compile,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => ok(device),
        }),
    };
    const shaderId = 'game::late-library-feature';
    const variantSource = '// late feature ordinary variant';
    const manifest = await (await fetch(renderLifecycleManifestUrl())).json();
    manifest.materialShaders.push({
      identifier: shaderId,
      sourcePath: 'fixture://late-library-feature.wgsl',
      composedWgsl: '// late feature base',
      paramSchema: '[]',
      variants: [
        { definesKey: '', defines: { STYLE: true }, composedWgsl: '// late feature base' },
        { definesKey: 'STYLE=false', defines: { STYLE: false }, composedWgsl: variantSource },
      ],
    });
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi: backend, pipelineLibrary },
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`,
      },
    );
    try {
      let startupError: unknown;
      void renderer.initialization.then((result) => {
        if (!result.ok) startupError = result.error;
      });
      await vi.waitFor(() => {
        if (startupError !== undefined) throw startupError;
        expect(library.prepare).toHaveBeenCalledOnce();
      });
      const installed = await renderer.installRenderFeature({
        identity: 'late-library-feature',
        requiredMaterialShaders: [shaderId],
        extract: () => ok(undefined),
        plan: () => ok({ work: [] }),
      });
      expect(installed.ok).toBe(true);
      expect(compile.mock.calls.some(([, descriptor]) => descriptor.code === variantSource)).toBe(
        false,
      );
      libraryFence.resolve();
      expect((await renderer.initialization).ok).toBe(true);
      expect(compile.mock.calls.some(([, descriptor]) => descriptor.code === variantSource)).toBe(
        true,
      );
    } finally {
      libraryFence.resolve();
      await renderer.dispose();
    }
  });

  it('starts the background library after readiness without awaiting or failing on it', async () => {
    const inspection: PipelineLibraryInspection = {
      state: 'active',
      shaders: 0,
      renderPipelines: 0,
      computePipelines: 0,
      shaderHits: 0,
      pipelineHits: 0,
      synchronousCreations: 0,
      asynchronousCreations: 0,
      compilationCompleted: 0,
      compilationPending: 0,
      failures: 0,
      unrecordable: 0,
      overflow: 0,
      sourceBytes: 0,
      warmup: { requested: 0, completed: 0, failed: 0, elapsedMs: 0 },
      backgroundWarmup: { requested: 0, completed: 0, failed: 0, elapsedMs: 0, state: 'idle' },
    };
    const empty: PipelineLibraryManifest = {
      version: 1,
      backend: 'webgpu',
      shaders: [],
      bindGroupLayouts: [],
      pipelineLayouts: [],
      renderPipelines: [],
      computePipelines: [],
    };
    const background: PipelineLibraryManifest = {
      ...empty,
      shaders: [{ code: '// background' }],
    };
    for (const outcome of ['pending', 'failed', 'done'] as const) {
      const fence = deferred<void>();
      const prepare = vi.fn(async (manifest: PipelineLibraryManifest) => {
        if (manifest !== background) return ok(inspection);
        await fence.promise;
        if (outcome === 'done') return ok(inspection);
        return err(
          new RhiError({ code: 'rhi-descriptor-invalid', expected: 'background', hint: 'test' }),
        );
      });
      const library = {
        prepare,
        inspect: () => inspection,
        export: () => ok(empty),
      } satisfies PipelineLibrary;
      const adapter = new RhiNullAdapter();
      const device = Object.assign((await adapter.requestDevice()).unwrap(), {
        pipelineLibrary: library,
      });
      const backend = {
        ...rhi,
        requestAdapter: async () =>
          ok({
            features: adapter.features,
            limits: adapter.limits,
            requestDevice: async () => ok(device),
          }),
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const renderer = await constructRenderer(
        { width: 64, height: 64, getContext: () => null },
        { rhi: backend, pipelineLibrary: empty, backgroundPipelineLibrary: background },
        { shaderManifestUrl: renderLifecycleManifestUrl() },
      );
      try {
        // Readiness never waits for the still-pending background lane.
        expect((await renderer.initialization).ok).toBe(true);
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(prepare.mock.calls[0]?.[0]).toBe(empty);
        expect(prepare).toHaveBeenLastCalledWith(background, { background: true });
        expect(renderer.inspect().backgroundPipelineLibraryState).toBe('running');
        if (outcome === 'failed') {
          fence.resolve();
          await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
          expect(renderer.inspect().state).toBe('alive');
          expect(renderer.inspect().backgroundPipelineLibraryState).toBe('failed');
        } else if (outcome === 'done') {
          fence.resolve();
          await vi.waitFor(() =>
            expect(renderer.inspect().backgroundPipelineLibraryState).toBe('done'),
          );
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        fence.resolve();
        await renderer.dispose();
        warn.mockRestore();
      }
    }
  });

  it('does not publish renderer initialization before boot queue work settles', async () => {
    const fence = deferred<undefined>();
    const onSubmittedWorkDone = vi
      .spyOn(RhiNullQueue.prototype, 'onSubmittedWorkDone')
      .mockReturnValue(fence.promise);
    const canvas = { width: 64, height: 64, getContext: () => null };
    let renderer: Awaited<ReturnType<typeof constructRenderer>> | undefined;
    try {
      renderer = await constructRenderer(
        canvas,
        { rhi },
        { shaderManifestUrl: renderLifecycleManifestUrl() },
      );
      let settled = false;
      const initialization = renderer.initialization.then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(onSubmittedWorkDone).toHaveBeenCalled(), {
        timeout: 2_000,
      });
      expect(settled).toBe(false);
      fence.resolve(undefined);
      await initialization;
      expect(settled).toBe(true);
    } finally {
      fence.resolve(undefined);
      onSubmittedWorkDone.mockRestore();
      await renderer?.dispose();
    }
  });

  it('requires one Renderer-owned target lifecycle seam', () => {
    expect(existsSync(renderTargetHostSourcePath)).toBe(true);
    const factorySource = readFileSync(factorySourcePath, 'utf8');
    expect(factorySource.match(/createRenderTargetHost\(/g)).toHaveLength(2);
    expect(factorySource).toContain("from './render-target-host'");
    expect(factorySource).toContain('renderTargetHost.beginFrame()');
    expect(factorySource).toContain('renderTargetHost.onFrameSubmitted(completed)');
    expect(factorySource).toContain('renderTargetHost.recover()');
    expect(factorySource).toContain('renderTargetHost.dispose()');
  });

  it('keeps the public output-transform identity and closes removed tone symbols', () => {
    const source = [
      'render-contract.ts',
      'render-pipeline.ts',
      'typed-render-graph-primitives.ts',
      'assembly/factory.ts',
    ]
      .map((file) => readFileSync(resolve(import.meta.dirname, '..', file), 'utf8'))
      .join('\n');
    expect(source).toContain('STANDARD_OUTPUT_TRANSFORM_FEATURE_ID');
    expect(source).not.toContain('STANDARD_TONEMAP_FEATURE_ID');
    expect(source).not.toContain('addTypedTonemapPass');
    expect(source).not.toContain('tone-output');
  });

  it('forwards the bundler build identity into RenderSystem inspections', () => {
    const source = readFileSync(webgpuRendererSourcePath, 'utf8');
    expect(source).toContain('get build() {\n      return internals.bundler?.build;\n    },');
  });

  it('releases its profiler catalog contribution on dispose', async () => {
    const profiler = createProfiler();
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { profiler, rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    expect(profiler.phaseCatalog.render.length).toBeGreaterThan(0);
    renderer.dispose();
    expect(profiler.phaseCatalog.render).toEqual([]);
  });

  it('preserves a PipelineSpecError and its structured GPU cause during initialization', async () => {
    const original = RhiNullDevice.prototype.createRenderPipeline;
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'the GPU accepts the pre-warmed render pipeline descriptor',
      hint: 'inspect the backend gpuMessage for the rejected descriptor',
    });
    let injected = false;
    const operation = vi.spyOn(RhiNullDevice.prototype, 'createRenderPipeline');
    operation.mockImplementation(function (this: RhiNullDevice, ...args: never[]) {
      if (!injected) {
        injected = true;
        return err(failure) as never;
      }
      return Reflect.apply(original as (...input: never[]) => unknown, this, args) as never;
    } as never);

    try {
      const renderer = await constructRenderer(
        { width: 64, height: 64, getContext: () => null },
        { rhi },
        { shaderManifestUrl: renderLifecycleManifestUrl() },
      );
      const ready = await renderer.initialization;
      expect(injected).toBe(true);
      expect(ready.ok).toBe(false);
      if (ready.ok) return;
      expect(ready.error).toMatchObject({
        code: 'webgpu-runtime-error',
        detail: {
          error: {
            code: 'pipeline-build-failed',
            detail: { cause: failure },
          },
        },
      });
      await renderer.dispose();
    } finally {
      operation.mockRestore();
    }
  });

  it('keeps named temporal causes assignable without flattening their detail', () => {
    const temporal = new TemporalFrameSubmitError('queue-submit-failed');
    const cause: RhiWebgpuRuntimeCause = temporal;
    expect(cause.detail).toEqual({ reason: 'queue-submit-failed' });
  });

  it('forwards timing admission to the backend device request', async () => {
    const adapter = new RhiNullAdapter();
    const device = (await adapter.requestDevice()).unwrap();
    let requested: unknown;
    const timingRhi = {
      ...rhi,
      requestAdapter: async () =>
        ok({
          features: new Set(['timestamp-query']),
          limits: adapter.limits,
          requestDevice: async (descriptor?: unknown) => {
            requested = descriptor;
            return ok(device);
          },
        }),
    } as never;
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      {
        rhi: timingRhi,
        gpuPassTiming: { maxPassesPerFrame: 4, maxFramesInFlight: 1, retentionFrames: 2 },
      },
      { shaderManifestUrl: manifestUrl() },
    );
    expect(requested).toMatchObject({
      requiredFeatures: ['depth32float-stencil8', 'timestamp-query'],
    });
    renderer.dispose();
  });

  it('completes the receipt-bound create, attach, draw, observe, recover chain', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const lease = attached.value;
    expect(world.update().ok).toBe(true);

    const frame = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    expect(frame.ok, frame.ok ? '' : JSON.stringify(frame.error)).toBe(true);
    if (!frame.ok || frame.value === undefined) return;

    const observed = await renderer.observe(frame.value, { include: ['timings'] });
    expect(observed.ok).toBe(true);
    const recovered = await renderer.recover();
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) expect(recovered.error.code).toBe('recover-not-needed');
    renderer.dispose();
  });

  it.each([
    ['unknown', 'driver reset', 'device-lost'],
    ['unknown', 'device destroyed by the driver', 'device-lost'],
    ['destroyed', 'active device destroyed by its public owner', 'device-lost'],
  ] as const)('preserves native loss %s in an outstanding frame receipt', async (reason, message, code) => {
    const loss = deferred<{ readonly reason: 'unknown' | 'destroyed'; readonly message: string }>();
    const queued = deferred<undefined>();
    const lossSpy = vi.spyOn(RhiNullDevice.prototype, 'lost', 'get').mockReturnValue(loss.promise);
    let queueSpy: ReturnType<typeof vi.spyOn> | undefined;
    let renderer: Awaited<ReturnType<typeof constructRenderer>> | undefined;
    try {
      renderer = await constructRenderer(
        { width: 64, height: 64, getContext: () => null },
        { rhi },
        { shaderManifestUrl: manifestUrl() },
      );
      expect((await renderer.initialization).ok).toBe(true);
      queueSpy = vi
        .spyOn(RhiNullQueue.prototype, 'onSubmittedWorkDone')
        .mockReturnValue(queued.promise);
      const world = new World();
      const attached = renderer.attach(world);
      if (!attached.ok) throw attached.error;
      expect(world.update().ok).toBe(true);
      const lease = attached.value;
      const frame = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      if (!frame.ok) throw frame.error;
      if (frame.value === undefined) throw new Error('Missing frame receipt');
      loss.resolve({ reason, message });
      const completed = await frame.value.completed;
      expect(completed.ok).toBe(false);
      if (completed.ok) throw new Error('A lost-device frame must fail');
      expect(completed.error).toMatchObject({
        code: 'device-operation-failed',
        detail: {
          operation: 'complete-frame',
          cause: {
            code,
            detail: { code, detail: `device.lost: ${reason}; ${message}` },
          },
        },
      });
      expect(renderer.inspect().state).toBe('device-lost');
      expect(renderer.health()).toMatchObject({
        reason: 'device-lost',
        detail: { lostReason: reason, message },
        recoverable: true,
      });
    } finally {
      queued.resolve(undefined);
      await renderer?.dispose();
      queueSpy?.mockRestore();
      lossSpy.mockRestore();
    }
  });

  it.each([
    'unknown',
    'destroyed',
  ] as const)('ignores native %s loss after Renderer disposal', async (reason) => {
    const loss = deferred<{ readonly reason: 'unknown' | 'destroyed'; readonly message: string }>();
    const lossSpy = vi.spyOn(RhiNullDevice.prototype, 'lost', 'get').mockReturnValue(loss.promise);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let renderer: Awaited<ReturnType<typeof constructRenderer>> | undefined;
    try {
      renderer = await constructRenderer(
        { width: 64, height: 64, getContext: () => null },
        { rhi },
        { shaderManifestUrl: manifestUrl() },
      );
      expect((await renderer.initialization).ok).toBe(true);
      expect((await renderer.dispose()).ok).toBe(true);
      const retiredHealth = renderer.health();
      consoleError.mockClear();
      loss.resolve({ reason, message: 'device retired after Renderer disposal' });
      await Promise.resolve();
      await Promise.resolve();
      expect(renderer.inspect().state).toBe('disposed');
      expect(renderer.health()).toEqual(retiredHealth);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await renderer?.dispose();
      consoleError.mockRestore();
      lossSpy.mockRestore();
    }
  });

  it('rejects the removed Standard reflection-probe profile field at the Renderer boundary', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const staleProfile = {
      ...DEFAULT_STANDARD_PROFILE,
      reflectionProbes: false,
    } as unknown as Parameters<typeof renderer.setProfile>[0];
    const result = renderer.setProfile(staleProfile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('frame-input-invalid');
    renderer.dispose();
  });

  it('accepts a volumetric fog budget through setProfile and snapshots the caller config', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const volumetricFog = { quality: 'low' as const, depth: 48 as const, tileSize: 16 as 4 | 16 };
    try {
      expect(renderer.setProfile({ ...DEFAULT_STANDARD_PROFILE, volumetricFog }).ok).toBe(true);
      volumetricFog.tileSize = 4;
      expect(renderer.inspect().profile.volumetricFog).toEqual({
        quality: 'low',
        depth: 48,
        tileSize: 16,
      });
      const rejected = renderer.setProfile({
        ...DEFAULT_STANDARD_PROFILE,
        volumetricFog: {
          quality: 'low',
          depth: 0,
          tileSize: 16,
        },
      } as unknown as Parameters<typeof renderer.setProfile>[0]);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe('frame-input-invalid');
      expect(renderer.inspect().profile.volumetricFog?.depth).toBe(48);
    } finally {
      await renderer.dispose();
    }
  });

  it('accepts GPU occlusion changes through the public Renderer profile', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    try {
      for (const gpuOcclusion of [false, true]) {
        expect(renderer.setProfile({ ...DEFAULT_STANDARD_PROFILE, gpuOcclusion }).ok).toBe(true);
        expect(renderer.inspect().profile.gpuOcclusion).toBe(gpuOcclusion);
      }
    } finally {
      renderer.dispose();
    }
  });

  it('projects stable output and observation identity without pixel payloads', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const inspection = renderer.inspect() as unknown as Record<string, unknown>;
    expect(inspection).toMatchObject({
      // Before the first draw there is no committed graph from which to
      // claim an output transform or an intermediate target.  Inspection is
      // intentionally conservative instead of projecting profile defaults.
      output: {
        displayEncoded: false,
        surfaceStorage: expect.any(String),
        surfaceDisplay: expect.any(String),
        endpoint: 'surface.storage.raw',
        capability: 'unavailable',
      },
      observation: {
        observationId: expect.any(String),
        frameId: expect.any(Number),
      },
    });
    expect(inspection).not.toHaveProperty('outputTransform');
    expect(inspection).not.toHaveProperty('intermediateFormat');
    expect(inspection).not.toHaveProperty('pixelPayload');
    renderer.dispose();
  });

  it('delivers a target readback only through its matching receipt', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const target = renderer.createRenderTarget({
      shape: '2d',
      width: 17,
      height: 9,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: false,
      readback: true,
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const ticket = renderer.requestTargetReadback(target.value, { mipLevel: 0 });
    expect(ticket.ok).toBe(true);
    if (!ticket.ok) return;
    const world = new World();
    registerPropagateTransforms(world);
    for (const output of [undefined, target.value]) {
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          {
            component: LocalCamera,
            data: {
              fov: 1,
              aspect: 1,
              near: 0.1,
              far: 100,
              ...(output === undefined
                ? {}
                : { target: world.allocSharedRef('RenderTarget', output) }),
            },
          },
        )
        .unwrap();
    }
    world.update().unwrap();
    const copies = vi.spyOn(RhiNullCommandEncoder.prototype, 'copyTextureToBuffer');
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const request = {
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    };
    const initializationFrame = renderer.draw(request);
    if (!initializationFrame.ok) throw initializationFrame.error;
    if (initializationFrame.value === undefined) throw new Error('Missing initialization receipt');
    const premature = await renderer.observe(initializationFrame.value, {
      include: ['target-readbacks'],
      targetReadbacks: [ticket.value],
    });
    expect(copies).not.toHaveBeenCalled();
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.error.code).toBe('render-target-state-invalid');
    const submission = vi.spyOn(RhiNullQueue.prototype, 'submit').mockReturnValueOnce(
      err(
        new RhiError({
          code: 'internal-error',
          expected: 'injected rejected target readback submission',
          hint: 'retry the frame',
        }),
      ),
    );
    expect(renderer.draw(request).ok).toBe(false);
    expect(copies).toHaveBeenCalledTimes(1);
    submission.mockRestore();
    const frame = renderer.draw(request);
    expect(frame.ok, frame.ok ? '' : JSON.stringify(frame.error)).toBe(true);
    if (!frame.ok || frame.value === undefined) return;
    const stale = await renderer.observe(initializationFrame.value, {
      include: ['target-readbacks'],
      targetReadbacks: [ticket.value],
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('render-target-state-invalid');
    const observed = await renderer.observe(frame.value, {
      include: ['target-readbacks'],
      targetReadbacks: [ticket.value],
    });
    expect(observed.ok, observed.ok ? '' : JSON.stringify(observed.error)).toBe(true);
    expect(copies).toHaveBeenCalledTimes(2);
    if (!observed.ok) return;
    expect(observed.value.targetReadbacks?.[0]).toMatchObject({
      frameId: frame.value.frameId,
      deviceGeneration: frame.value.deviceGeneration,
      bytesPerRow: 256,
      byteLength: 256 * 9,
    });
    const repeated = await renderer.observe(frame.value, {
      include: ['target-readbacks'],
      targetReadbacks: [ticket.value],
    });
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.code).toBe('render-target-state-invalid');
    copies.mockRestore();
    renderer.dispose();
  });

  it('does not promote a graph feature without a fullscreen effect into post-effects', async () => {
    let planCalls = 0;
    const feature = {
      identity: 'synthetic.graph-only',
      extract: () => ok(undefined),
      plan: (_data: unknown, context: RenderFeaturePlanContext) => {
        planCalls += 1;
        return ok({
          work: context.views
            .filter((view) => view.render)
            .map<RenderFeatureWork>((view) => ({
              scope: { view: view.identity },
              resources: [],
              passes: [],
            })),
        });
      },
    };
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi, features: [feature] },
      { shaderManifestUrl: manifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);
    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok, frame.ok ? '' : JSON.stringify(frame.error)).toBe(true);
    expect(planCalls).toBe(1);
    renderer.dispose();
  });

  it('projects the active barrel stage through the ordinary feature host once', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            tonemap: TONEMAP_ACES_FILMIC,
            bloom: BLOOM_DISABLED,
          },
        },
        { component: BarrelDistortion, data: { strength: 0.2, centerX: 0.5, centerY: 0.5 } },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok, frame.ok ? '' : JSON.stringify(frame.error)).toBe(true);
    if (frame.ok && frame.value !== undefined) {
      expect(frame.value.barrelDistortion).toMatchObject({
        width: 64,
        height: 64,
        camera: { projection: 'perspective' },
      });
      expect(frame.value.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(
        renderer.perFramePassNames.filter((name) => name === 'barrel-distortion'),
      ).toHaveLength(1);
      expect(
        renderer.perFramePassNames.filter((name) => name.startsWith('post-effect-')),
      ).toHaveLength(0);
    }
    await renderer.dispose();
  });

  it('keeps the active graph as LKG while a feature candidate is pending', async () => {
    let invalid = false;
    let featurePlanCalls = 0;
    const featureErrors: string[] = [];
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.candidate-lkg',
      shaderModuleMode: 'immediate',
      extract: () => ok(undefined),
      plan: (_data: unknown, context: RenderFeaturePlanContext) => {
        featurePlanCalls += 1;
        if (!invalid)
          return ok({
            work: context.views
              .filter((view) => view.render)
              .map<RenderFeatureWork>((view) => ({
                scope: { view: view.identity },
                resources: [],
                passes: [],
              })),
          });
        return ok({
          work: context.views
            .filter((view) => view.render)
            .map<RenderFeatureWork>((view) => ({
              scope: { view: view.identity },
              resources: [
                {
                  kind: 'compute-program' as const,
                  name: 'candidate.program',
                  program: {
                    wgsl: '@compute @workgroup_size(1) fn main() {}',
                    entryPoints: ['main'],
                    bindings: [
                      {
                        entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
                      },
                    ],
                  },
                },
                {
                  kind: 'buffer' as const,
                  name: 'candidate.buffer',
                  size: 4,
                  usage: ['storage' as const],
                  data: new Uint32Array([0]),
                },
                {
                  kind: 'compute-bindings' as const,
                  name: 'candidate.bindings',
                  program: 'candidate.program',
                  entries: [{ binding: 0, resource: 'candidate.buffer' }],
                },
              ],
              passes: [
                {
                  kind: 'compute',
                  name: 'forward',
                  program: 'candidate.program',
                  bindings: 'candidate.bindings',
                  dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
                },
              ],
            })),
        });
      },
    };
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi, features: [feature] },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const unsubscribe = renderer.onError((error) => featureErrors.push(error.code));
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        {
          component: LocalCamera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            tonemap: TONEMAP_ACES_FILMIC,
            bloom: BLOOM_DISABLED,
          },
        },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    const initialDraw = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(initialDraw.ok).toBe(true);
    invalid = true;
    const candidateDraw = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(candidateDraw.ok).toBe(true);
    await Promise.resolve();
    const pendingDraw = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(pendingDraw.ok).toBe(true);
    const lastKnownGoodPasses = [...renderer.perFramePassNames];
    expect(lastKnownGoodPasses.length).toBeGreaterThan(0);
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(true);
    expect(featurePlanCalls).toBeGreaterThan(1);
    expect(featureErrors).toEqual([]);
    expect(renderer.inspect().featureDiagnostics[0]).toMatchObject({ status: 'active' });
    expect(renderer.perFramePassNames).toEqual(lastKnownGoodPasses);
    unsubscribe();
    renderer.dispose();
  });

  it('records a no-storage directional-shadow frame without Cluster resources', async () => {
    const nullAdapter = new RhiNullAdapter();
    const noStorageRhi = {
      ...rhi,
      requestAdapter: async () => {
        const created = await nullAdapter.requestDevice();
        if (!created.ok) return created;
        const baseDevice = created.value;
        const device = new Proxy(baseDevice, {
          get(target, property, receiver) {
            if (property === 'caps') return { ...target.caps, storageBuffer: false };
            return Reflect.get(target, property, receiver);
          },
        });
        return ok({
          features: nullAdapter.features,
          limits: nullAdapter.limits,
          requestDevice: async () => ok(device),
        });
      },
    };
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi: noStorageRhi as never },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const errors: string[] = [];
    const errorDetails: unknown[] = [];
    const unsubscribe = renderer.onError((error) => {
      errors.push(error.code);
      errorDetails.push(error);
    });
    const assets = new AssetRegistry();
    const cube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    const world = new World({ assets });
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      {
        component: LocalCamera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_ACES_FILMIC,
          bloom: BLOOM_DISABLED,
        },
      },
    );
    world.spawn({
      component: DirectionalLight,
      data: {
        castShadow: true,
        direction: [0, -1, 0],
        color: [1, 1, 1],
        intensity: 1,
        cascadeCount: 1,
        mapSize: 64,
      },
    });
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: {} },
    );
    expect(world.update().ok).toBe(true);
    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok, JSON.stringify(errorDetails)).toBe(true);
    expect(renderer.inspect().standardLighting).toMatchObject({
      producer: 'none',
      requested: 0,
      admitted: 0,
    });
    expect(renderer.perFramePassNames).not.toContain('cluster-membership-producer');
    expect(errors).toEqual([]);

    // The no-storage topology is valid only while the scene has no local
    // lights. A Point/Spot admission must fail before graph/encoder work and
    // retain the last successful pass list rather than silently submitting a
    // direct-light fallback with an incompatible ABI.
    const lastSuccessfulPasses = [...renderer.perFramePassNames];
    const localLight = world.spawn(
      { component: Transform, data: { pos: [0, 0, 1] } },
      { component: PointLight, data: { intensity: 8, range: 10 } },
    );
    expect(localLight.ok).toBe(true);
    const spotLight = world.spawn(
      { component: Transform, data: { pos: [1, 0, 1] } },
      {
        component: SpotLight,
        data: { castShadow: true, direction: [0, -1, 0], intensity: 8, range: 10 },
      },
    );
    expect(spotLight.ok).toBe(true);
    expect(world.update().ok).toBe(true);
    const rejected = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(rejected.ok).toBe(false);
    expect(errors).toContain('standard-cluster-transport-unavailable');
    expect(renderer.perFramePassNames).toEqual(lastSuccessfulPasses);
    unsubscribe();
    await renderer.dispose();
  });

  it('attaches derived-state systems once without putting writes in draw', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const world = new World();

    expect(renderer.attach(world).ok).toBe(true);
    expect(renderer.attach(world).ok).toBe(true);
    expect(world.inspect().schedules.flatMap((schedule) => schedule.systems)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'renderDerivedEntities' })]),
    );
    renderer.dispose();
  });

  it('releases one World without disposing the shared Renderer', async () => {
    const first = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const second = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifestUrl() },
    );
    const world = new World();

    expect(first.attach(world).ok).toBe(true);
    first.detachScene(world);
    first.detachScene(world);
    expect(second.attach(world).ok).toBe(true);
    second.dispose();
    first.dispose();
  });

  it('resolves a renderer for a host canvas and rejects missing input', async () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;
    await expect(
      constructRenderer(
        { width: 64, height: 64, getContext: () => null },
        { rhi },
        { shaderManifestUrl: manifest },
      ),
    ).resolves.toMatchObject({
      attach: expect.any(Function),
      draw: expect.any(Function),
    });
    await expect(constructRenderer(undefined, { rhi })).rejects.toBeInstanceOf(Error);
  });

  it('temporarily releases presentation while preserving the Renderer identity', async () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: manifest },
    );
    expect((await renderer.initialization).ok).toBe(true);
    expect(renderer.releaseSurface().ok).toBe(true);
    expect(renderer.releaseSurface().ok).toBe(true);
    expect(renderer.draw([], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(false);
    expect(renderer.restoreSurface().ok).toBe(true);
    expect(renderer.restoreSurface().ok).toBe(true);
    expect(renderer.draw([], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
  });

  it('does not unconfigure a surface after its ownership was released', async () => {
    let unconfigureCalls = 0;
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      {
        rhi: {
          ...rhi,
          acquireCanvasContext: () => ({
            ok: true as const,
            value: {
              configure: () => ({ ok: true as const, value: undefined }),
              unconfigure: () => {
                unconfigureCalls += 1;
              },
              getConfiguration: () => undefined,
              getCurrentTexture: () => ({
                ok: true as const,
                value: { __brand: 'TextureView' },
              }),
            },
          }),
        },
      } as never,
      { shaderManifestUrl: manifestUrl() },
    );

    expect(renderer.releaseSurface().ok).toBe(true);
    expect(unconfigureCalls).toBe(1);
    renderer.dispose();
    expect(unconfigureCalls).toBe(1);
  });

  it('keeps direct RHI instrumentation explicit-only at the factory boundary', async () => {
    const drawOneFrame = (renderer: Awaited<ReturnType<typeof constructRenderer>>) => {
      const world = new World();
      const attached = renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      expect(world.update().ok).toBe(true);
      const frame = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(frame.ok, frame.ok ? '' : JSON.stringify(frame.error)).toBe(true);
    };
    const moduleBoundary = vi.fn();
    const implicit = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      {
        rhi: {
          ...rhi,
          instrumentation: { onFrameBoundary: moduleBoundary },
        } as never,
      },
      { shaderManifestUrl: manifestUrl() },
    );
    expect((await implicit.initialization).ok).toBe(true);
    drawOneFrame(implicit);
    expect(moduleBoundary).not.toHaveBeenCalled();
    expect((await implicit.dispose()).ok).toBe(true);

    const explicitBoundary = vi.fn();
    const explicit = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      {
        rhi: {
          ...rhi,
          instrumentation: { onFrameBoundary: moduleBoundary },
        } as never,
        rhiInstrumentation: { onFrameBoundary: explicitBoundary },
      },
      { shaderManifestUrl: manifestUrl() },
    );
    expect((await explicit.initialization).ok).toBe(true);
    drawOneFrame(explicit);
    expect(explicitBoundary).toHaveBeenCalled();
    expect(moduleBoundary).not.toHaveBeenCalled();
    expect((await explicit.dispose()).ok).toBe(true);
  });

  it('retains the device-owned prewarmed TAA shader across off and on', async () => {
    const pending: Array<{
      readonly label: string;
      readonly promise: Promise<ReturnType<typeof ok<ShaderModule>>>;
      readonly resolve: (value: ReturnType<typeof ok<ShaderModule>>) => void;
    }> = [];
    const moduleSources: string[] = [];
    const frameBoundary = vi.fn();
    const backend: RhiBackendPack = {
      rhi,
      instrumentation: { onFrameBoundary: frameBoundary },
      createShaderModule: (_device, desc) => {
        const label = desc.label ?? '<unlabeled>';
        moduleSources.push(desc.code);
        if (!desc.code.includes('fs_taa_resolve')) {
          return Promise.resolve(ok({} as ShaderModule));
        }
        let resolve!: (value: ReturnType<typeof ok<ShaderModule>>) => void;
        const promise = new Promise<ReturnType<typeof ok<ShaderModule>>>((complete) => {
          resolve = complete;
        });
        pending.push({ label, promise, resolve });
        return promise;
      },
    };
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      undefined,
      { shaderManifestUrl: renderLifecycleManifestUrl() },
      backend,
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const initialization = renderer.initialization;
    pending[0]?.resolve(ok({} as ShaderModule));
    expect((await initialization).ok).toBe(true);

    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_TAA,
          },
        },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    expect([...world.query({ read: [LocalCamera], with: [Transform] }).unwrap()]).toHaveLength(1);
    const frameInput = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });

    const first = renderer.draw(frameInput());
    expect(first.ok, first.ok ? '' : JSON.stringify(first.error)).toBe(true);
    expect(frameBoundary).toHaveBeenCalled();
    expect(pending).toHaveLength(1);

    world.set(camera, LocalCamera, { antialias: ANTIALIAS_NONE }).unwrap();
    expect(world.update().ok).toBe(true);
    const off = renderer.draw(frameInput());
    expect(off.ok).toBe(true);

    expect(moduleSources.filter((source) => source.includes('fs_taa_resolve'))).toHaveLength(1);

    world.set(camera, LocalCamera, { antialias: ANTIALIAS_TAA }).unwrap();
    expect(world.update().ok).toBe(true);
    const second = renderer.draw(frameInput());
    expect(second.ok, second.ok ? '' : JSON.stringify(second.error)).toBe(true);
    expect(pending).toHaveLength(1);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    world.set(camera, LocalCamera, { antialias: ANTIALIAS_NONE }).unwrap();
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    world.set(camera, LocalCamera, { antialias: ANTIALIAS_TAA }).unwrap();
    expect(world.update().ok).toBe(true);
    const replacement = renderer.draw(frameInput());
    expect(replacement.ok).toBe(true);
    expect(pending).toHaveLength(1);

    expect((await renderer.dispose()).ok).toBe(true);
    expect((await renderer.dispose()).ok).toBe(true);
    expect(moduleSources.filter((source) => source.includes('fs_taa_resolve'))).toHaveLength(1);
  });

  it('rebuilds a TAA graph for a same-mode target resize', async () => {
    const moduleSources: string[] = [];
    const created = new Map<object, string>();
    const destroyed = new Set<object>();
    let wrappedDevice: object | undefined;
    const trackDevice = (device: object): object =>
      new Proxy(device, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return Reflect.get(target, property, receiver);
          return (...args: unknown[]) => {
            const label =
              typeof args[0] === 'object' && args[0] !== null && 'label' in args[0]
                ? String((args[0] as { label?: unknown }).label ?? '')
                : '';
            const result = value.apply(target, args);
            if (property === 'createTexture' && result?.ok && typeof result.value === 'object') {
              created.set(result.value, label);
            }
            if (property === 'destroyTexture') {
              const handle = args[0];
              if (typeof handle === 'object' && handle !== null) destroyed.add(handle);
            }
            return result;
          };
        },
      });
    const adapter = new RhiNullAdapter();
    const instrumentedRhi = {
      ...rhi,
      requestAdapter: async () => {
        const deviceResult = await adapter.requestDevice();
        if (!deviceResult.ok) return deviceResult;
        wrappedDevice = trackDevice(deviceResult.value);
        return ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => ok(wrappedDevice as never),
        });
      },
    } as never;
    const backend: RhiBackendPack = {
      rhi: instrumentedRhi,
      createShaderModule: async (_device, desc) => {
        moduleSources.push(desc.code);
        return ok({} as ShaderModule);
      },
    };
    const canvas = { width: 64, height: 64, getContext: () => null };
    const renderer = await constructRenderer(
      canvas,
      undefined,
      { shaderManifestUrl: renderLifecycleManifestUrl() },
      backend,
    );
    expect((await renderer.initialization).ok).toBe(true);
    expect(wrappedDevice).toBeDefined();

    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_TAA },
        },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    const frameInput = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    let first = renderer.draw(frameInput());
    if (!first.ok) {
      await Promise.resolve();
      first = renderer.draw(frameInput());
    }
    expect(first.ok, first.ok ? '' : JSON.stringify(first.error)).toBe(true);
    const firstGeneration = [...created.entries()]
      .filter(([_, label]) => label.startsWith('taa-history-'))
      .slice(-4);
    expect(firstGeneration).toHaveLength(4);
    expect(moduleSources.filter((source) => source.includes('fs_taa_resolve'))).toHaveLength(1);
    const firstFrame = renderer.inspect().frame.frameId;

    canvas.width = 96;
    canvas.height = 80;
    expect(world.update().ok).toBe(true);
    const replacement = renderer.draw(frameInput());
    expect(replacement.ok).toBe(true);
    if (replacement.ok) expect(replacement.value).toMatchObject({ frameId: firstFrame + 1 });
    const replacementGeneration = [...created.entries()]
      .filter(([_, label]) => label.startsWith('taa-history-'))
      .slice(-4);
    expect(replacementGeneration).toHaveLength(4);
    expect(replacementGeneration.map(([handle]) => handle)).not.toEqual(
      firstGeneration.map(([handle]) => handle),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(firstGeneration.every(([handle]) => destroyed.has(handle))).toBe(true);
    expect(replacementGeneration.every(([handle]) => !destroyed.has(handle))).toBe(true);
    expect(renderer.inspect().frame.frameId).toBe(firstFrame + 1);
    expect(renderer.inspect().state).toBe('alive');
    expect(moduleSources.filter((source) => source.includes('fs_taa_resolve'))).toHaveLength(1);
    world.set(camera, LocalCamera, { antialias: ANTIALIAS_NONE }).unwrap();
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(replacementGeneration.every(([handle]) => destroyed.has(handle))).toBe(true);
    expect((await renderer.dispose()).ok).toBe(true);
  });

  it('rebuilds the TAA graph when DynamicResolution is removed', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_TAA },
        },
        {
          component: DynamicResolution,
          data: { targetGpuMs: 16.67, minScale: 0.5, maxScale: 0.5 },
        },
      )
      .unwrap();
    const frameInput = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    const dynamicInspection = renderer.inspect();
    expect(dynamicInspection.perFramePassNames).toContain('standard-scene-coverage');
    expect(dynamicInspection.temporalTarget).toMatchObject({
      descriptor: { width: 32, height: 32 },
    });
    const dynamicGeneration = dynamicInspection.recoveryEvidence.graph.generation;

    expect(world.removeComponent(camera, DynamicResolution).ok).toBe(true);
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    const surfaceInspection = renderer.inspect();
    expect(surfaceInspection.perFramePassNames).not.toContain('standard-scene-coverage');
    expect(surfaceInspection.temporalTarget).toMatchObject({
      descriptor: { width: 64, height: 64 },
    });
    expect(surfaceInspection.recoveryEvidence.graph.generation).toBeGreaterThan(dynamicGeneration);
    await renderer.dispose();
  });

  it('restores the surface graph after toggling DynamicResolution on and off', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_TAA },
        },
      )
      .unwrap();
    const frameInput = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    expect(renderer.inspect().perFramePassNames).not.toContain('standard-scene-coverage');

    expect(
      world.addComponent(camera, {
        component: DynamicResolution,
        data: { targetGpuMs: 16.67, minScale: 0.5, maxScale: 0.5 },
      }).ok,
    ).toBe(true);
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    const dynamic = renderer.inspect();
    expect(dynamic.perFramePassNames).toContain('standard-scene-coverage');
    expect(dynamic.temporalTarget).toMatchObject({ descriptor: { width: 32, height: 32 } });

    expect(world.removeComponent(camera, DynamicResolution).ok).toBe(true);
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    const surface = renderer.inspect();
    expect(surface.perFramePassNames).not.toContain('standard-scene-coverage');
    expect(surface.temporalTarget).toMatchObject({ descriptor: { width: 64, height: 64 } });
    await renderer.dispose();
  });

  it('rebuilds the TAA graph when MotionBlur is added', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_TAA },
        },
      )
      .unwrap();
    const frameInput = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    expect(renderer.inspect().perFramePassNames).not.toContain('motion-blur');

    expect(
      world.addComponent(camera, {
        component: MotionBlur,
        data: { shutterAngle: 180, maxRadiusPixels: 8, sampleCount: 4 },
      }).ok,
    ).toBe(true);
    expect(world.update().ok).toBe(true);
    const motionDraw = renderer.draw(frameInput());
    if (!motionDraw.ok) {
      throw new Error(JSON.stringify({ error: motionDraw.error, events: errors }));
    }
    const inspection = renderer.inspect();
    expect(inspection.perFramePassNames).toContain('motion-blur');
    // The same Rhi device/frame admitted the compute plan, graph, and both
    // production dispatches. This is the application-side admission proof;
    // Dawn/physical timing remains a separate backend gate.
    expect(inspection.capabilities).toMatchObject({
      compute: true,
      storageBuffer: true,
      storageTexture: true,
      rgba16floatRenderable: true,
    });
    expect(inspection.motionBlur).toMatchObject({ lane: 'compute', passCount: 2 });
    expect(inspection.perFramePassNames).toContain('motion-blur');
    expect(inspection.recoveryEvidence.graph).toMatchObject({ ready: true });
    expect(inspection.featureGraph?.compileSuccesses ?? 0).toBeGreaterThan(0);
    // The graph is present, but this is the first accepted temporal pair
    // after the effect was added. Inspection must expose the reset boundary
    // until a subsequent successful pair can provide a valid baseline.
    expect(inspection.motionBlur).toMatchObject({
      enabled: true,
      status: 'reset',
      temporalDemand: 'scene-data-temporal-v1',
    });
    await renderer.dispose();
  });

  it('projects generic post work once and keeps Motion Blur independent across Standard lanes', async () => {
    for (const renderPath of ['forward', 'deferred'] as const) {
      for (const taa of [false, true]) {
        const renderer = await constructRenderer(
          { width: 64, height: 64, getContext: () => null },
          { rhi, features: [createGenericPostProbeFeature()] },
          { shaderManifestUrl: renderLifecycleManifestUrl() },
        );
        const errors: unknown[] = [];
        renderer.onError((error) => errors.push(error));
        try {
          expect((await renderer.initialization).ok).toBe(true);
          expect(renderer.setProfile({ ...DEFAULT_STANDARD_PROFILE, renderPath }).ok).toBe(true);
          const world = new World();
          const attached = renderer.attach(world);
          expect(attached.ok).toBe(true);
          if (!attached.ok) continue;
          registerPropagateTransforms(world);
          const camera = world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 4] } },
              {
                component: LocalCamera,
                data: {
                  fov: 1,
                  aspect: 1,
                  near: 0.1,
                  far: 100,
                  antialias: taa ? ANTIALIAS_TAA : ANTIALIAS_NONE,
                  tonemap: TONEMAP_ACES_FILMIC,
                },
              },
            )
            .unwrap();
          world
            .addComponent(camera, {
              component: MotionBlur,
              data: { shutterAngle: 180, maxRadiusPixels: 8, sampleCount: 4, targetFps: 60 },
            })
            .unwrap();
          expect(world.update().ok).toBe(true);
          const draw = renderer.draw({
            leases: [attached.value],
            camera: { lease: attached.value },
            environment: { lease: attached.value },
          });
          expect(
            draw.ok,
            JSON.stringify({ error: draw.ok ? undefined : draw.error, events: errors }),
          ).toBe(true);
          if (!draw.ok || draw.value === undefined) continue;
          const completed = await draw.value.completed;
          expect(completed.ok).toBe(true);
          if (!completed.ok) continue;
          const inspection = renderer.inspect();
          const names = inspection.perFramePassNames;
          const genericIndex = names.indexOf('generic-post-probe');
          const motionSummaryIndex = names.indexOf('motion-blur-tile-summary');
          const motionIndex = names.indexOf('motion-blur');
          const outputIndex = names.indexOf('output-transform');
          expect(names.filter((name) => name === 'generic-post-probe')).toHaveLength(1);
          expect(names.filter((name) => name === 'motion-blur-tile-summary')).toHaveLength(1);
          expect(names.filter((name) => name === 'motion-blur')).toHaveLength(1);
          expect(genericIndex).toBeGreaterThanOrEqual(0);
          expect(motionSummaryIndex).toBeGreaterThanOrEqual(0);
          expect(motionIndex).toBeGreaterThan(motionSummaryIndex);
          expect(outputIndex).toBeGreaterThan(motionIndex);
          if (taa) expect(names.indexOf('taa-resolve')).toBeLessThan(motionSummaryIndex);
          else expect(names).not.toContain('taa-resolve');
          expect(inspection.motionBlur).toMatchObject({
            enabled: true,
            passCount: 2,
            execution: { passes: [{ name: 'motion-blur-tile-summary' }, { name: 'motion-blur' }] },
          });
          // A completed two-pass execution is the public Renderer proof that
          // the named motion-blurred-color target had a writer and was then
          // consumed by the shared output chain.
          expect(inspection.featureGraph?.compileSuccesses ?? 0).toBeGreaterThan(0);
        } finally {
          await renderer.dispose();
        }
      }
    }
  });

  it('publishes invalid MotionBlur parameters through renderer inspection', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_TAA },
        },
        { component: MotionBlur, data: { targetFps: 59.5 } },
      )
      .unwrap();
    const frameInput = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(world.update().ok).toBe(true);

    const draw = renderer.draw(frameInput());
    expect(draw.ok).toBe(false);
    if (!draw.ok) {
      expect(draw.error).toMatchObject({
        code: 'motion-blur-invalid-params',
        detail: { field: 'targetFps', value: 59.5, integer: true },
      });
    }
    expect(errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'motion-blur-invalid-params' })]),
    );
    expect(renderer.inspect().motionBlur).toMatchObject({
      enabled: true,
      status: 'invalid',
      lastFailure: 'invalid-params',
      temporalDemand: 'scene-data-temporal-v1',
    });
    await renderer.dispose();
    void camera;
  });

  it('projects a rejected Motion Blur submit while retaining its accepted baseline', async () => {
    const scenario = await createMotionBlurScenario();
    const submit = vi.spyOn(RhiNullQueue.prototype, 'submit');
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'Motion Blur queue submission succeeds',
      hint: 'repair the queue and retry the same frame',
    });
    try {
      expect(scenario.draw().ok).toBe(true);
      expect(scenario.draw().ok).toBe(true);
      const accepted = scenario.renderer.inspect().motionBlur;
      expect(accepted).toMatchObject({ enabled: true });
      expect(accepted).not.toHaveProperty('lastFailure');
      submit.mockReturnValueOnce(err(failure));
      expect(scenario.draw().ok).toBe(false);
      expect(scenario.renderer.inspect().motionBlur).toMatchObject({
        enabled: true,
        lastFailure: 'submit-failure',
      });
      submit.mockRestore();
      expect(scenario.draw().ok).toBe(true);
      expect(scenario.renderer.inspect().motionBlur?.lastFailure).toBeUndefined();
    } finally {
      submit.mockRestore();
      await scenario.dispose();
    }
  });

  it('retires factory-owned TAA textures and params on an off submit', async () => {
    const created = new Map<object, string>();
    const destroyed = new Set<object>();
    let wrappedDevice: object | undefined;
    const trackDevice = (device: object): object =>
      new Proxy(device, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return Reflect.get(target, property, receiver);
          return (...args: unknown[]) => {
            const label =
              typeof args[0] === 'object' && args[0] !== null && 'label' in args[0]
                ? String((args[0] as { label?: unknown }).label ?? '')
                : '';
            const result = value.apply(target, args);
            if (property === 'createTexture' || property === 'createBuffer') {
              if (result?.ok && typeof result.value === 'object' && result.value !== null) {
                created.set(result.value, label);
              }
            }
            if (property === 'destroyTexture' || property === 'destroyBuffer') {
              const handle = args[0];
              if (typeof handle === 'object' && handle !== null) destroyed.add(handle);
            }
            return result;
          };
        },
      });
    const adapter = new RhiNullAdapter();
    const instrumentedRhi = {
      ...rhi,
      requestAdapter: async () => {
        const deviceResult = await adapter.requestDevice();
        if (!deviceResult.ok) return deviceResult;
        wrappedDevice = trackDevice(deviceResult.value);
        return ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => ok(wrappedDevice as never),
        });
      },
    } as never;
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi: instrumentedRhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    expect(wrappedDevice).toBeDefined();
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_TAA },
        },
      )
      .unwrap();
    const frameInput = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(world.update().ok).toBe(true);
    let first = renderer.draw(frameInput());
    if (!first.ok) {
      await Promise.resolve();
      first = renderer.draw(frameInput());
    }
    expect(first.ok, first.ok ? '' : JSON.stringify(first.error)).toBe(true);
    const historyHandles = [...created.entries()].filter(([_, label]) =>
      label.startsWith('taa-history-'),
    );
    expect(historyHandles.length).toBeGreaterThanOrEqual(4);
    expect([...created.values()]).toContain('taa-resolve-params');

    world.set(camera, LocalCamera, { antialias: ANTIALIAS_NONE }).unwrap();
    expect(world.update().ok).toBe(true);
    expect(renderer.draw(frameInput()).ok).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(renderer.inspect().perFramePassNames).not.toContain('taa-resolve');
    expect(historyHandles.every(([handle]) => destroyed.has(handle))).toBe(true);
    const params = [...created.entries()].filter(([, label]) => label === 'taa-resolve-params');
    expect(params.length).toBeGreaterThan(0);
    expect(params.every(([handle]) => destroyed.has(handle))).toBe(true);
    expect((await renderer.dispose()).ok).toBe(true);
    expect((await renderer.dispose()).ok).toBe(true);
    expect(destroyed.size).toBeGreaterThanOrEqual(historyHandles.length + 1);
  });

  it('projects Bloom lifecycle through the factory-created per-pass owner', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            tonemap: TONEMAP_ACES_FILMIC,
            bloom: BLOOM_ENABLED,
          },
        },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    expect(renderer.inspect().bloom.state).toBe('off');
    const on = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(on.ok).toBe(true);
    const onInspection = renderer.inspect().bloom;
    expect(onInspection.state).toBe('active');
    expect(onInspection.graphStatus).toBe('valid');
    expect(onInspection.targetCount).toBe(11);
    expect(onInspection.targetBytes).toBe(54_592);
    expect(onInspection.passCount).toBe(11);
    expect(onInspection.uploadCount).toBe(11);
    expect(onInspection.bindGroupCount).toBe(11);
    expect(onInspection.encodeCount).toBe(11);
    expect(JSON.parse(JSON.stringify(onInspection))).toEqual(onInspection);
    const firstGeneration = onInspection.generation;
    expect(firstGeneration).toBeGreaterThan(0);

    world.set(camera, LocalCamera, { bloom: BLOOM_DISABLED }).unwrap();
    expect(world.update().ok).toBe(true);
    const off = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(off.ok).toBe(true);
    const offInspection = renderer.inspect().bloom;
    expect(['retiring', 'off']).toContain(offInspection.state);
    expect(offInspection.resourceCount).toBeGreaterThan(0);
    expect(offInspection.passCount).toBe(0);
    const retiringGeneration = offInspection.generation;
    expect(retiringGeneration).toBe(firstGeneration);
    world.set(camera, LocalCamera, { bloom: BLOOM_ENABLED }).unwrap();
    expect(world.update().ok).toBe(true);
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(true);
    const recoveredInspection = renderer.inspect().bloom;
    expect(recoveredInspection.state).toBe('active');
    expect(recoveredInspection.resourceCount).toBeGreaterThan(0);
    expect(recoveredInspection.passCount).toBe(11);
    expect(recoveredInspection.uploadCount).toBe(11);
    expect(recoveredInspection.bindGroupCount).toBe(11);
    expect(recoveredInspection.encodeCount).toBe(11);
    expect(recoveredInspection.generation).toBeGreaterThan(firstGeneration);
    await Promise.resolve();
    await Promise.resolve();
    expect(renderer.inspect().bloom.state).toBe('active');
    expect((await renderer.dispose()).ok).toBe(true);
    expect(renderer.inspect().bloom.state).toBe('off');
    expect((await renderer.dispose()).ok).toBe(true);
  });

  it.each([
    TONEMAP_NONE,
    TONEMAP_ACES_FILMIC,
  ] as const)('publishes Bloom receipts only after submit with tonemap %s', async (tonemap) => {
    const scenario = await createBloomScenario(tonemap);
    const submit = vi.spyOn(RhiNullQueue.prototype, 'submit');
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'Bloom queue submission succeeds',
      hint: 'repair the queue and retry the frame',
    });
    try {
      expect(scenario.draw().ok).toBe(true);
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        uploadCount: 11,
        bindGroupCount: 11,
        encodeCount: 11,
      });

      submit.mockReturnValueOnce(err(failure));
      expect(scenario.draw().ok).toBe(false);
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        state: 'active',
        uploadCount: 11,
        bindGroupCount: 11,
        encodeCount: 11,
      });

      expect(scenario.draw().ok).toBe(true);
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        uploadCount: 11,
        bindGroupCount: 11,
        encodeCount: 11,
      });
    } finally {
      submit.mockRestore();
      await scenario.dispose();
    }
  });

  it('uploads positive Bloom parameter changes without rebuilding the accepted bundle', async () => {
    const scenario = await createBloomScenario();
    try {
      expect(scenario.draw().ok).toBe(true);
      const first = scenario.renderer.inspect().bloom;
      scenario.setBloomIntensity(0.35);
      expect(scenario.draw().ok).toBe(true);
      const updated = scenario.renderer.inspect().bloom;
      expect(updated.state).toBe('active');
      expect(updated.generation).toBe(first.generation);
      expect(updated.resourceCount).toBe(first.resourceCount);
      expect(updated.targetCount).toBe(first.targetCount);
      expect(updated.targetBytes).toBe(first.targetBytes);
      expect(updated.uploadCount).toBe(11);
      expect(updated.passCount).toBe(11);
    } finally {
      await scenario.dispose();
    }
  });

  it('aborts a Bloom pass write failure without publishing partial receipts', async () => {
    const originalWriteBuffer = RhiNullQueue.prototype.writeBuffer;
    const createBuffer = vi.spyOn(RhiNullDevice.prototype, 'createBuffer');
    const writeBuffer = vi.spyOn(RhiNullQueue.prototype, 'writeBuffer');
    const submit = vi.spyOn(RhiNullQueue.prototype, 'submit');
    const scenario = await createBloomScenario();
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'Bloom downsample params upload succeeds',
      hint: 'repair the Bloom params buffer and retry the frame',
    });
    const errors: unknown[] = [];
    const unsubscribe = scenario.renderer.onError((error) => errors.push(error));
    try {
      expect(scenario.draw().ok).toBe(true);
      const downsampleParams = createBuffer.mock.calls.reduce<object | undefined>(
        (found, args, index) => {
          if (found !== undefined || args[0].label !== 'bloom-horizontal-params-ubo') return found;
          const result = createBuffer.mock.results[index];
          if (result?.type !== 'return' || !result.value.ok) return undefined;
          return result.value.value as object;
        },
        undefined,
      );
      expect(downsampleParams).toBeDefined();
      const lkg = scenario.renderer.inspect().bloom;
      expect(lkg).toMatchObject({ uploadCount: 11, bindGroupCount: 11, encodeCount: 11 });
      const submitCount = submit.mock.calls.length;

      let injected = false;
      writeBuffer.mockImplementation((buffer, ...args) => {
        if (buffer === downsampleParams && !injected) {
          injected = true;
          return err(failure);
        }
        return originalWriteBuffer.call(RhiNullQueue.prototype, buffer, ...args);
      });
      expect(scenario.draw().ok).toBe(false);
      expect(injected).toBe(true);
      expect(submit).toHaveBeenCalledTimes(submitCount);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: 'pass-encode-failed',
        detail: { passName: 'bloom-horizontal-0', cause: failure },
      });
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        state: 'active',
        generation: lkg.generation,
        uploadCount: 11,
        bindGroupCount: 11,
        encodeCount: 11,
      });

      writeBuffer.mockRestore();
      expect(scenario.draw().ok).toBe(true);
      expect(submit).toHaveBeenCalledTimes(submitCount + 1);
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        uploadCount: 11,
        bindGroupCount: 11,
        encodeCount: 11,
      });
    } finally {
      writeBuffer.mockRestore();
      submit.mockRestore();
      createBuffer.mockRestore();
      unsubscribe();
      await scenario.dispose();
    }
  });

  const bloomConstructionFailures = [
    ['createSampler', 'bloom-sampler'],
    ['createBindGroupLayout', 'bloom-horizontal-bgl'],
    ['createBindGroupLayout', 'bloom-vertical-bgl'],
    ['createBindGroupLayout', 'bloom-composite-bgl'],
    ['createPipelineLayout', 'bloom-horizontal-pl'],
    ['createPipelineLayout', 'bloom-vertical-pl'],
    ['createPipelineLayout', 'bloom-composite-pl'],
    ['createRenderPipeline', 'bloom-horizontal-pipeline'],
    ['createRenderPipeline', 'bloom-vertical-pipeline'],
    ['createRenderPipeline', 'bloom-composite-pipeline'],
    ['createBuffer', 'bloom-horizontal-params-ubo'],
    ['createBuffer', 'bloom-vertical-params-ubo'],
    ['createBuffer', 'bloom-composite-params-ubo'],
  ] as const;

  it.each(
    bloomConstructionFailures,
  )('abandons the Bloom candidate when %s(%s) fails and retries cleanly', async (method, label) => {
    const scenario = await createBloomScenario();
    const original = RhiNullDevice.prototype[method];
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: `${label} construction succeeds`,
      hint: 'repair the Bloom construction operation and retry the frame',
    });
    let injected = false;
    const operation = vi.spyOn(RhiNullDevice.prototype, method);
    const submit = vi.spyOn(RhiNullQueue.prototype, 'submit');
    const errors: unknown[] = [];
    const unsubscribe = scenario.renderer.onError((error) => errors.push(error));
    operation.mockImplementation(function (this: RhiNullDevice, ...args: never[]) {
      const descriptor = args[0] as { readonly label?: unknown } | undefined;
      if (!injected && descriptor?.label === label) {
        injected = true;
        return err(failure) as never;
      }
      return Reflect.apply(original as (...input: never[]) => unknown, this, args) as never;
    } as never);
    try {
      const submitCount = submit.mock.calls.length;
      expect(scenario.draw().ok).toBe(false);
      expect(injected).toBe(true);
      expect(submit).toHaveBeenCalledTimes(submitCount);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: 'webgpu-runtime-error',
        detail: { error: expect.anything() },
      });
      const reported = errors[0] as { readonly detail?: { readonly error?: unknown } };
      if (method === 'createRenderPipeline') {
        expect(reported.detail?.error).toMatchObject({
          code: 'pipeline-build-failed',
          name: 'PipelineSpecError',
          detail: { cause: failure },
        });
      } else {
        expect(reported.detail?.error).toBe(failure);
      }
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        state: 'off',
        graphStatus: 'empty',
        targetCount: 0,
        targetBytes: 0,
        passCount: 0,
        resourceCount: 0,
        uploadCount: 0,
        bindGroupCount: 0,
        encodeCount: 0,
      });

      operation.mockRestore();
      expect(scenario.draw().ok).toBe(true);
      expect(submit).toHaveBeenCalledTimes(submitCount + 1);
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        state: 'active',
        graphStatus: 'valid',
        targetCount: 11,
        passCount: 11,
        uploadCount: 11,
        bindGroupCount: 11,
        encodeCount: 11,
      });
    } finally {
      operation.mockRestore();
      submit.mockRestore();
      unsubscribe();
      await scenario.dispose();
    }
  });

  it('aborts a Bloom bind-group failure before submit and preserves committed receipts', async () => {
    const scenario = await createBloomScenario();
    const originalCreateBindGroup = RhiNullDevice.prototype.createBindGroup;
    const createBindGroup = vi.spyOn(RhiNullDevice.prototype, 'createBindGroup');
    const submit = vi.spyOn(RhiNullQueue.prototype, 'submit');
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'Bloom upsample bind-group creation succeeds',
      hint: 'repair the Bloom bind group and retry the frame',
    });
    let injected = false;
    try {
      expect(scenario.draw().ok).toBe(true);
      const lkg = scenario.renderer.inspect().bloom;
      const submitCount = submit.mock.calls.length;
      scenario.canvas.width = 96;
      scenario.canvas.height = 64;
      createBindGroup.mockImplementation(function (this: RhiNullDevice, descriptor) {
        if (!injected && descriptor.label === 'bloom-vertical-3-bg') {
          injected = true;
          return err(failure);
        }
        return originalCreateBindGroup.call(this, descriptor);
      });
      expect(scenario.draw().ok).toBe(false);
      expect(injected).toBe(true);
      expect(submit).toHaveBeenCalledTimes(submitCount);
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        state: 'active',
        generation: lkg.generation,
        uploadCount: 11,
        bindGroupCount: 11,
        encodeCount: 11,
      });

      createBindGroup.mockRestore();
      expect(scenario.draw().ok).toBe(true);
      expect(submit).toHaveBeenCalledTimes(submitCount + 1);
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        state: 'active',
        uploadCount: 11,
        bindGroupCount: 11,
        encodeCount: 11,
      });
    } finally {
      createBindGroup.mockRestore();
      submit.mockRestore();
      await scenario.dispose();
    }
  });

  it('aggregates active and fence-retiring Bloom bundles through Renderer.inspect', async () => {
    const scenario = await createBloomScenario();
    const fence = deferred<undefined>();
    const onSubmittedWorkDone = vi
      .spyOn(RhiNullQueue.prototype, 'onSubmittedWorkDone')
      .mockReturnValue(fence.promise);
    try {
      expect(scenario.draw().ok).toBe(true);
      scenario.setBloom('off');
      expect(scenario.draw().ok).toBe(true);
      const retiring = scenario.renderer.inspect().bloom;
      expect(retiring.state).toBe('retiring');
      expect(retiring.graphStatus).toBe('empty');
      expect(retiring.enabled).toBe(false);
      expect(retiring.passCount).toBe(0);
      expect(retiring.targetCount).toBe(0);
      expect(retiring.targetBytes).toBe(0);
      expect(retiring.encodeCount).toBe(0);
      expect(retiring.bindGroupCount).toBe(0);
      expect(retiring.uploadCount).toBe(0);
      expect(retiring.resourceCount).toBeGreaterThan(0);

      scenario.setBloom('on');
      expect(scenario.draw().ok).toBe(true);
      const overlap = scenario.renderer.inspect().bloom;
      expect(overlap.state).toBe('active');
      expect(overlap.graphStatus).toBe('valid');
      expect(overlap.enabled).toBe(true);
      expect(overlap.passCount).toBe(11);
      expect(overlap.uploadCount).toBe(11);
      expect(overlap.bindGroupCount).toBe(11);
      expect(overlap.encodeCount).toBe(11);
      expect(overlap.resourceCount).toBeGreaterThan(retiring.resourceCount);

      fence.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
      const settled = scenario.renderer.inspect().bloom;
      expect(settled.state).toBe('active');
      expect(settled.graphStatus).toBe('valid');
      expect(settled.passCount).toBe(11);
      expect(settled.targetCount).toBe(11);
      expect(settled.targetBytes).toBe(54_592);
      expect(settled.resourceCount).toBeLessThan(overlap.resourceCount);
    } finally {
      onSubmittedWorkDone.mockRestore();
      await scenario.dispose();
    }
  });

  it('settles Bloom off to exact zero without re-enabling it', async () => {
    const scenario = await createBloomScenario();
    const fence = deferred<undefined>();
    const onSubmittedWorkDone = vi
      .spyOn(RhiNullQueue.prototype, 'onSubmittedWorkDone')
      .mockReturnValue(fence.promise);
    try {
      expect(scenario.draw().ok).toBe(true);
      scenario.setBloom('off');
      expect(scenario.draw().ok).toBe(true);
      const retiring = scenario.renderer.inspect().bloom;
      expect(retiring.state).toBe('retiring');
      expect(retiring.enabled).toBe(false);
      expect(retiring.targetCount).toBe(0);
      expect(retiring.targetBytes).toBe(0);
      expect(retiring.passCount).toBe(0);
      expect(retiring.resourceCount).toBeGreaterThan(0);
      expect(retiring.uploadCount).toBe(0);

      fence.resolve(undefined);
      for (let attempt = 0; attempt < 4; attempt += 1) await Promise.resolve();
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        state: 'off',
        graphStatus: 'empty',
        enabled: false,
        targetCount: 0,
        targetBytes: 0,
        passCount: 0,
        resourceCount: 0,
        uploadCount: 0,
      });
    } finally {
      onSubmittedWorkDone.mockRestore();
      await scenario.dispose();
    }
  });

  it('faults the generation after one fence rejection while preserving Bloom and canvas cleanup failures', async () => {
    const scenario = await createBloomScenario();
    const fence = deferred<undefined>();
    const onSubmittedWorkDone = vi
      .spyOn(RhiNullQueue.prototype, 'onSubmittedWorkDone')
      .mockReturnValue(fence.promise);
    const errors: unknown[] = [];
    let errorSnapshot: ReturnType<typeof scenario.renderer.inspect> | undefined;
    const unsubscribe = scenario.renderer.onError((error) => {
      errors.push(error);
      if (error.code === 'webgpu-runtime-error') errorSnapshot = scenario.renderer.inspect();
    });
    try {
      expect(scenario.draw().ok).toBe(true);
      scenario.setBloom('off');
      expect(scenario.draw().ok).toBe(true);
      expect(scenario.renderer.inspect().bloom.resourceCount).toBeGreaterThan(0);
      const cause = new Error('controlled Bloom fence failure');
      fence.reject(cause);
      await Promise.resolve();
      await Promise.resolve();
      expect(errors).toHaveLength(2);
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'webgpu-runtime-error',
            detail: expect.objectContaining({
              error: expect.objectContaining({ code: 'bloom-fence-rejected' }),
            }),
          }),
          expect.objectContaining({ code: 'device-operation-failed', cause }),
        ]),
      );
      expect(scenario.renderer.health()).toMatchObject({
        reason: 'internal-fault',
        recoverable: false,
      });
      expect(scenario.draw().ok).toBe(false);
      expect(errorSnapshot?.bloom).toMatchObject({
        state: 'retiring',
        graphStatus: 'empty',
        enabled: false,
      });
      expect(errorSnapshot?.bloom.resourceCount).toBeGreaterThan(0);
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        state: 'off',
        enabled: false,
        resourceCount: 0,
        passCount: 0,
        encodeCount: 0,
        bindGroupCount: 0,
        uploadCount: 0,
      });
      const disposal = await scenario.renderer.dispose();
      expect(disposal).toMatchObject({
        ok: false,
        error: {
          code: 'cleanup-failed',
          detail: {
            causes: [
              { code: 'rhi-not-available', cause: new Error('controlled Bloom fence failure') },
            ],
          },
        },
      });
      expect((await scenario.renderer.dispose()).ok).toBe(true);
      expect(errors).toHaveLength(3);
      if (disposal.ok) throw new Error('expected the rejected canvas fence to fail cleanup');
      expect(errors[2]).toMatchObject({
        code: 'rhi-not-available',
        cause: new Error('controlled Bloom fence failure'),
      });
    } finally {
      unsubscribe();
      onSubmittedWorkDone.mockRestore();
      await scenario.dispose();
    }
  });

  it('keeps drained Bloom fence rejection callbacks inert', async () => {
    const scenario = await createBloomScenario();
    const callbacks: Array<{
      readonly resolve: (value: undefined) => unknown;
      readonly reject: ((reason: unknown) => unknown) | undefined;
    }> = [];
    const lateFence = {
      // biome-ignore lint/suspicious/noThenProperty: The test deliberately exposes a controllable fence thenable.
      then(onFulfilled: (value: undefined) => unknown, onRejected: (reason: unknown) => unknown) {
        callbacks.push({ resolve: onFulfilled, reject: onRejected });
        return Promise.resolve();
      },
    } as unknown as Promise<undefined>;
    const onSubmittedWorkDone = vi
      .spyOn(RhiNullQueue.prototype, 'onSubmittedWorkDone')
      .mockReturnValue(lateFence);
    const errors: unknown[] = [];
    const unsubscribe = scenario.renderer.onError((error) => errors.push(error));
    try {
      expect(scenario.draw().ok).toBe(true);
      scenario.setBloom('off');
      expect(scenario.draw().ok).toBe(true);
      expect(scenario.renderer.inspect().bloom.resourceCount).toBeGreaterThan(0);
      // Allow Promise consumers to assimilate this deliberately incomplete thenable.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await Promise.resolve();
      }
      expect(callbacks.length).toBeGreaterThan(0);
      for (const callback of callbacks) callback.resolve(undefined);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await Promise.resolve();
      }
      expect(scenario.renderer.inspect().bloom.resourceCount).toBe(0);
      for (const callback of callbacks) {
        callback.reject?.(new Error('late Bloom fence rejection'));
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(errors).toHaveLength(0);
      expect(scenario.renderer.inspect().bloom).toMatchObject({
        state: 'off',
        graphStatus: 'empty',
        resourceCount: 0,
        passCount: 0,
        encodeCount: 0,
        bindGroupCount: 0,
        uploadCount: 0,
      });
    } finally {
      unsubscribe();
      onSubmittedWorkDone.mockRestore();
      await scenario.dispose();
    }
  });

  it.each([
    'execute',
    'finish',
    'submit',
    'throw',
  ] as const)('keeps the Bloom LKG invisible and retries after %s failure', async (failureAt) => {
    const scenario = await createBloomScenario();
    const errors: unknown[] = [];
    let failureSnapshot: ReturnType<typeof scenario.renderer.inspect> | undefined;
    const unsubscribe = scenario.renderer.onError((error) => {
      errors.push(error);
      failureSnapshot = scenario.renderer.inspect();
    });
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: `Bloom ${failureAt} operation succeeds`,
      hint: 'repair the injected operation and retry the same frame',
    });
    const createEncoder = vi.spyOn(RhiNullDevice.prototype, 'createCommandEncoder');
    const beginRenderPass = vi.spyOn(RhiNullCommandEncoder.prototype, 'beginRenderPass');
    const finish = vi.spyOn(RhiNullCommandEncoder.prototype, 'finish');
    const submit = vi.spyOn(RhiNullQueue.prototype, 'submit');
    try {
      expect(scenario.draw().ok).toBe(true);
      scenario.setBloom('off');
      expect(scenario.draw().ok).toBe(true);
      const lkg = scenario.renderer.inspect().bloom;
      scenario.setBloom('on');
      if (failureAt === 'execute') {
        beginRenderPass.mockImplementation(() => {
          throw failure;
        });
      } else if (failureAt === 'finish') {
        finish.mockReturnValue(err(failure));
      } else if (failureAt === 'submit') {
        submit.mockReturnValue(err(failure));
      } else {
        createEncoder.mockImplementation(() => {
          throw failure;
        });
      }
      expect(scenario.draw().ok).toBe(false);
      expect(scenario.renderer.inspect().bloom.resourceCount).toBe(lkg.resourceCount);
      expect(scenario.renderer.inspect().bloom.passCount).toBe(0);
      expect(failureSnapshot?.bloom.generation).toBe(lkg.generation);
      expect(failureSnapshot?.bloom.resourceCount).toBe(lkg.resourceCount);
      expect(failureSnapshot?.bloom.passCount).toBe(0);
      expect(errors.length).toBeGreaterThan(0);
      const errorCount = errors.length;
      createEncoder.mockRestore();
      beginRenderPass.mockRestore();
      finish.mockRestore();
      submit.mockRestore();
      expect(scenario.draw().ok).toBe(true);
      expect(scenario.renderer.inspect().bloom.state).toBe('active');
      expect(scenario.renderer.inspect().bloom.generation).toBeGreaterThan(lkg.generation);
      expect(errors).toHaveLength(errorCount);
    } finally {
      createEncoder.mockRestore();
      beginRenderPass.mockRestore();
      finish.mockRestore();
      submit.mockRestore();
      unsubscribe();
      await scenario.dispose();
    }
  });

  it('abandons later Bloom params construction and destroys adopted handles once', async () => {
    const scenario = await createBloomScenario();
    const originalCreateBuffer = RhiNullDevice.prototype.createBuffer;
    const originalDestroyBuffer = RhiNullDevice.prototype.destroyBuffer;
    const createBuffer = vi.spyOn(RhiNullDevice.prototype, 'createBuffer');
    const destroyBuffer = vi.spyOn(RhiNullDevice.prototype, 'destroyBuffer');
    const created = new Map<object, string>();
    const destroyCounts = new Map<object, number>();
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'Bloom upsample params buffer construction succeeds',
      hint: 'repair the injected construction failure and retry the same frame',
    });
    try {
      expect(scenario.draw().ok).toBe(true);
      scenario.setBloom('off');
      expect(scenario.draw().ok).toBe(true);
      const lkg = scenario.renderer.inspect().bloom;
      scenario.setBloom('on');
      createBuffer.mockImplementation(function (this: RhiNullDevice, descriptor) {
        if (descriptor.label === 'bloom-vertical-params-ubo') {
          return err(failure);
        }
        const result = originalCreateBuffer.call(this, descriptor);
        if (
          result.ok &&
          typeof result.value === 'object' &&
          result.value !== null &&
          typeof descriptor.label === 'string' &&
          descriptor.label.startsWith('bloom-')
        ) {
          created.set(result.value, descriptor.label);
        }
        return result;
      });
      destroyBuffer.mockImplementation(function (this: RhiNullDevice, handle) {
        if (typeof handle === 'object' && handle !== null) {
          destroyCounts.set(handle, (destroyCounts.get(handle) ?? 0) + 1);
        }
        return originalDestroyBuffer.call(this, handle);
      });
      expect(scenario.draw().ok).toBe(false);
      expect(scenario.renderer.inspect().bloom.resourceCount).toBe(lkg.resourceCount);
      expect(scenario.renderer.inspect().bloom.passCount).toBe(0);
      const adoptedBeforeFailure = [...created.entries()].filter(
        ([, label]) => label === 'bloom-horizontal-params-ubo',
      );
      expect(adoptedBeforeFailure).toHaveLength(1);
      expect(adoptedBeforeFailure.every(([handle]) => destroyCounts.get(handle) === 1)).toBe(true);
      expect(
        [...created.values()].filter((label) => label === 'bloom-vertical-params-ubo'),
      ).toHaveLength(0);
      createBuffer.mockRestore();
      destroyBuffer.mockRestore();
      expect(scenario.draw().ok).toBe(true);
      expect(scenario.renderer.inspect().bloom.generation).toBeGreaterThan(lkg.generation);
    } finally {
      createBuffer.mockRestore();
      destroyBuffer.mockRestore();
      await scenario.dispose();
    }
  });

  it('keeps Bloom ownership scoped across failed and successful device recovery', async () => {
    const adapter = new RhiNullAdapter();
    const lost = deferred<{ readonly reason: 'unknown'; readonly message: string }>();
    const firstDevice = (await adapter.requestDevice()).unwrap();
    const replacementDevice = (await adapter.requestDevice()).unwrap();
    const lostProxy = new Proxy(firstDevice, {
      get(target, property) {
        if (property === 'lost') return lost.promise;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let requestCount = 0;
    const recoveryFailure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'replacement device acquisition succeeds',
      hint: 'retry recovery after the backend becomes available',
    });
    const recoverableRhi = {
      ...rhi,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => {
            requestCount += 1;
            if (requestCount === 1) return ok(lostProxy);
            if (requestCount === 2) return { ok: false, error: recoveryFailure };
            return ok(replacementDevice);
          },
        } as never),
    } as never;
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi: recoverableRhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: LocalCamera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_ACES_FILMIC,
          bloom: BLOOM_ENABLED,
        },
      },
    );
    const input = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    try {
      expect((await renderer.initialization).ok).toBe(true);
      expect(world.update().ok).toBe(true);
      expect(renderer.draw(input()).ok).toBe(true);
      expect(renderer.inspect().recovery).toMatchObject({
        phase: null,
        fromGeneration: 0,
        candidateGeneration: 0,
        attempt: 0,
        lastOutcome: 'none',
        rehydratedRoots: 0,
        staleLossEvents: 0,
      });
      const beforeLoss = renderer.inspect().bloom;
      const beforeDeviceGeneration = renderer.inspect().temporal.deviceGeneration;
      expect(beforeLoss.state).toBe('active');
      lost.reject({ reason: 'unknown', message: 'forced device loss' });
      await Promise.resolve();
      await Promise.resolve();
      expect(renderer.health().reason).toBe('device-lost');
      const failed = await renderer.recover();
      expect(failed.ok).toBe(false);
      expect(renderer.health().reason).toBe('device-lost');
      expect(renderer.inspect().recovery).toMatchObject({
        phase: null,
        fromGeneration: 0,
        candidateGeneration: 1,
        attempt: 1,
        lastOutcome: 'failed',
        rehydratedRoots: 0,
        staleLossEvents: 0,
      });
      expect(renderer.inspect().perFramePassNames).toEqual([]);
      expect(renderer.inspect().standardLighting).toBeUndefined();
      const recovered = await renderer.recover();
      expect(recovered.ok).toBe(true);
      expect(renderer.inspect().recovery).toMatchObject({
        phase: null,
        fromGeneration: 0,
        candidateGeneration: 1,
        attempt: 2,
        lastOutcome: 'succeeded',
        rehydratedRoots: expect.any(Number),
        staleLossEvents: 0,
      });
      expect(renderer.inspect().recovery.rehydratedRoots).toBeGreaterThan(0);
      // Publication retires the graph bound to the previous canvas context;
      // the first recovered draw acquires the replacement presentation target.
      expect(renderer.inspect().perFramePassNames).toHaveLength(0);
      expect(world.update().ok).toBe(true);
      expect(renderer.draw(input()).ok).toBe(true);
      expect(renderer.inspect().perFramePassNames.length).toBeGreaterThan(0);
      expect(renderer.inspect().standardLighting).toBeDefined();
      expect(renderer.inspect().bloom.state).toBe('active');
      expect(renderer.inspect().bloom.generation).toBeGreaterThan(0);
      expect(renderer.inspect().temporal.deviceGeneration).toBeGreaterThan(beforeDeviceGeneration);
      expect((await renderer.dispose()).ok).toBe(true);
      expect((await renderer.dispose()).ok).toBe(true);
      expect(renderer.inspect().bloom.state).toBe('off');
    } finally {
      await renderer.dispose();
    }
  });

  it('recovers on a Host replacement canvas through the existing single flight', async () => {
    const adapter = new RhiNullAdapter();
    const lost = deferred<{ readonly reason: 'unknown'; readonly message: string }>();
    const first = (await adapter.requestDevice()).unwrap();
    const replacement = (await adapter.requestDevice()).unwrap();
    const proxy = new Proxy(first, {
      get(target, property) {
        if (property === 'lost') return lost.promise;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const acquireCanvasContext = vi.fn(rhi.acquireCanvasContext.bind(rhi));
    let devices = 0;
    const recoverableRhi = {
      ...rhi,
      acquireCanvasContext,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => ok(++devices === 1 ? proxy : replacement),
        }),
    } as never;
    const canvas = { width: 64, height: 64, getContext: () => null };
    const newCanvas = {
      width: 128,
      height: 48,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    const hostFailure = {
      code: 'app-system-update-failed',
      expected: 'Host canvas transfer succeeds',
      hint: 'repair the Host canvas transfer',
      detail: { cause: 'native transfer rejection' },
    };
    const resolveRecoveryCanvas = vi.fn(async () => newCanvas).mockRejectedValueOnce(hostFailure);
    const renderer = await constructRenderer(
      canvas,
      {
        rhi: recoverableRhi,
        resolveRecoveryCanvas,
      },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    const world = new World();
    const identity = world.identity;
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    registerPropagateTransforms(world);
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      { component: LocalCamera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
    );
    try {
      expect((await renderer.initialization).ok).toBe(true);
      expect((await renderer.recover()).ok).toBe(false);
      expect(resolveRecoveryCanvas).not.toHaveBeenCalled();
      lost.reject({ reason: 'unknown', message: 'forced surface replacement loss' });
      await Promise.resolve();
      await Promise.resolve();
      expect(renderer.health().reason).toBe('device-lost');
      const failed = renderer.recover();
      expect(renderer.recover()).toBe(failed);
      const failedResult = await failed;
      expect(failedResult).toMatchObject({
        ok: false,
        error: { code: 'recovery-failed', detail: { phase: 'quiesce', cause: hostFailure } },
      });
      expect(renderer.health().reason).toBe('device-lost');
      expect(renderer.inspect().temporal.deviceGeneration).toBe(0);
      expect(acquireCanvasContext).toHaveBeenCalledTimes(1);
      expect(acquireCanvasContext).toHaveBeenLastCalledWith(canvas);
      const recovery = renderer.recover();
      expect(renderer.recover()).toBe(recovery);
      expect((await recovery).ok).toBe(true);
      expect(resolveRecoveryCanvas).toHaveBeenCalledTimes(2);
      expect(acquireCanvasContext).toHaveBeenLastCalledWith(newCanvas);
      expect(world.identity).toBe(identity);
      expect(world.update().ok).toBe(true);
      const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) throw drawn.error;
      if (drawn.value === undefined) throw new Error('Missing frame receipt');
      expect((await drawn.value.completed).ok).toBe(true);
    } finally {
      await renderer.dispose();
    }
  });

  it.each([
    'deadline',
    'dispose',
  ] as const)('does not acquire or publish a late Host surface after %s', async (stop) => {
    const adapter = new RhiNullAdapter();
    const first = (await adapter.requestDevice()).unwrap();
    const lost = deferred<{ readonly reason: 'unknown'; readonly message: string }>();
    const pending = deferred<HTMLCanvasElement>();
    let signal: AbortSignal | undefined;
    const proxy = new Proxy(first, {
      get(target, property) {
        if (property === 'lost') return lost.promise;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const acquireCanvasContext = vi.fn(rhi.acquireCanvasContext.bind(rhi));
    const canvas = { width: 64, height: 64, getContext: () => null };
    const newCanvas = {
      width: 128,
      height: 48,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    const resolveRecoveryCanvas = vi.fn((value: AbortSignal) => {
      signal = value;
      return pending.promise;
    });
    const renderer = await constructRenderer(
      canvas,
      {
        rhi: {
          ...rhi,
          acquireCanvasContext,
          requestAdapter: async () =>
            ok({
              features: adapter.features,
              limits: adapter.limits,
              requestDevice: async () => ok(proxy),
            }),
        } as never,
        resolveRecoveryCanvas,
      },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    try {
      expect((await renderer.initialization).ok).toBe(true);
      lost.reject({ reason: 'unknown', message: 'forced surface replacement loss' });
      await Promise.resolve();
      await Promise.resolve();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const recovery = renderer.recover();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolveRecoveryCanvas).toHaveBeenCalledTimes(1);
      if (stop === 'deadline') {
        await vi.advanceTimersByTimeAsync(20_000);
        expect((await recovery).ok).toBe(false);
      } else {
        await renderer.dispose();
      }
      pending.resolve(newCanvas);
      expect((await recovery).ok).toBe(false);
      expect(signal?.aborted).toBe(true);
      expect(acquireCanvasContext).toHaveBeenCalledTimes(1);
      expect(acquireCanvasContext).toHaveBeenLastCalledWith(canvas);
      expect(renderer.inspect().temporal.deviceGeneration).toBe(0);
    } finally {
      vi.useRealTimers();
      await renderer.dispose();
    }
  });

  it('does not publish Bloom resources for an intensity-zero recovery candidate', async () => {
    const adapter = new RhiNullAdapter();
    const lost = deferred<{ readonly reason: 'unknown'; readonly message: string }>();
    const firstDevice = (await adapter.requestDevice()).unwrap();
    const replacementDevice = (await adapter.requestDevice()).unwrap();
    const lostProxy = new Proxy(firstDevice, {
      get(target, property) {
        if (property === 'lost') return lost.promise;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let requestCount = 0;
    const recoverableRhi = {
      ...rhi,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => {
            requestCount += 1;
            return requestCount === 1 ? ok(lostProxy) : ok(replacementDevice);
          },
        } as never),
    } as never;
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi: recoverableRhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: LocalCamera,
        data: {
          fov: 1,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_ACES_FILMIC,
          bloom: BLOOM_ENABLED,
          bloomIntensity: 0,
        },
      },
    );
    const input = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    const assertZero = (): void => {
      expect(renderer.inspect().bloom).toMatchObject({
        graphStatus: 'empty',
        enabled: false,
        targetCount: 0,
        targetBytes: 0,
        resourceCount: 0,
        passCount: 0,
        encodeCount: 0,
        bindGroupCount: 0,
        uploadCount: 0,
        residentChildBytes: 0,
        state: 'off',
      });
    };
    try {
      expect((await renderer.initialization).ok).toBe(true);
      expect(world.update().ok).toBe(true);
      expect(renderer.draw(input()).ok).toBe(true);
      assertZero();
      lost.reject({ reason: 'unknown', message: 'forced intensity-zero recovery loss' });
      await Promise.resolve();
      await Promise.resolve();
      expect(renderer.health().reason).toBe('device-lost');
      expect((await renderer.recover()).ok).toBe(true);
      assertZero();
      expect(world.update().ok).toBe(true);
      expect(renderer.draw(input()).ok).toBe(true);
      assertZero();
    } finally {
      await renderer.dispose();
    }
  });

  it('abandons a post-process recovery candidate before promotion and retries once', async () => {
    const adapter = new RhiNullAdapter();
    const lost = deferred<{ readonly reason: 'unknown'; readonly message: string }>();
    const firstDevice = (await adapter.requestDevice()).unwrap();
    const failingReplacement = (await adapter.requestDevice()).unwrap();
    const successfulReplacement = (await adapter.requestDevice()).unwrap();
    const lostProxy = new Proxy(firstDevice, {
      get(target, property) {
        if (property === 'lost') return lost.promise;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const createdReplacementHandles = new Set<object>();
    const createdReplacementLabels = new Map<object, string>();
    const destroyedReplacementHandles = new Map<object, number>();
    let failPostProcessRestore = true;
    const recoveryFailure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'post-process recovery params upload succeeds',
      hint: 'repair the replacement post-process resource and retry recovery',
    });
    const trackReplacement = new Proxy(failingReplacement, {
      get(target, property) {
        if (property === 'createBuffer') {
          return (descriptor: { readonly label?: string }) => {
            const result = failingReplacement.createBuffer(descriptor as never);
            if (
              result.ok &&
              typeof result.value === 'object' &&
              result.value !== null &&
              (descriptor.label?.startsWith('bloom-') ||
                descriptor.label?.startsWith('post-process-params-'))
            ) {
              createdReplacementHandles.add(result.value);
              if (descriptor.label !== undefined) {
                createdReplacementLabels.set(result.value, descriptor.label);
              }
            }
            return result;
          };
        }
        if (property === 'queue') {
          return new Proxy(failingReplacement.queue, {
            get(queue, queueProperty) {
              if (queueProperty === 'writeBuffer') {
                return (buffer: object, ...args: unknown[]) => {
                  const label = createdReplacementLabels.get(buffer);
                  if (failPostProcessRestore && label?.startsWith('post-process-params-')) {
                    return err(recoveryFailure);
                  }
                  return failingReplacement.queue.writeBuffer(
                    buffer as never,
                    args[0] as number,
                    args[1] as ArrayBufferView | ArrayBuffer,
                    args[2] as number | undefined,
                    args[3] as number | undefined,
                  );
                };
              }
              const value = Reflect.get(queue, queueProperty, queue);
              return typeof value === 'function' ? value.bind(queue) : value;
            },
          });
        }
        if (property === 'destroyBuffer' || property === 'destroyTexture') {
          return (handle: object) => {
            destroyedReplacementHandles.set(
              handle,
              (destroyedReplacementHandles.get(handle) ?? 0) + 1,
            );
            const destroy = failingReplacement[property as 'destroyBuffer' | 'destroyTexture'];
            return destroy.call(failingReplacement, handle as never);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let requestCount = 0;
    const recoveryFailureRhi = {
      ...rhi,
      requestAdapter: async () =>
        ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => {
            requestCount += 1;
            if (requestCount === 1) return ok(lostProxy);
            if (requestCount === 2) return ok(trackReplacement as never);
            return ok(successfulReplacement);
          },
        } as never),
    } as never;
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi: recoveryFailureRhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: LocalCamera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            tonemap: TONEMAP_ACES_FILMIC,
            bloom: BLOOM_DISABLED,
          },
        },
      )
      .unwrap();
    const input = () => ({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    try {
      expect((await renderer.initialization).ok).toBe(true);
      expect(world.update().ok).toBe(true);
      expect(renderer.draw(input()).ok).toBe(true);
      const beforeFailure = renderer.inspect();
      lost.reject({ reason: 'unknown', message: 'forced recovery candidate failure' });
      await Promise.resolve();
      await Promise.resolve();
      expect(renderer.health().reason).toBe('device-lost');
      const failedRecovery = await renderer.recover();
      expect(failedRecovery.ok).toBe(false);
      if (!failedRecovery.ok) {
        expect(failedRecovery.error.code).toBe('recovery-failed');
      }
      expect(renderer.health().reason).toBe('device-lost');
      expect(createdReplacementHandles.size).toBeGreaterThan(0);
      expect(
        [...createdReplacementHandles].every(
          (handle) => destroyedReplacementHandles.get(handle) === 1,
        ),
      ).toBe(true);
      const afterFailure = renderer.inspect();
      expect(afterFailure.frame.deviceGeneration).toBe(beforeFailure.frame.deviceGeneration);
      expect(afterFailure.temporal.deviceGeneration).toBe(beforeFailure.temporal.deviceGeneration);
      expect(afterFailure.environment).toEqual(beforeFailure.environment);
      expect(afterFailure.bloom.state).toBe('off');

      failPostProcessRestore = false;
      const recovered = await renderer.recover();
      expect(recovered.ok).toBe(true);
      expect(renderer.inspect().frame.deviceGeneration).toBeGreaterThan(
        beforeFailure.frame.deviceGeneration,
      );
      world.set(camera, LocalCamera, { bloom: BLOOM_ENABLED }).unwrap();
      expect(world.update().ok).toBe(true);
      expect(renderer.draw(input()).ok).toBe(true);
      expect(renderer.inspect().bloom.state).toBe('active');
      expect((await renderer.dispose()).ok).toBe(true);
      expect((await renderer.dispose()).ok).toBe(true);
      expect(renderer.inspect().bloom).toMatchObject({
        state: 'off',
        graphStatus: 'empty',
        resourceCount: 0,
        passCount: 0,
        encodeCount: 0,
        bindGroupCount: 0,
        uploadCount: 0,
      });
    } finally {
      await renderer.dispose();
    }
  });

  it('reports a structured disposed outcome when recovery is interrupted by dispose', async () => {
    const adapter = new RhiNullAdapter();
    const lost = deferred<{ readonly reason: 'unknown'; readonly message: string }>();
    const recoveryAdapterEntered = deferred<void>();
    const releaseRecoveryAdapter = deferred<void>();
    const firstDevice = (await adapter.requestDevice()).unwrap();
    const lostProxy = new Proxy(firstDevice, {
      get(target, property) {
        if (property === 'lost') return lost.promise;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let requestCount = 0;
    const recoverableRhi = {
      ...rhi,
      requestAdapter: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return ok({
            features: adapter.features,
            limits: adapter.limits,
            requestDevice: async () => ok(lostProxy),
          } as never);
        }
        recoveryAdapterEntered.resolve();
        await releaseRecoveryAdapter.promise;
        return ok({
          features: adapter.features,
          limits: adapter.limits,
          requestDevice: async () => ok(firstDevice),
        } as never);
      },
    } as never;
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi: recoverableRhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );

    try {
      expect((await renderer.initialization).ok).toBe(true);
      lost.reject({ reason: 'unknown', message: 'forced device loss' });
      await Promise.resolve();
      await Promise.resolve();
      expect(renderer.health().reason).toBe('device-lost');

      const recovery = renderer.recover();
      await recoveryAdapterEntered.promise;
      expect(renderer.inspect().recovery.phase).toBe('acquire-adapter');
      expect((await renderer.dispose()).ok).toBe(true);
      releaseRecoveryAdapter.resolve();

      const result = await recovery;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        if (result.error.code !== 'recovery-failed') {
          throw new Error(`Expected recovery-failed, received ${result.error.code}`);
        }
        expect(result.error.detail).toMatchObject({
          phase: 'cleanup',
          oldGeneration: 0,
          candidateGeneration: 1,
          attempt: 1,
          lastOutcome: 'disposed',
          rehydratedRoots: 0,
          staleLossEvents: 0,
        });
      }
      expect(renderer.inspect().recovery).toMatchObject({
        phase: null,
        attempt: 1,
        lastOutcome: 'disposed',
        rehydratedRoots: 0,
        staleLossEvents: 0,
      });
    } finally {
      releaseRecoveryAdapter.resolve();
      await renderer.dispose();
    }
  });
});
