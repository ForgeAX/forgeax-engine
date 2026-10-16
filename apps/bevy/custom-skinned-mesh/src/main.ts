import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialAsset, MeshAsset, SkeletonAsset } from '@forgeax/engine-types';

interface Rig {
  readonly upper: EntityHandle;
  readonly phase: number;
  readonly speed: number;
}

interface EvidenceWindow extends Window {
  __bevyCustomSkinnedMeshReady?: boolean;
  __bevyCustomSkinnedMeshSnapshot?: () => { readonly upperQuat: number[]; readonly elapsed: number };
  __prepareCustomSkinnedMeshCapture?: () => Promise<void>;
}

if (typeof document !== 'undefined') {
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  if (canvas === null) throw new Error('[custom-skinned-mesh] missing #app canvas');
  void bootstrap(canvas);
}

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const { forgeaxBundlerAdapter } = await import('virtual:forgeax/bundler');
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    const message = appResult.error instanceof EngineEnvironmentError ? 'no usable rendering backend' : appResult.error.code;
    console.error(`[custom-skinned-mesh] createApp failed: ${message}`);
    return;
  }
  const app = appResult.value;
  const rigs = buildWorld(app.world);
  const evidence = window as EvidenceWindow;
  evidence.__bevyCustomSkinnedMeshReady = true;
  evidence.__bevyCustomSkinnedMeshSnapshot = () => {
    const transform = app.world.get(rigs[0]!.upper, Transform).unwrap();
    return { upperQuat: Array.from(transform.quat), elapsed: app.world.getResource(Time).elapsed };
  };
  const started = app.start();
  if (!started.ok) console.error(`[custom-skinned-mesh] app.start failed: ${started.error.code}`);
  evidence.__prepareCustomSkinnedMeshCapture = async (): Promise<void> => {
    const updated = app.world.update(1 / 60);
    if (!updated.ok) throw new Error(`capture preparation update failed: ${updated.error.code}`);
  };
}

export function buildWorld(world: World): readonly Rig[] {
  const mesh = world.allocSharedRef('MeshAsset', createWeightedRibbon());
  // Skin extraction is intentionally fail-fast when the first pass is not the
  // skin shader. Materials.standard is the static-PBR constructor, so a
  // hand-authored skinned mesh must name the public skin shader explicitly.
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::pbr-skin' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [0.15, 0.7, 1, 1], metallic: 0, roughness: 0.35 },
  });
  const skeleton: SkeletonAsset = {
    kind: 'skeleton',
    jointCount: 2,
    inverseBindMatrices: new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
    ]),
  };
  const skeletonHandle = world.allocSharedRef('SkeletonAsset', skeleton);
  const rigs: Rig[] = [];
  for (let i = 0; i < 6; i++) {
    const x = (i - 2.5) * 1.25;
    const root = world.spawn(
      { component: Name, data: { value: `root-${i}` } },
      { component: Transform, data: { pos: [x, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    ).unwrap() as EntityHandle;
    const upper = world.spawn(
      { component: Name, data: { value: `upper-${i}` } },
      { component: Transform, data: { pos: [0, 1, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: ChildOf, data: { parent: root } },
    ).unwrap() as EntityHandle;
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: Skin, data: { skeleton: skeletonHandle, joints: [root, upper] } },
    );
    rigs.push({ upper, phase: i * 0.55, speed: 0.8 + i * 0.12 });
  }

  world.spawn(
    { component: Transform, data: { pos: [0, 1, 7], quat: quat.fromLookAt(quat.create(), [0, 1, 7], [0, 1, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 30 }), clearColor: [0.027, 0.067, 0.11, 1] } },
  );
  world.spawn({ component: DirectionalLight, data: { direction: [-0.4, -0.8, -0.6], color: [1, 1, 1], intensity: 3, castShadow: false } });

  let elapsed = 0;
  world.addSystem(Update, {
    name: 'custom-skinned-mesh-joint-animation',
    queries: [],
    fn: (world) => {
      elapsed += world.getResource(Time).delta;
      for (const rig of rigs) {
        const angle = Math.sin(elapsed * rig.speed + rig.phase) * 0.72;
        world.set(rig.upper, Transform, { quat: quat.fromAxisAngle(quat.create(), [0, 0, 1], angle) });
      }
    },
  }).unwrap();
  return rigs;
}

function createWeightedRibbon(): MeshAsset {
  const positions = [
    -0.45, 0, 0, 0.45, 0, 0, -0.45, 0.5, 0, 0.45, 0.5, 0,
    -0.45, 1, 0, 0.45, 1, 0, -0.45, 1.5, 0, 0.45, 1.5, 0,
    -0.45, 2, 0, 0.45, 2, 0,
  ];
  const vertexCount = positions.length / 3;
  const vertices = new Float32Array(vertexCount * 18);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tangents = new Float32Array(vertexCount * 4);
  const skinIndex = new Uint16Array(vertexCount * 4);
  const skinWeight = new Float32Array(vertexCount * 4);
  const interleavedIndices = new Uint16Array(vertices.buffer);
  for (let i = 0; i < vertexCount; i++) {
    const y = positions[i * 3 + 1] ?? 0;
    const base = i * 18;
    vertices.set(positions.slice(i * 3, i * 3 + 3), base);
    vertices[base + 5] = 1;
    vertices[base + 6] = (i % 2) * 1;
    vertices[base + 7] = y / 2;
    vertices[base + 8] = 1;
    vertices[base + 11] = 1;
    const upperWeight = Math.max(0, Math.min(1, y - 1));
    const jointBase = i * 4;
    skinIndex[jointBase] = 0;
    skinIndex[jointBase + 1] = 1;
    skinWeight[jointBase] = 1 - upperWeight;
    skinWeight[jointBase + 1] = upperWeight;
    const packedBase = (base + 12) * 2;
    interleavedIndices[packedBase] = 0;
    interleavedIndices[packedBase + 1] = 1;
    vertices[base + 14] = 1 - upperWeight;
    vertices[base + 15] = upperWeight;
    normals[i * 3 + 2] = 1;
    uvs[i * 2] = (i % 2) * 1;
    uvs[i * 2 + 1] = y / 2;
    tangents[i * 4] = 1;
    tangents[i * 4 + 3] = 1;
  }
  return {
    kind: 'mesh',
    vertices,
    indices: new Uint16Array([0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 7, 4, 7, 6, 6, 7, 9, 6, 9, 8]),
    attributes: { position: new Float32Array(positions), normal: normals, uv: uvs, tangent: tangents, skinIndex, skinWeight },
    aabb: new Float32Array([-0.45, 0, 0, 0.45, 2, 0]),
    submeshes: [{ indexOffset: 0, indexCount: 24, vertexCount, topology: 'triangle-list', materialSlot: 0 }],
    materialSlots: [{ slotName: 'Default' }],
  };
}
