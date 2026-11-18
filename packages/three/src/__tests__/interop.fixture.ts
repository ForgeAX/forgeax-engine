import * as THREE from '@forgeax/engine/three';
import { createRhiInstrumentation } from '@forgeax/engine-app';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Materials,
  MeshFilter,
  MeshRenderer,
  Camera as NativeCamera,
  DirectionalLight as NativeDirectionalLight,
  ShadowParticipation,
} from '@forgeax/engine-render';
import { attachRecorder, type EncodedTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { createRenderer, defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { AssetKind } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { displayPixels, SIZE, verifyReplay } from './render.fixture';

function greenReceiverShadows(actual: Uint8Array, unshadowed: Uint8Array, minimum = 0) {
  let lit = 0,
    shadowed = 0;
  for (let i = 0; i < actual.length; i += 4) {
    if (
      (unshadowed[i + 1] ?? 0) > (unshadowed[i + 2] ?? 0) * 1.4 &&
      (unshadowed[i + 1] ?? 0) > minimum
    ) {
      lit++;
      if ((unshadowed[i + 1] ?? 0) - (actual[i + 1] ?? 0) > 20) shadowed++;
    }
  }
  return { lit, shadowed };
}

function litChannelPixels(lit: Uint8Array, dark: Uint8Array, channel: number): number {
  let count = 0;
  for (let i = channel; i < lit.length; i += 4) if ((lit[i] ?? 0) > (dark[i] ?? 0) + 20) count++;
  return count;
}

export async function createInteropJourney(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  bundler?: Parameters<typeof createRenderer>[2],
) {
  const recorder = attachRecorder({
    rhi: webgpu.rhi,
    createShaderModule: webgpu.createShaderModule,
  }).unwrap();
  const result = await createRenderer(
    canvas,
    {
      rhi: recorder.backend.rhi,
      pipeline: THREE.createThreePipeline(),
      rhiInstrumentation: createRhiInstrumentation(recorder),
    },
    bundler,
  );
  if (!result.ok) throw result.error;
  const native = result.value;
  const assets = new AssetRegistry();
  for (const contribution of defaultAssetDecoderContributions)
    assets.installDecoder(contribution.kind as AssetKind<unknown>, contribution.decoder);
  const world = new World({ assets });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  texture.needsUpdate = true;
  let uploads = 0;
  texture.onUpdate = () => {
    uploads++;
  };
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 1.5, 1.5),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  mesh.position.z = 0.5;
  scene.add(mesh);
  const geometry = assets.create(createBoxGeometry(1.5, 1.5, 1.5).unwrap()).unwrap();
  const blue = assets.create(Materials.unlit([0, 0, 1, 1])).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: geometry } },
      { component: MeshRenderer, data: { materials: [blue] } },
      { component: ShadowParticipation, data: { cast: true, receive: true } },
    )
    .unwrap();
  const shadows = { enabled: false, type: THREE.PCFShadowMap };
  const mount = (
    await THREE.mountThreeScene({ world, renderer: native, scene, camera, shadowMap: shadows })
  ).unwrap();
  const lease = native.attach(world);
  if (!lease.ok) throw lease.error;
  let mounted = true;
  let nativeCamera: EntityHandle | undefined;
  const frame = () => {
    if (mounted) mount.sync().unwrap();
    propagateTransforms(world).unwrap();
    const selected = mounted ? mount.entityFor(camera).unwrap() : nativeCamera;
    if (selected === undefined) throw new Error('missing selected native camera');
    const draw = native.draw({
      source: mounted ? mount.source : lease.value,
      camera: { entityKey: selected },
      geometryLane: 'direct',
    });
    if (!draw.ok) throw draw.error;
    return draw.value;
  };
  const ready = async (frames = 1) => {
    const deadline = performance.now() + 20000;
    for (let completed = 0; completed < frames; ) {
      const receipt = frame();
      const done = await receipt.completed;
      if (!done.ok) throw done.error;
      if (receipt.presentation === 'ready') completed++;
      else if (receipt.preparationCompleted !== undefined) {
        const prepared = await receipt.preparationCompleted;
        if (!prepared.ok) throw prepared.error;
      }
      if (performance.now() > deadline) throw new Error('mixed scene readiness deadline exceeded');
    }
  };
  const capture = async (): Promise<THREE.ThreeFrameCapture> => {
    await ready();
    const abort = new AbortController();
    const pending = recorder.captureFrame({ signal: abort.signal });
    try {
      (await recorder.frameBoundary()).unwrap();
      const requested = native.requestObservation?.(['final-display']);
      if (requested === undefined || !requested.ok)
        throw new Error('missing final-display observation');
      const receipt = frame();
      const completed = await receipt.completed;
      if (!completed.ok) throw completed.error;
      expect(receipt.presentation).toBe('ready');
      const observed = await native.observe(receipt, {
        include: ['draws', 'bindings', 'final-display'],
      });
      if (!observed.ok) throw observed.error;
      const tape: EncodedTape = (await pending).unwrap();
      const sources: THREE.ThreeSourceIdentity[] = [];
      if (mounted)
        scene.traverse((object) => {
          const bound = mount.entityFor(object);
          if (bound.ok)
            sources.push({
              uuid: object.uuid,
              type: object.type,
              name: object.name,
              entityKey: bound.value,
            });
        });
      return { tape, receipt, observation: observed.value, sources };
    } finally {
      abort.abort();
      await pending;
    }
  };
  const dispose = async () => {
    mount.dispose().unwrap();
    lease.value.dispose();
    const disposed = await native.dispose();
    if (!disposed.ok) throw disposed.error;
    (await recorder.dispose()).unwrap();
    assets.dispose();
  };
  return {
    world,
    scene,
    camera,
    mesh,
    mount,
    entity,
    native,
    capture,
    ready,
    dispose,
    async verifyOcclusion(
      evidence?: (name: string, capture: THREE.ThreeFrameCapture) => Promise<void>,
    ) {
      await ready(60);
      expect(uploads).toBe(1);
      const front = await capture();
      const center = (SIZE * (SIZE / 2) + SIZE / 2) * 4;
      expect(displayPixels(front)[center]).toBeGreaterThan(240);
      expect(displayPixels(front)[center + 2]).toBeLessThan(5);
      await evidence?.('mixed-three-front', front);
      world.set(entity, Transform, { pos: [0, 0, 1.5] }).unwrap();
      const behind = await capture();
      expect(displayPixels(behind)[center + 2]).toBeGreaterThan(240);
      expect(displayPixels(behind)[center]).toBeLessThan(5);
      await verifyReplay(behind, 'mixed-native-front');
      await evidence?.('mixed-native-front', behind);
      const bound = mount.entityFor(mesh).unwrap();
      const shared = world
        .spawn(
          { component: Transform, data: { pos: [-1.5, 0, 0.5] } },
          {
            component: MeshFilter,
            data: { assetHandle: world.get(bound, MeshFilter).unwrap().assetHandle },
          },
          {
            component: MeshRenderer,
            data: { materials: [...world.get(bound, MeshRenderer).unwrap().materials] },
          },
        )
        .unwrap();
      mount.dispose().unwrap();
      mounted = false;
      nativeCamera = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          {
            component: NativeCamera,
            data: { fov: (50 * Math.PI) / 180, aspect: 1, near: 0.1, far: 100 },
          },
        )
        .unwrap();
      const remaining = await capture();
      expect(displayPixels(remaining)[center + 2]).toBeGreaterThan(240);
      expect(displayPixels(remaining)[(SIZE * (SIZE / 2) + 18) * 4]).toBeGreaterThan(240);
      expect(world.hasComponent(entity, MeshFilter)).toBe(true);
      expect(world.hasComponent(shared, MeshFilter)).toBe(true);
      await evidence?.('mixed-native-after-unmount', remaining);
    },
    async verifyShadows(
      evidence?: (name: string, capture: THREE.ThreeFrameCapture) => Promise<void>,
    ) {
      scene.remove(mesh);
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(12, 12),
        new THREE.MeshStandardMaterial({ color: 0x40c060, roughness: 1 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      const sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.position.set(-3, 6, 4);
      sun.castShadow = true;
      sun.shadow.mapSize.set(128, 128);
      sun.shadow.camera.left = sun.shadow.camera.bottom = -5;
      sun.shadow.camera.right = sun.shadow.camera.top = 5;
      sun.shadow.camera.updateProjectionMatrix();
      scene.add(ground, sun);
      shadows.enabled = true;
      camera.position.set(5, 5, 7);
      camera.lookAt(0, 0.5, 0);
      const cube = assets.create(createBoxGeometry(1.5, 2, 1.5).unwrap()).unwrap();
      const material = assets
        .create(Materials.standard({ baseColor: [0.05, 0.05, 0.8, 1], roughness: 1 }))
        .unwrap();
      world.set(entity, MeshFilter, { assetHandle: cube }).unwrap();
      world.set(entity, MeshRenderer, { materials: [material] }).unwrap();
      world.set(entity, Transform, { pos: [0, 1, 0] }).unwrap();
      await ready(60);
      const on = await capture();
      world.set(entity, ShadowParticipation, { cast: false }).unwrap();
      const off = await capture();
      const a = displayPixels(on),
        b = displayPixels(off);
      const { lit, shadowed } = greenReceiverShadows(a, b, 30);
      expect(lit).toBeGreaterThan(100);
      expect(shadowed).toBeGreaterThan(5);
      sun.intensity = 0;
      const dark = displayPixels(await capture());
      expect(
        dark.reduce((sum, value, index) => (index % 4 === 3 ? sum : sum + value), 0),
      ).toBeLessThan(
        b.reduce((sum, value, index) => (index % 4 === 3 ? sum : sum + value), 0) * 0.1,
      );
      await verifyReplay(off, 'mixed-native-caster');
      await evidence?.('mixed-native-caster-on', on);
      await evidence?.('mixed-native-caster-off', off);
      // Reverse the ownership: a Three caster shadows a native receiver.
      scene.remove(ground);
      sun.intensity = 3;
      const sourceCaster = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 2, 1.5),
        new THREE.MeshStandardMaterial({ color: 0x2040ff, roughness: 1 }),
      );
      sourceCaster.position.y = 1;
      sourceCaster.castShadow = true;
      scene.add(sourceCaster);
      const nativeGround = assets.create(createBoxGeometry(12, 0.1, 12).unwrap()).unwrap();
      const green = assets
        .create(Materials.standard({ baseColor: [0.05, 0.6, 0.1, 1], roughness: 1 }))
        .unwrap();
      world.set(entity, MeshFilter, { assetHandle: nativeGround }).unwrap();
      world.set(entity, MeshRenderer, { materials: [green] }).unwrap();
      world.set(entity, Transform, { pos: [0, -0.05, 0] }).unwrap();
      world.set(entity, ShadowParticipation, { cast: false, receive: true }).unwrap();
      const reverseOn = await capture();
      sourceCaster.castShadow = false;
      const reverseOff = await capture();
      const reverseA = displayPixels(reverseOn),
        reverseB = displayPixels(reverseOff);
      expect(greenReceiverShadows(reverseA, reverseB).shadowed).toBeGreaterThan(5);
      await evidence?.('mixed-three-caster-on', reverseOn);
      await evidence?.('mixed-three-caster-off', reverseOff);
      // Native direct lighting contributes to both ownership domains.
      sun.intensity = 0;
      const nativeSun = world
        .spawn({
          component: NativeDirectionalLight,
          data: { direction: [3, -6, -4], intensity: 3 },
        })
        .unwrap();
      const nativeLit = displayPixels(await capture());
      world.set(nativeSun, NativeDirectionalLight, { intensity: 0 }).unwrap();
      const nativeDark = displayPixels(await capture());
      expect(litChannelPixels(nativeLit, nativeDark, 1)).toBeGreaterThan(100);
      expect(litChannelPixels(nativeLit, nativeDark, 2)).toBeGreaterThan(30);
    },
  };
}
