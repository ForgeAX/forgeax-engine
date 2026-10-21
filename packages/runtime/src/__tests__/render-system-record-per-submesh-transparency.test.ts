import { testAssets } from './helpers/runtime-assets';
// @perf-budget-skip: intentional full mock-GPU render regression smoke gate.

// feat-city-glb Bug 5 (per-submesh transparency) — structural regression test.
//
// A multi-material mesh whose transparent (glTF alphaMode=BLEND) submesh sits
// alongside opaque submeshes (the UE5 city_Sample crosswalk: opaque road
// submesh[0] + BLEND decal submesh[1]) must draw the transparent submesh with
// its OWN PBR shader + per-submesh material bind group in the LDR blend
// sub-pass — NOT the sprite shader, and NOT skipped. Before the fix the LDR
// transparent sub-pass was sprite-only + whole-mesh, so the decal submesh
// rendered opaque and its alpha=0 texels composited as black.
//
// This test drives extract->record through a mocked GPU device (no real GPU)
// and asserts, via createBindGroup label + binding-2 (baseColor) spies:
//   (a) the transparent submesh's distinct baseColor textureView is bound in a
//       `pbr-material-skylight-bg` BG (the generic PBR per-submesh BG the
//       geometry pass and the new blend sub-pass share) — proving it is drawn
//       with the PBR path, not the sprite path (`sprite-pass-material-bg`).
//   (b) both the opaque and the transparent submesh materials each produce a
//       PBR BG with their own baseColor view (per-submesh, not collapsed).
//
// Mirrors the mock harness shape of
// render-system-record-multi-material-textureview.test.ts (bug-20260610 D2).

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
}

function makeSpies(): DeviceSpies {
  return { createBindGroupCalls: [] };
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
          getCurrentTexture: () => ({ createView: () => ({ __role: 'swap-chain-view' }) }),
        };
      }
      return null;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return canvas as unknown as HTMLCanvasElement;
}

function makeMockGPUDevice(spies: DeviceSpies): { device: unknown } {
  const lost = new Promise(() => undefined);
  let nextTextureId = 0;
  let nextBindGroupId = 0;
  const device = {
    __mockTag: 'gpu-device',
    lost,
    features: new Set(),
    limits: {},
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
    createTexture: () => {
      const myId = nextTextureId++;
      const view = { __role: 'tex-view', __texId: myId };
      return { __role: 'texture', __texId: myId, createView: () => view };
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
      { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      {
        hash: 'sprite00',
        wgsl: '/* sprite stub */',
        glsl: '',
        bindings: '',
      },
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
      materialShaderStub('forgeax::sprite'),
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

interface RendererLike {
  subscribe: RendererType['subscribe'];
  draw: (worlds: unknown, opts: { cameraOwner: number; resourceOwner: number }) => void;
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

function idTransform() {
  return {
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}
function cameraTransform() {
  return { ...idTransform(), pos: [0, 0, 5] };
}

function makeTex(): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm',
    data: new Uint8Array(2 * 2 * 4),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  } as unknown as TextureAsset;
}

function twoSubmeshMesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(6 * 12),
    indices: new Uint16Array([0, 1, 2, 3, 4, 5]),
    attributes: canonicalTestMeshAttributes(6),
    materialSlots: [{ slotName: 'Opaque' }, { slotName: 'Transparent' }],
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list' as const,
      },
      {
        indexOffset: 3,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 1,
        topology: 'triangle-list' as const,
      },
    ],
  } as unknown as MeshAsset;
}

async function setupRenderer(spies: DeviceSpies): Promise<{ renderer: RendererLike }> {
  const { device } = makeMockGPUDevice(spies);
  vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
  const { createRenderer } = await importEngine();
  const renderer = await createRenderer(
    makeMockCanvas(),
    {},
    { shaderManifestUrl: buildManifestDataUrl() },
  );
  return { renderer };
}

// Spawn one entity, one 2-submesh mesh: submesh[0] opaque PBR, submesh[1]
// transparent (BLEND) PBR. Returns the two distinct baseColor texture handles.
async function spawnMixedTransparentScene(): Promise<{
  world: unknown;
  opaqueTexId: number;
  blendTexId: number;
}> {
  const { World } = await importEcs();
  const C = await importComponents();
  const world = new World();

  const meshHandle = testAssets(world as WorldType)
    .create(twoSubmeshMesh())
    .unwrap() as unknown as Handle<'MeshAsset', 'shared'>;

  const opaqueTexHandle = testAssets(world as WorldType)
    .create(makeTex())
    .unwrap();
  const blendTexHandle = testAssets(world as WorldType)
    .create(makeTex())
    .unwrap();

  const opaqueMat = testAssets(world as WorldType)
    .create({
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
        baseColorTexture: opaqueTexHandle,
      },
    } as unknown as MaterialAsset)
    .unwrap() as unknown as Handle<'MaterialAsset', 'shared'>;

  // Transparent material: renderState.blend present => extract derives
  // materials[1].transparent = true. depthWriteEnabled:false mirrors the bridge.
  const blendMat = testAssets(world as WorldType)
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: {
            ...{
              depthWriteEnabled: false,
              blend: {
                color: {
                  srcFactor: 'src-alpha',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add',
                },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
            tags: { LightMode: 'Forward' },
            queue: 3000,
          },
        },
      ],
      values: {
        baseColor: [1, 1, 1],
        metallic: 0,
        roughness: 0.5,
        baseColorTexture: blendTexHandle,
      },
    } as unknown as MaterialAsset)
    .unwrap() as unknown as Handle<'MaterialAsset', 'shared'>;

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
    { component: C.MeshRenderer, data: { materials: [opaqueMat, blendMat] } },
    { component: C.MeshFilter, data: { assetHandle: meshHandle } },
    { component: C.Transform, data: idTransform() },
  );
  return {
    world,
    opaqueTexId: opaqueTexHandle as unknown as number,
    blendTexId: blendTexHandle as unknown as number,
  };
}

describe('record: per-submesh transparency (feat-city-glb Bug 5)', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', baseNavigator);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mixed mesh (opaque + BLEND submesh): transparent submesh binds a PBR blend-sub-pass BG, not a sprite BG', async () => {
    const spies = makeSpies();
    const { renderer } = await setupRenderer(spies);
    const errors: string[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') {
        errors.push(event.error.code);
      }
    });

    const { world } = await spawnMixedTransparentScene();
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

    // The transparent submesh must be drawn through the generic PBR per-submesh
    // path (label 'pbr-material-skylight-bg'), NOT the sprite fallback
    // ('sprite-pass-material-bg'). Two distinct PBR BGs (opaque + transparent
    // submesh) each carry their own baseColor textureView.
    const pbrBgCalls = spies.createBindGroupCalls.filter(
      (c) => c.label === 'pbr-material-skylight-bg',
    );
    const spriteBgCalls = spies.createBindGroupCalls.filter(
      (c) => c.label === 'sprite-pass-material-bg',
    );

    // No sprite BG: this is a PBR mesh, the transparent submesh must NOT route
    // through the sprite whole-mesh path (that was the black-crosswalk bug).
    expect(spriteBgCalls.length).toBe(0);

    // Both submeshes' distinct baseColor views appear across PBR BGs — proves
    // the transparent submesh is drawn (in the blend sub-pass) with its own
    // material, not skipped or collapsed onto the opaque one.
    const baseColorViews = new Set<unknown>();
    for (const call of pbrBgCalls) {
      const b2 = call.entries.find((e) => e.binding === 2);
      if (b2 !== undefined) baseColorViews.add(b2.resource);
    }
    expect(baseColorViews.size).toBeGreaterThanOrEqual(2);

    expect(errors).toEqual([]);
  });
});
