import { createMeshBuilder } from '@forgeax/engine-geometry';
// apps/hello/multi-material -- multi-prim + mixed-topology MeshAsset demo
// (feat-20260608-mesh-multi-section-primitive-multi-material-slot / M5 / w21).
//
// What this demo proves end-to-end (requirements AC-08 + plan-strategy 3.4):
//   - A single MeshAsset can carry TWO submeshes (independent draw ranges with
//     independent topologies) sharing one vertex buffer + one index buffer.
//   - MeshRenderer.materials[] indexes positionally with MeshAsset.submeshes[]:
//     materials[0] paints submesh[0] (triangle-list quad), materials[1] paints
//     submesh[1] (line-list wireframe box). The render record stage (M4 / w16)
//     issues N drawIndexed calls (one per submesh), each picking the topology
//     -appropriate PSO via materialShaderPipelineCacheKey + submesh.topology.
//   - Mixed-topology in the same frame works without PSO collision: the
//     triangle-list and line-list pipelines coexist as two cache keys.
//
// Geometry (single hand-built MeshAsset, no glTF dependency):
//   - 12 vertices, 12-float interleaved layout (position vec3 + normal vec3
//     + uv vec2 + tangent vec4 = 12 floats per vertex).
//   - 4 vertices form a filled quad in the XY plane (z=0).
//   - 8 vertices form a wireframe box outline at z=0 (slightly offset so the
//     line strokes read cleanly against the filled face); 12 line-segment
//     indices wire them.
//   - Index buffer is a single Uint16Array containing both prims back-to-back:
//     [0..6) -> quad triangle-list (2 triangles), [6..18) -> box line-list
//     (6 segments wired as 12 endpoints).
//
// Submesh layout:
//   submeshes[0] = { indexOffset: 0,  indexCount: 6,  topology: 'triangle-list' }
//   submeshes[1] = { indexOffset: 6,  indexCount: 12, topology: 'line-list'     }
//
// Materials (both unlit so lighting setup stays minimal):
//   materials[0] = bright red filled quad    (forgeax::default-unlit)
//   materials[1] = bright cyan wireframe box (forgeax::default-unlit)
//
// Recipe (charter P1 progressive disclosure):
//   (1) createApp(canvas, { clearColor, shaderManifestUrl })
//   (2) assets.create( { kind:'mesh', vertices, indices,
//        attributes, submeshes:[T0, T1] }) -> meshHandle
//   (3) assets.create( red unlit)  -> redHandle
//   (4) assets.create( cyan unlit) -> cyanHandle
//   (5) world.spawn Transform + MeshFilter(meshHandle) +
//        MeshRenderer({ materials:[redHandle, cyanHandle] })
//   (6) world.spawn Camera (no light needed for unlit)
//   (7) app.start()

import { createApp } from '@forgeax/engine-app/browser';
import type { CanvasAppError } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';

import {
  type AssetHandle,
  type MaterialAsset,
  type MeshAsset,
} from '@forgeax/engine-types';


type MaterialHandle = AssetHandle<'material'>;

interface MultiMaterialDemoState {
  readonly stage: 'defaults' | 'overflow' | 'repaired' | 'cleaned';
  readonly entity: number;
  readonly bindings: readonly unknown[];
  readonly diagnostics: readonly unknown[];
}

type M32Stage = 'idle' | 'baseline' | 'stale' | 'repaired' | 'cleaned';

interface M32SharedMaterialState {
  readonly stage: M32Stage;
  readonly entity: number;
  readonly oldHandle: number;
  readonly replacementHandle: number | null;
  readonly siblingHandle: number;
  readonly stale: { readonly code: 'asset-reference-invalid'; readonly expected: string; readonly hint: string } | null;
  readonly bindings: readonly unknown[];
  readonly diagnostics: readonly unknown[];
  readonly retained: {
    readonly old: boolean;
    readonly replacement: boolean;
    readonly sibling: boolean;
  };
}

interface MultiMaterialDemoApi {
  readonly readState: () => MultiMaterialDemoState;
  readonly injectOverflow: () => MultiMaterialDemoState;
  readonly repair: () => MultiMaterialDemoState;
  readonly cleanup: () => MultiMaterialDemoState;
  readonly readM32State: () => M32SharedMaterialState;
  readonly m32Baseline: () => M32SharedMaterialState;
  readonly m32Invalidate: () => M32SharedMaterialState;
  readonly m32Repair: () => M32SharedMaterialState;
  readonly m32Cleanup: () => M32SharedMaterialState;
}

interface Built {
  readonly mesh: MeshAsset;
  readonly quadIndexCount: number;
  readonly lineIndexCount: number;
}

/**
 * Build a single MeshAsset carrying two submeshes:
 *   submesh 0 = filled quad (triangle-list, 2 tris)
 *   submesh 1 = wireframe box outline (line-list, 6 segments = 12 endpoints)
 *
 * Both submeshes share the SAME vertex / index buffers; submesh entries slice
 * into the index range. The result is a single GPU mesh upload servicing two
 * draw calls with two different PSOs at record time.
 */
function buildMultiPrimMesh(defaultMaterials: readonly [MaterialHandle, MaterialHandle]): Built {
  // 4 quad corners (XY plane at z=0, half-side = 0.6).
  const half = 0.6;
  const quadCorners: readonly (readonly [number, number, number])[] = [
    [-half, -half, 0],
    [+half, -half, 0],
    [+half, +half, 0],
    [-half, +half, 0],
  ];
  // 8 box-outline corners pushed slightly forward in Z so the line strokes
  // read cleanly without z-fighting the filled quad.
  const lineZ = 0.02;
  const lineHalf = 0.7;
  const lineCorners: readonly (readonly [number, number, number])[] = [
    [-lineHalf, -lineHalf, lineZ],
    [+lineHalf, -lineHalf, lineZ],
    [+lineHalf, +lineHalf, lineZ],
    [-lineHalf, +lineHalf, lineZ],
    // 4 extra inner corners so the wireframe shows two nested squares (gives
    // the line-list submesh a richer shape than a single quad outline).
    [-lineHalf * 0.5, -lineHalf * 0.5, lineZ],
    [+lineHalf * 0.5, -lineHalf * 0.5, lineZ],
    [+lineHalf * 0.5, +lineHalf * 0.5, lineZ],
    [-lineHalf * 0.5, +lineHalf * 0.5, lineZ],
  ];

  const positions = new Float32Array([...quadCorners, ...lineCorners].flat());

  const quadIndices: readonly number[] = [0, 1, 2, 0, 2, 3];

  // Wireframe-box indices (vertex indices 4..11): two nested squares = 8
  // segments = 16 endpoints. Use the outer square (4..7) + inner square
  // (8..11), each as 4 segments.
  const outerSegs: readonly (readonly [number, number])[] = [
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
  ];
  const innerSegs: readonly (readonly [number, number])[] = [
    [8, 9],
    [9, 10],
    [10, 11],
    [11, 8],
  ];
  const lineIndices: number[] = [];
  for (const [a, b] of [...outerSegs, ...innerSegs]) {
    lineIndices.push(a, b);
  }

  const indices = new Uint16Array([...quadIndices, ...lineIndices]);

  return {
    mesh: createMeshBuilder({
      indices,
      attributes: {
        position: positions,
        normal: new Float32Array(positions.length),
        tangent: new Float32Array((positions.length / 3) * 4),
        uv: new Float32Array((positions.length / 3) * 2),
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: quadIndices.length,
          vertexCount: 4,
          topology: 'triangle-list',
          materialSlot: 0,
        },
        {
          indexOffset: quadIndices.length,
          indexCount: lineIndices.length,
          vertexCount: 8,
          topology: 'line-list',
          materialSlot: 1,
        },
      ],
      materialSlots: [
        { slotName: 'Surface', defaultMaterial: defaultMaterials[0] },
        { slotName: 'Outline', defaultMaterial: defaultMaterials[1] },
      ],
    }).build().unwrap(),
    quadIndexCount: quadIndices.length,
    lineIndexCount: lineIndices.length,
  };
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[multi-material] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[multi-material] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[multi-material] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app = appRes.value;
  console.warn(`[multi-material] backend=${app.renderer.inspect().capabilities.backendKind}`);


  const assets = app.assets;
  if (assets === undefined) {
    console.error('[multi-material] AssetRegistry is null (renderer construction failed)');
    return;
  }
  const world = app.world;

  const defaultFirst = assets.create(makeUnlitMaterial([1.0, 0.15, 0.15])).unwrap();
  const defaultSecond = assets.create(makeUnlitMaterial([0.1, 0.9, 1.0])).unwrap();
  const built = buildMultiPrimMesh([defaultFirst, defaultSecond]);
  const meshHandle = assets.create(built.mesh).unwrap();
  const blueHandle = assets.create(makeUnlitMaterial([0.1, 0.2, 1.0])).unwrap();
  const m32OldHandle = assets.copy(defaultFirst).unwrap();
  const m32SiblingHandle = assets.copy(defaultSecond).unwrap();
  assets.release(defaultFirst).unwrap();
  assets.release(defaultSecond).unwrap();

  // Spawn with an empty override vector. The render owner must resolve both
  // declared MeshAsset defaults; no submesh topology inference is allowed.
  const meshEntity = world
    .spawn(
      {
        component: Transform,
        data: { quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      {
        component: MeshRenderer,
        data: { materials: [] },
      },
    )
    .unwrap();

  let stage: MultiMaterialDemoState['stage'] = 'defaults';
  const entityKey = Number(meshEntity);
  const state = (): MultiMaterialDemoState => {
    const observation = app.renderer.inspect().meshMaterialBindings.find(
      (entry) => entry.entityKey === entityKey,
    );
    return {
      stage,
      entity: entityKey,
      bindings: observation?.bindings ?? [],
      diagnostics: observation?.diagnostics ?? [],
    };
  };
  const publishState = (): void => {
    const stateElement = document.querySelector<HTMLElement>('#mm-state');
    if (stateElement) stateElement.textContent = JSON.stringify(state(), null, 2);
  };
  const applyMaterials = (
    nextStage: MultiMaterialDemoState['stage'],
    materials: readonly MaterialHandle[],
  ): MultiMaterialDemoState => {
    const updated = world.set(meshEntity, MeshRenderer, { materials });
    if (!updated.ok) throw updated.error;
    stage = nextStage;
    publishState();
    return state();
  };

  let m32Stage: M32Stage = 'idle';
  let m32ReplacementHandle: MaterialHandle | undefined;
  let m32Stale: M32SharedMaterialState['stale'] = null;
  const m32State = (): M32SharedMaterialState => {
    const observation = app.renderer.inspect().meshMaterialBindings.find(
      (entry) => entry.entityKey === entityKey,
    );
    return {
      stage: m32Stage,
      entity: entityKey,
      oldHandle: m32OldHandle,
      replacementHandle: m32ReplacementHandle ?? null,
      siblingHandle: m32SiblingHandle,
      stale: m32Stale,
      bindings: observation?.bindings ?? [],
      diagnostics: observation?.diagnostics ?? [],
      retained: {
        old: assets.validate(m32OldHandle).ok,
        replacement: m32ReplacementHandle !== undefined && assets.validate(m32ReplacementHandle).ok,
        sibling: assets.validate(m32SiblingHandle).ok,
      },
    };
  };
  const setM32Materials = (materials: readonly MaterialHandle[]): void => {
    const updated = world.set(meshEntity, MeshRenderer, { materials });
    if (!updated.ok) throw updated.error;
  };
  const m32Baseline = (): M32SharedMaterialState => {
    if (m32Stage !== 'idle') return m32State();
    setM32Materials([m32OldHandle, m32SiblingHandle]);
    m32Stage = 'baseline';
    publishState();
    return m32State();
  };
  const m32Invalidate = (): M32SharedMaterialState => {
    if (m32Stage === 'idle') m32Baseline();
    if (m32Stage !== 'baseline') return m32State();

    // Remove the consumer edge first. The old producer grant is the only
    // remaining reference, so releasing it makes the slot recyclable without
    // letting the replacement become visible through the old handle.
    setM32Materials([defaultFirst, m32SiblingHandle]);
    if (!assets.validate(m32OldHandle).ok) throw new Error('old producer grant was lost');
    const released = assets.release(m32OldHandle);
    if (!released.ok) throw released.error;

    const replacement = assets.create(makeUnlitMaterial([0.1, 0.2, 1.0])).unwrap();
    if (replacement === m32OldHandle) throw new Error('replacement aliased the retired identity');
    m32ReplacementHandle = replacement;
    const stale = assets.read(m32OldHandle);
    if (stale.ok || stale.error.code !== 'asset-reference-invalid') {
      throw new Error('retired asset identity resolved to replacement content');
    }
    m32Stale = { code: stale.error.code, expected: stale.error.expected, hint: stale.error.hint };
    m32Stage = 'stale';
    publishState();
    return m32State();
  };
  const m32Repair = (): M32SharedMaterialState => {
    if (m32Stage === 'idle') m32Baseline();
    if (m32Stage === 'baseline') m32Invalidate();
    if (m32Stage !== 'stale' || m32ReplacementHandle === undefined) return m32State();
    setM32Materials([m32ReplacementHandle, m32SiblingHandle]);
    m32Stage = 'repaired';
    publishState();
    return m32State();
  };
  const m32Cleanup = (): M32SharedMaterialState => {
    if (m32Stage === 'cleaned') return m32State();
    if (m32Stage !== 'idle') setM32Materials([]);
    if (m32Stage === 'idle' || m32Stage === 'baseline') {
      const released = assets.release(m32OldHandle);
      if (!released.ok) throw released.error;
    }
    if (m32ReplacementHandle !== undefined) {
      const released = assets.release(m32ReplacementHandle);
      if (!released.ok) throw released.error;
    }
    const releasedSibling = assets.release(m32SiblingHandle);
    if (!releasedSibling.ok) throw releasedSibling.error;
    m32Stage = 'cleaned';
    publishState();
    return m32State();
  };
  const demoApi: MultiMaterialDemoApi = {
    readState: state,
    injectOverflow: () => applyMaterials('overflow', [defaultFirst, defaultSecond, blueHandle]),
    repair: () => applyMaterials('repaired', [blueHandle, defaultSecond]),
    cleanup: () => applyMaterials('cleaned', []),
    readM32State: m32State,
    m32Baseline,
    m32Invalidate,
    m32Repair,
    m32Cleanup,
  };
  const demoWindow = window as Window & { __forgeaxMultiMaterial?: MultiMaterialDemoApi };
  demoWindow.__forgeaxMultiMaterial = demoApi;
  for (const [id, action] of [
    ['mm-overflow', demoApi.injectOverflow],
    ['mm-repair', demoApi.repair],
    ['mm-cleanup', demoApi.cleanup],
  ] as const) {
    document.querySelector<HTMLButtonElement>(`#${id}`)?.addEventListener('click', action);
  }
  publishState();

  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 2.5], quat: [0, 0, 0, 1]},
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        },
      },
    )
    .unwrap();

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[multi-material] running.');
}

function makeUnlitMaterial(baseColor: readonly [number, number, number]): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor },
  };
}

function reportAppError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[multi-material] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[multi-material] ${err.code}: ${err.hint}`);
}
