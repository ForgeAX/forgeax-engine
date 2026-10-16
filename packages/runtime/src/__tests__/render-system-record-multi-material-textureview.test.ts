// @perf-budget-skip: intentional full mock-GPU render regression smoke gate.

// bug-20260610-sponza-per-submesh-bg-textureviews D2 regression test (M3 / m3-1).
//
// State at C2 (this commit, parent f4bf5cda + M2 rename):
//   The non-sprite branch in render-system-record.ts builds the material BG
//   ONCE per entity using materials[0]'s textureViews, then the per-submesh
//   loop only varies the dynamic UBO offset. With 1 entity x 3 submeshes x
//   3 distinct PBR materials, only one createBindGroup call lands with
//   label 'pbr-material-skylight-bg'; all three submeshes share that BG and
//   thus share materials[0]'s baseColor textureView. Sponza renders one
//   material's albedo across all submeshes (single-material demos can never
//   surface this bug -- the materialBgKey collapses on entityKey).
//
// State at C3 (next commit, M4 7d fix):
//   BG construction moves inside the per-submesh draw loop and reads
//   materials[smIdx]'s textureViews. The cache key drops entityKey so
//   identical-material submeshes still dedup, but distinct-material submeshes
//   each get their own BG with their own baseColor textureView.
//
// Therefore at C2 the three assertions below MUST FAIL (TDD red phase). The
// failure shape is: createBindGroup is called once with the PBR label
// (not >= 3); the binding-2 textureView set has size 1 (not 3); the BG
// sentinel set has size 1 (not 3). M4 turns them GREEN.
//
// Plan anchors: AC-03 + plan D-2 + R2 risk; falsification check from
// plan-strategy 5.4. The three redundant assertions catch three independent
// failure modes after a future "half port" regression (e.g. someone moves
// the BG construction inside the loop but forgets to re-resolve textureViews
// per-material -- assertion (b) catches that even if (a) passes).

import type { World as WorldType } from '@forgeax/engine-ecs';
import type { Renderer as RendererType } from '@forgeax/engine-render';
import type { Handle, MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardMaterialShaderVariants } from './helpers/standard-material-manifest';
import { mockRenderBundles } from './mock-render-bundles';

// Load the renderer graph in setup so a cold transform cannot outlive a
// timed-out test and leak its asynchronous work into the next telemetry assertion.
beforeAll(async () => {
  await importEngine();
}, 30_000);

function canonicalTestMeshAttributes(vertexCount: number) {
  return {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    tangent: new Float32Array(vertexCount * 4),
  };
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

interface BindGroupEntryRecord {
  readonly binding: number;
  readonly resource: unknown;
}

interface CreateBindGroupCall {
  readonly label: string | undefined;
  readonly entries: readonly BindGroupEntryRecord[];
  readonly returned: object;
}

interface DeviceSpies {
  readonly createBindGroupCalls: CreateBindGroupCall[];
  readonly textureViewByTextureId: Map<object, object>;
}

function makeSpies(): DeviceSpies {
  return {
    createBindGroupCalls: [],
    textureViewByTextureId: new Map(),
  };
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
          // Each frame must hand back a fresh swap-chain texture view; the
          // test only cares about per-material textureViews so we return a
          // stable sentinel here.
          getCurrentTexture: () => ({
            createView: () => ({ __role: 'swap-chain-view' }),
          }),
        };
      }
      return null;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
}

function makeMockGPUDevice(spies: DeviceSpies, maxTextureDimension2D = 8192): { device: unknown } {
  const lost = new Promise<unknown>(() => undefined);
  let nextTextureId = 0;
  let nextBindGroupId = 0;
  const device = {
    __mockTag: 'gpu-device',
    lost,
    features: new Set(),
    limits: { maxTextureDimension2D },
    queue: {
      submit: () => undefined,
      onSubmittedWorkDone: async () => undefined,
      writeBuffer: () => undefined,
      writeTexture: () => undefined,
    },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    // The bug surface: capture every createBindGroup call's label + entries
    // so tests can assert per-material BGs were built with per-material
    // textureViews. Returns a per-call sentinel so identity comparisons
    // (assertion c) are meaningful.
    createBindGroup: (desc: {
      label?: string;
      entries?: readonly { binding: number; resource: unknown }[];
    }) => {
      const sentinel = { __role: 'bg', __id: nextBindGroupId++, __label: desc.label };
      spies.createBindGroupCalls.push({
        label: desc.label,
        entries: (desc.entries ?? []).map((e) => ({ binding: e.binding, resource: e.resource })),
        returned: sentinel,
      });
      return sentinel;
    },
    createBuffer: () => ({
      getMappedRange: () => new ArrayBuffer(64),
      unmap: () => undefined,
    }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => undefined,
        setVertexBuffer: () => undefined,
        setIndexBuffer: () => undefined,
        setBindGroup: () => undefined,
        setStencilReference: () => undefined,
        setViewport: () => undefined,
        setScissorRect: () => undefined,
        draw: () => undefined,
        drawIndexed: () => undefined,
        end: () => undefined,
      }),
      finish: () => ({}),
    }),
    // Each createTexture call gets a unique view sentinel so binding-2
    // textureView resources are distinguishable across materials. Without
    // this, every texture's view collapses to `{}` and assertion (b) cannot
    // fire even when the bug is fixed.
    createTexture: () => {
      const myId = nextTextureId++;
      const view = { __role: 'tex-view', __texId: myId };
      const tex = {
        __role: 'texture',
        __texId: myId,
        createView: () => view,
      };
      spies.textureViewByTextureId.set(tex, view);
      return tex;
    },
    createSampler: () => ({}),
    destroy: () => undefined,
  };
  return { device: mockRenderBundles(device) };
}

function makeMockGPU(deviceObj: unknown): unknown {
  return {
    requestAdapter: async () => ({ requestDevice: async () => deviceObj }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

const baseNavigator: Navigator = {
  userAgent: 'mock-engine-test',
} as Partial<Navigator> as Navigator;

function buildManifestDataUrl(): string {
  const materialShaderStub = (identifier: string, paramSchema = '[]') => ({
    identifier,
    sourcePath: `${identifier}.wgsl`,
    composedWgsl: '/* stub */',
    paramSchema,
    variants:
      identifier === 'forgeax::default-standard-pbr' ? standardMaterialShaderVariants() : [],
  });
  // The standard-PBR shader declares baseColorTexture / metallicRoughnessTexture
  // / normalTexture as texture2d params. Texture resolution is now schema-driven
  // (derive(paramSchema).textureFieldNames is the SSOT), so the stub MUST carry
  // the real schema -- an empty '[]' would yield zero user-region textures and
  // collapse all 3 distinct-baseColor materials onto one bind group.
  const pbrParamSchema = JSON.stringify([
    { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
    { name: 'metallic', type: 'f32', default: 0 },
    { name: 'roughness', type: 'f32', default: 0.5 },
    { name: 'baseColorTexture', type: 'texture2d' },
    { name: 'metallicRoughnessTexture', type: 'texture2d' },
    { name: 'normalTexture', type: 'texture2d' },
  ]);
  const manifest = {
    entries: [
      // Stub WGSL must satisfy the runtime's compatibility heuristics; the
      // pbr stub references f_schlick to mark the shader as PBR-shaped, the
      // tonemap stub declares TonemapParams to mark it as tonemap-shaped.
      // Mirrors the harness in render-system-multi-material.test.ts.
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
      materialShaderStub('forgeax::default-standard-pbr', pbrParamSchema),
      materialShaderStub('forgeax::default-unlit'),
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

interface RendererLike {
  subscribe: RendererType['subscribe'];
  draw: (worlds: unknown, opts: { cameraOwner: number; resourceOwner: number }) => void;
}

function unwrapRendererError(value: unknown): { code: string; detail?: unknown } {
  let current = value as { code: string; detail?: unknown };
  while (
    current.detail !== undefined &&
    typeof current.detail === 'object' &&
    current.detail !== null
  ) {
    const cause = (current.detail as { cause?: unknown }).cause;
    if (
      cause === undefined ||
      typeof cause !== 'object' ||
      cause === null ||
      typeof (cause as { code?: unknown }).code !== 'string'
    ) {
      break;
    }
    current = cause as { code: string; detail?: unknown };
  }
  return current;
}

async function importEngine(): Promise<{
  createRenderer: (...args: readonly unknown[]) => Promise<RendererLike>;
}> {
  const engine = (await import('../createRenderer')) as {
    createRenderer: (...args: readonly unknown[]) => Promise<unknown>;
  };
  return {
    createRenderer: async (...args: readonly unknown[]) => {
      const result = (await engine.createRenderer(...args)) as
        | { readonly ok: true; readonly value: unknown }
        | { readonly ok: false; readonly error: unknown };
      if (!result.ok) throw result.error;
      return result.value as RendererLike;
    },
  };
}

async function importEcs(): Promise<{
  World: new () => {
    spawn: (...componentDatas: unknown[]) => unknown;
    allocSharedRef: <Target extends string, T>(target: Target, payload: T) => number;
  };
}> {
  return (await import('@forgeax/engine-ecs')) as never;
}

async function importComponents(): Promise<{
  Transform: unknown;
  GlobalTransform: unknown;
  MeshFilter: unknown;
  MeshRenderer: unknown;
  Camera: unknown;
  DirectionalLight: unknown;
}> {
  return {
    ...(await import('@forgeax/engine-render')),
    ...(await import('@forgeax/engine-scene')),
  } as never;
}

function cameraTransform() {
  return {
    pos: [0, 0, 5],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

function originTransform() {
  return {
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

function makeChequerTexture(): TextureAsset {
  // A minimal 2x2 RGBA8 texture; data values do not matter -- the test
  // only cares that each registered handle resolves to a distinct GPU
  // textureView sentinel.
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    // colorSpace=linear+rgba8unorm to satisfy the runtime's
    // srgb-format consistency validator (layer 7c-1: srgb requires
    // rgba8unorm-srgb). The test only cares that each texture's
    // GPU view resolves to a distinct sentinel, not its colorSpace.
    format: 'rgba8unorm',
    data: new Uint8Array(2 * 2 * 4),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  } as unknown as TextureAsset;
}

function threeSubmeshMesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(9 * 12),
    indices: new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    attributes: canonicalTestMeshAttributes(9),
    materialSlots: [{ slotName: 'First' }, { slotName: 'Second' }, { slotName: 'Third' }],
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        topology: 'triangle-list' as const,
        materialSlot: 0,
      },
      {
        indexOffset: 3,
        indexCount: 3,
        vertexCount: 3,
        topology: 'triangle-list' as const,
        materialSlot: 1,
      },
      {
        indexOffset: 6,
        indexCount: 3,
        vertexCount: 3,
        topology: 'triangle-list' as const,
        materialSlot: 2,
      },
    ],
  };
}

// ─── Setup helpers ──────────────────────────────────────────────────────────

async function setupRenderer(
  spies: DeviceSpies,
  maxTextureDimension2D = 8192,
): Promise<{ renderer: RendererLike }> {
  const { device } = makeMockGPUDevice(spies, maxTextureDimension2D);
  vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
  const { createRenderer } = await importEngine();
  const renderer = await createRenderer(
    makeMockCanvas(),
    {},
    {
      shaderManifestUrl: buildManifestDataUrl(),
    },
  );
  return { renderer };
}

async function spawnPbrMultiMaterialScene(): Promise<unknown> {
  const { World } = await importEcs();
  const C = await importComponents();
  const world = new World();

  // Mint the 3-submesh mesh as a user-tier column handle.
  const meshHandle = world.allocSharedRef('MeshAsset', threeSubmeshMesh()) as unknown as Handle<
    'MeshAsset',
    'shared'
  >;

  // Mint 3 distinct texture assets, each producing a unique GPU textureView
  // sentinel via the createTexture mock. allocSharedRef returns the bare
  // handle (a u32 slot id), which the extract stage accepts directly in
  // values.baseColorTexture.
  const textureHandles: Handle<'TextureAsset', 'shared'>[] = [];
  for (let i = 0; i < 3; i++) {
    textureHandles.push(
      world.allocSharedRef('TextureAsset', makeChequerTexture()) as unknown as Handle<
        'TextureAsset',
        'shared'
      >,
    );
  }
  // Use numeric handles directly in values. Strings are not resolved
  // by render-system-extract (which gates on
  // `typeof pv.baseColorTexture === 'number'`); only the disk-pack
  // materialLoader resolves refs[]-index. Tests targeting the in-memory
  // extract path must pass numeric handles.

  // Mint 3 distinct PBR materials, each pointing at a different
  // baseColorTexture handle. shadingModel is 'standard' so the non-sprite
  // branch in record fires; this is the branch that builds the BG with
  // label 'pbr-material-skylight-bg'.
  const materialHandles: Handle<'MaterialAsset', 'shared'>[] = [];
  for (let i = 0; i < 3; i++) {
    const matHandle = world.allocSharedRef('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: {
        baseColor: [1, 1, 1],
        metallic: 0,
        roughness: 0.5,
        baseColorTexture: textureHandles[i] as unknown as number,
      },
    } as unknown as MaterialAsset) as unknown as Handle<'MaterialAsset', 'shared'>;
    materialHandles.push(matHandle);
  }

  world.spawn(
    {
      component: C.Camera,
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
    { component: C.Transform, data: cameraTransform() },
  );
  world.spawn(
    { component: C.DirectionalLight, data: {} },
    { component: C.Transform, data: cameraTransform() },
  );
  world.spawn(
    { component: C.MeshRenderer, data: { materials: materialHandles } },
    { component: C.MeshFilter, data: { assetHandle: meshHandle } },
    { component: C.Transform, data: originTransform() },
  );
  return world;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('record: per-submesh PBR material BG textureView (bug-20260610 D2 regression)', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', baseNavigator);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1 entity x 3 submeshes x 3 distinct PBR materials: BGs are per-material with distinct baseColor textureViews', async () => {
    const spies = makeSpies();
    const { renderer } = await setupRenderer(spies);
    const errors: string[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') {
        errors.push(event.error.code);
      }
    });

    const world = await spawnPbrMultiMaterialScene();
    if (!(renderer as unknown as RendererType).attach(world as WorldType).ok) {
      throw new Error('World attachment failed');
    }
    (world as WorldType).update().unwrap();
    renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!(renderer as unknown as RendererType).attach(world as WorldType).ok) {
      throw new Error('World attachment failed');
    }
    (world as WorldType).update().unwrap();
    renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });

    // Filter to the PBR-bucket BG creations only. Sprite / shadow / tonemap
    // BGs use different labels and would falsely inflate the count.
    const pbrBgCalls = spies.createBindGroupCalls.filter(
      (c) => c.label === 'pbr-material-skylight-bg',
    );

    // Assertion (a): one createBindGroup per distinct material slot.
    // RED at C2: only 1 call (perSubmeshBg cache hit on entityKey-keyed key);
    // GREEN at C3: 3 calls, one per submesh's distinct material.
    expect(pbrBgCalls.length).toBeGreaterThanOrEqual(3);

    // Assertion (b): the binding-2 (baseColor) textureView resources are
    // pairwise distinct across the 3 calls. RED at C2: only one call exists
    // so the set size is 1; GREEN at C3: each call's binding-2 references a
    // different GPU textureView sentinel because BG is rebuilt per-submesh
    // with materials[smIdx].baseColorTexture.
    // The RHI translator flattens `{ kind: 'textureView', value: view }` to the
    // raw view object before reaching the GPU device, so the recorded entry's
    // `resource` IS the textureView (e.g. `{ __role: 'tex-view', __texId: 22 }`),
    // not a `{ kind, value }` wrapper. Compare resources directly.
    const baseColorViews = new Set<unknown>();
    for (const call of pbrBgCalls) {
      const binding2 = call.entries.find((e) => e.binding === 2);
      expect(binding2, 'every PBR BG must declare binding 2 (baseColor)').toBeDefined();
      baseColorViews.add(binding2?.resource);
    }
    expect(baseColorViews.size).toBeGreaterThanOrEqual(3);

    // Assertion (c): the 3 calls return distinct BG sentinels (proves the
    // materialBgKey cache MISSED for each distinct-material submesh; if the
    // key still includes entityKey and not handle-specific slot data, the
    // first call populates the cache and the next two hit it -- the mock
    // wouldn't even invoke createBindGroup again so this assertion would
    // also fire alongside (a)). Recorded redundantly so a future "half
    // port" that fixes (a) but not the cache key still surfaces here.
    const bgSentinels = new Set<unknown>(pbrBgCalls.map((c) => c.returned));
    expect(bgSentinels.size).toBeGreaterThanOrEqual(3);

    // Sanity: no upstream extract-stage errors leaked in.
    expect(errors).toEqual([]);
  });
});

// feat-future-pbr-missing-texture-fallback-explicit (feedback
// 2026-07-04-glb-pbr-textures-not-applied-flat-render): a PBR/skin material
// whose baseColorTexture handle resolves to NO GPU view previously fell back
// to the 1x1 white view silently -- rendering flat with no warn / RhiError,
// which is exactly what made the "GLB renders flat" symptom undiagnosable.
// The record path now mirrors the sprite telemetry: warn-once console.warn +
// per-frame RhiError('asset-not-registered') + debug-pink baseColor override.
async function spawnPbrMissingTextureScene(): Promise<unknown> {
  const { World } = await importEcs();
  const C = await importComponents();
  const world = new World();

  // Single-submesh mesh so materials.length (1) matches submeshes.length (1)
  // and the entity passes the material-count-mismatch gate to reach the
  // per-submesh material BG path where the missing-texture telemetry lives.
  const oneSubmeshMesh: MeshAsset = {
    kind: 'mesh',
    vertices: new Float32Array(3 * 12),
    indices: new Uint16Array([0, 1, 2]),
    attributes: canonicalTestMeshAttributes(3),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
  const meshHandle = world.allocSharedRef('MeshAsset', oneSubmeshMesh) as unknown as Handle<
    'MeshAsset',
    'shared'
  >;

  // A baseColorTexture handle that IS a registered TextureAsset (so it survives
  // extract's kind==='texture' check and is carried onto the snapshot) but whose
  // GPU view can never become resident: the mock WebGPU device exposes a
  // maxTextureDimension2D of 1 while this texture is 2x2. This is the exact
  // "handle present, GPU capability refusal" condition the record-stage
  // telemetry guards -- the structured ImageError must survive alongside the
  // existing debug-pink fallback.
  const unresidentTexture = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm-srgb',
    data: new Uint8Array(2 * 2 * 4),
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  } as unknown as TextureAsset;
  const badTexHandle = world.allocSharedRef('TextureAsset', unresidentTexture) as unknown as Handle<
    'TextureAsset',
    'shared'
  >;
  const badTexHandleId = badTexHandle as unknown as number;
  const matHandle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: {
      baseColor: [1, 1, 1],
      metallic: 0,
      roughness: 0.5,
      baseColorTexture: badTexHandleId,
    },
  } as unknown as MaterialAsset) as unknown as Handle<'MaterialAsset', 'shared'>;

  world.spawn(
    {
      component: C.Camera,
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
    { component: C.Transform, data: cameraTransform() },
  );
  world.spawn(
    { component: C.DirectionalLight, data: {} },
    { component: C.Transform, data: cameraTransform() },
  );
  world.spawn(
    { component: C.MeshRenderer, data: { materials: [matHandle] } },
    { component: C.MeshFilter, data: { assetHandle: meshHandle } },
    { component: C.Transform, data: originTransform() },
  );
  return { world, badTexHandleId };
}

describe('record: PBR missing baseColorTexture telemetry (feat-future-pbr-missing-texture-fallback-explicit)', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', baseNavigator);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PBR material with unresolvable baseColorTexture fires asset-not-registered + warn-once (not silent flat)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const spies = makeSpies();
      const { renderer } = await setupRenderer(spies, 1);
      const errors: Array<{ code: string; detail?: unknown }> = [];
      renderer.subscribe((event) => {
        if (event.kind === 'error') errors.push(unwrapRendererError(event.error));
      });

      const { world, badTexHandleId } = (await spawnPbrMissingTextureScene()) as {
        world: unknown;
        badTexHandleId: number;
      };

      // Two frames: the RhiError fires per-frame (machine-readable signal), but
      // the console.warn fires exactly once (warn-once across RenderSystem
      // lifetime -- signal/noise floor, charter P3).
      if (!(renderer as unknown as RendererType).attach(world as WorldType).ok) {
        throw new Error('World attachment failed');
      }
      (world as WorldType).update().unwrap();
      renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
      if (!(renderer as unknown as RendererType).attach(world as WorldType).ok) {
        throw new Error('World attachment failed');
      }
      (world as WorldType).update().unwrap();
      renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });

      const missing = errors.filter((e) => e.code === 'asset-not-registered');
      expect(missing.length).toBeGreaterThanOrEqual(1);
      expect((missing[0]?.detail as { assetHandle?: number } | undefined)?.assetHandle).toBe(
        badTexHandleId,
      );
      expect(errors.some((e) => e.code === 'image-dimension-out-of-bounds')).toBe(true);

      const baseColorWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes('baseColor texture'),
      );
      expect(baseColorWarns.length).toBe(1);
      expect(String(baseColorWarns[0]?.[0])).toContain('debug pink');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
