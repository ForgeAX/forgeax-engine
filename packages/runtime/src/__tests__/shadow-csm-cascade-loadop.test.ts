// shadow-csm-cascade-loadop.test.ts - typed shadow per-cascade depth clear
// @perf-budget-skip - the two cases intentionally drive the full renderer call site.
// Per-cascade depth loadOp, asserted against the REAL call site: the typed
// shadow graph gives each cascade its own array layer and clears it.
//
// This test does NOT re-declare the decision expression and feed it to the
// pure builder (that would be tautological — the bug could regress verbatim
// while the suite stays green). Instead it drives the whole pipeline through
// createRenderer + the lease-bound renderer.draw input: the URP cascade loop calls
// one typed shadow pass per cascade, whose execute closure invokes the real
// encodeDirectionalShadowPass(c, pass, cascadeIndex). A mock GPU device
// captures every descriptor handed to beginRenderPass on the dedicated
// 'render-system-shadow' command encoder, so the asserted truth table is the
// engine's decision at the real call site.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer } from '../createRenderer';
import { standardMaterialShaderVariants } from './helpers/standard-material-manifest';

interface ShadowPassDescriptor {
  depthLoadOp: string;
  depthStoreOp: string;
  hasDepthClearValue: boolean;
  depthClearValue: number | undefined;
}

interface CaptureLog {
  // Descriptors captured from beginRenderPass on the 'render-system-shadow'
  // encoder, in record order (cascade 0, 1, ... N-1).
  shadowPassDescriptors: ShadowPassDescriptor[];
}

function makeMockGL2(): unknown {
  return {
    __mockTag: 'webgl2',
    getExtension: () => null,
    getParameter: () => 1,
    isContextLost: () => false,
  };
}

function makeMockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 800,
    height: 600,
    getContext(kind: string): unknown {
      if (kind === 'webgl2') return makeMockGL2();
      if (kind === 'webgpu') {
        return {
          __mockTag: 'webgpu-canvas-context',
          configure: () => undefined,
          unconfigure: () => undefined,
          getCurrentTexture: () => ({ createView: () => ({}) }),
        };
      }
      return null;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
}

function captureShadowDescriptor(
  log: CaptureLog,
  descriptor: { depthStencilAttachment?: Record<string, unknown> } | undefined,
): void {
  const ds = descriptor?.depthStencilAttachment;
  if (ds === undefined) return;
  log.shadowPassDescriptors.push({
    depthLoadOp: ds.depthLoadOp as string,
    depthStoreOp: ds.depthStoreOp as string,
    hasDepthClearValue: Object.hasOwn(ds, 'depthClearValue'),
    depthClearValue: ds.depthClearValue as number | undefined,
  });
}

function makeRenderPassEncoder(): Record<string, unknown> {
  return {
    setPipeline: () => undefined,
    setVertexBuffer: () => undefined,
    setIndexBuffer: () => undefined,
    setBindGroup: () => undefined,
    setViewport: () => undefined,
    draw: () => undefined,
    drawIndexed: () => undefined,
    setStencilReference: () => undefined,
    end: () => undefined,
  };
}

function makeMockGPUDevice(log: CaptureLog): unknown {
  const lost = new Promise<unknown>(() => undefined);
  return {
    __mockTag: 'gpu-device',
    lost,
    features: new Set(),
    limits: {},
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
      writeTexture: () => undefined,
      onSubmittedWorkDone: async () => undefined,
    },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: () => ({
      getMappedRange: () => new ArrayBuffer(64),
      unmap: () => undefined,
    }),
    createCommandEncoder: () => {
      return {
        beginRenderPass: (rpDesc?: {
          label?: string;
          depthStencilAttachment?: Record<string, unknown>;
        }) => {
          if (rpDesc?.label?.startsWith('shadowCascade') === true) {
            captureShadowDescriptor(log, rpDesc);
          }
          return makeRenderPassEncoder();
        },
        finish: () => ({}),
      };
    },
    createTexture: () => ({ createView: () => ({}) }),
    createSampler: () => ({}),
    destroy: () => undefined,
  };
}

function makeMockGPU(device: unknown): unknown {
  return {
    requestAdapter: async () => ({ requestDevice: async () => device }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

const baseNavigator = { userAgent: 'mock-engine-test' } as Partial<Navigator> as Navigator;

function buildManifestDataUrl(): string {
  const materialShaderStub = (identifier: string, composedWgsl = '/* stub */') => ({
    identifier,
    sourcePath: `${identifier}.wgsl`,
    composedWgsl,
    paramSchema: '[]',
    variants:
      identifier === 'forgeax::default-standard-pbr'
        ? standardMaterialShaderVariants(composedWgsl)
        : [],
  });
  const manifest = {
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      {
        hash: 'tonemap0',
        wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
        glsl: '',
        bindings: '',
      },
    ],
    materialShaders: [
      materialShaderStub('forgeax::default-standard-pbr'),
      materialShaderStub('forgeax::default-unlit'),
      materialShaderStub(
        'forgeax::default-shadow-caster',
        '/* reserved shadow caster - @location(0) position */',
      ),
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

function identityTransform(): Record<string, number[]> {
  return { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function cameraTransform(): Record<string, number[]> {
  return { ...identityTransform(), pos: [0, 0, 3] };
}

function directionalLight(): Record<string, number | number[]> {
  return {
    direction: [-0.5, -1, -0.3],
    color: [1, 1, 1],
    intensity: 1,
  };
}

async function drawCsmScene(cascadeCount: number): Promise<CaptureLog> {
  const log: CaptureLog = { shadowPassDescriptors: [] };
  const device = makeMockGPUDevice(log);
  vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
  const created = await createRenderer(
    makeMockCanvas(),
    {},
    { shaderManifestUrl: buildManifestDataUrl() },
  );
  const renderer = created.unwrap();
  const world = new World();
  world.spawn(
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 16 / 9,
        near: 0.1,
        far: 100,
        projection: 0,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
      },
    },
    { component: Transform, data: cameraTransform() },
  );
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true, ...directionalLight(), cascadeCount, mapSize: 1024 },
  });
  world.spawn(
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: {} },
    { component: Transform, data: identityTransform() },
  );

  const errors: { code: string }[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  let disposed: Awaited<ReturnType<typeof renderer.dispose>>;
  try {
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    world.update().unwrap();
    const submitted = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!submitted.ok) throw submitted.error;
    const completed = await submitted.value.completed;
    if (!completed.ok) throw completed.error;
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    disposed = await renderer.dispose();
  }
  if (!disposed.ok) throw disposed.error;
  return log;
}

describe('CSM per-cascade depth loadOp (typed shadow call site)', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { ...baseNavigator });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── AC-03: cascadeCount=4 truth table (drives the real call site) ──────────
  // N=4 cascades share a single shadowDepth atlas. Each cascade pass routes
  // through the typed shadow graph -> beginRenderPass with the per-cascade override.
  // Every cascade owns one depth-array layer and clears it, so a cascade
  // re-raster never depends on (or erases) another cascade's retained depth.
  it('AC-03: cascadeCount=4 clears every cascade layer at the real call site', async () => {
    const log = await drawCsmScene(4);
    expect(log.shadowPassDescriptors).toHaveLength(4);
    for (const descriptor of log.shadowPassDescriptors) {
      expect(descriptor.depthLoadOp).toBe('clear');
      expect(descriptor.hasDepthClearValue).toBe(true);
      expect(descriptor.depthClearValue).toBe(0);
      expect(descriptor.depthStoreOp).toBe('store');
    }
  }, 15_000);

  // The single cascade (index 0) must still clear, matching pre-fix behavior.

  it('AC-04: cascadeCount=1 uses clear (no regression)', async () => {
    const log = await drawCsmScene(1);
    expect(log.shadowPassDescriptors).toHaveLength(1);
    const only = log.shadowPassDescriptors[0];
    expect(only?.depthLoadOp).toBe('clear');
    expect(only?.hasDepthClearValue).toBe(true);
    expect(only?.depthClearValue).toBe(0);
    expect(only?.depthStoreOp).toBe('store');
  }, 15_000);
});
