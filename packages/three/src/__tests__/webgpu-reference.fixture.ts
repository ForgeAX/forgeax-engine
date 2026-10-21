import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';
import RectAreaLightNode from 'three/src/nodes/lighting/RectAreaLightNode.js';
import OriginalRenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import type { SkinnedMesh } from 'three/src/Three.Core.js';
import {
  AmbientLight,
  type Camera,
  DirectionalLight,
  type Object3D,
  PointLight,
  RectAreaLight,
  RenderTarget,
  SpotLight,
  type ToneMapping,
} from 'three/src/Three.Core.js';
import { expect } from 'vitest';
import { SIZE } from './render.fixture';

/** Independent r184 WebGPU state also avoids its retained Texture.channel node cache. */
export async function renderReference(
  scene: Object3D,
  camera: Camera,
  options: {
    shadowMap?: { enabled: boolean; type: import('three/src/Three.Core.js').ShadowMapType };
    antialias?: boolean;
    toneMapping?: ToneMapping;
    exposure?: number;
    alpha?: boolean;
    stencil?: boolean;
    depth?: boolean;
  } = {},
): Promise<Uint8Array> {
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
  const original = new OriginalRenderer({
    stencil: options.stencil ?? false,
    depth: options.depth ?? true,
    alpha: options.alpha ?? true,
    antialias: options.antialias ?? false,
  });
  const reference = scene.clone();
  const sourceObjects: Object3D[] = [],
    copiedObjects: Object3D[] = [];
  scene.traverse((object) => sourceObjects.push(object));
  reference.traverse((object) => copiedObjects.push(object));
  // Preserve the submitted root's cached pose even when its parent is outside
  // this scene. Descendants still update against this copied world matrix.
  reference.matrixWorldAutoUpdate = false;
  const copies = new Map(sourceObjects.map((source, index) => [source, copiedObjects[index]]));
  for (let i = 0; i < sourceObjects.length; i++) {
    const source = sourceObjects[i],
      copy = copiedObjects[i];
    // SkinningNode's module-global WeakMap keys a Skeleton by frameId.
    // Independent renderers restart at frame 1; sharing the source Skeleton
    // would skip later pose uploads. Give the oracle its own palette and bones.
    if (source !== undefined && copy !== undefined && 'isSkinnedMesh' in source) {
      const from = source as SkinnedMesh,
        to = copy as SkinnedMesh;
      to.skeleton = from.skeleton.clone();
      to.skeleton.bones = from.skeleton.bones.map(
        (bone) => (copies.get(bone) ?? bone) as typeof bone,
      );
    }
    if (source !== undefined && copy !== undefined && 'isScene' in source) {
      copy.onBeforeRender = source.onBeforeRender;
      copy.onAfterRender = source.onAfterRender;
    }
    if (source !== undefined && copy !== undefined && 'isClippingGroup' in source) {
      const from = source as unknown as Record<string, unknown>,
        to = copy as unknown as Record<string, unknown>;
      for (const field of ['clippingPlanes', 'enabled', 'clipIntersection', 'clipShadows'])
        to[field] = from[field];
    }
    // r184 BatchedMesh.copy tests the destination's null color texture, and
    // drops its draw count. Reuse these source-owned inputs in the oracle;
    // the independent WebGPU renderer still builds and submits every draw.
    if (source !== undefined && copy !== undefined && 'isBatchedMesh' in source) {
      const from = source as unknown as Record<string, unknown>,
        to = copy as unknown as Record<string, unknown>;
      for (const field of Object.keys(from).filter((field) => field.startsWith('_')))
        to[field] = from[field];
    }
  }
  const constructors = { AmbientLight, DirectionalLight, PointLight, SpotLight, RectAreaLight };
  const replaceLights = (parent: Object3D) => {
    for (const child of [...parent.children]) {
      const Constructor = constructors[child.type as keyof typeof constructors];
      if (Constructor !== undefined) {
        parent.remove(child);
        // LightsNode dispatches on constructor identity across the two bundles.
        parent.add(new Constructor().copy(child as never));
      } else replaceLights(child);
    }
  };
  replaceLights(reference);
  const target = new RenderTarget(SIZE, SIZE);
  original.setSize(SIZE, SIZE);
  if (options.shadowMap !== undefined) Object.assign(original.shadowMap, options.shadowMap);
  if (options.toneMapping !== undefined) original.toneMapping = options.toneMapping;
  if (options.exposure !== undefined) original.toneMappingExposure = options.exposure;
  try {
    await original.init();
    expect((original.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend).toBe(true);
    const device = (original.backend as unknown as { device: GPUDevice }).device;
    device.pushErrorScope('validation');
    original.setOutputRenderTarget(target);
    const referenceCamera = camera.clone();
    referenceCamera.matrixWorldAutoUpdate = false;
    // r184 promotes Uint16 indices during first upload, after BatchedMesh has
    // computed byte offsets. Warm the oracle once, then recompute draw starts
    // using the uploaded index width before measuring the independent frame.
    if (copiedObjects.some((object) => 'isBatchedMesh' in object)) {
      original.render(reference, referenceCamera);
      await device.queue.onSubmittedWorkDone();
    }
    original.render(reference, referenceCamera);
    const pixels = new Uint8Array(
      await original.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE),
    );
    const validation = await device.popErrorScope();
    expect(validation?.message ?? null).toBeNull();
    return pixels;
  } finally {
    target.dispose();
    original.dispose();
  }
}
