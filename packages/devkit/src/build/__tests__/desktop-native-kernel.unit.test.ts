// End-to-end verification of ForgeaxDesktopNativeRenderer driving a real ForgeAX ECS World +
// AssetRegistry on NativeRenderKernel's dedicated Rust OS render thread (wgpu 30).

import { createApp } from '@forgeax/engine-app';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPlatformClock, createPlatformLifecycle } from '@forgeax/engine-platform';
import {
  Camera,
  DirectionalLight,
  Instances,
  MeshFilter,
  MeshRenderer,
  PointLight,
  perspective,
  ShadowParticipation,
  Skylight,
  SpotLight,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render';
import { isNativeRenderKernelAvailable } from '@forgeax/engine-render-kernel/native';
import {
  propagateTransforms,
  scenePlugin,
  setTransformLookAt,
  Transform,
} from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { type MeshAsset, ok, type SkeletonAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { resolveDesktopRendererChoice } from '../desktop.js';
import { desktopRenderKernelAddon } from '../desktop-addon.js';
import { createNativeKernelDesktopHost } from '../desktop-native-host.js';
import { createForgeaxDesktopNativeRenderer } from '../desktop-native-kernel.js';

function makeCubeMeshAsset(): MeshAsset {
  const faces = [
    {
      n: [0, 0, 1],
      v: [
        [-0.5, -0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, 0.5],
        [-0.5, 0.5, 0.5],
      ],
    },
    {
      n: [0, 0, -1],
      v: [
        [0.5, -0.5, -0.5],
        [-0.5, -0.5, -0.5],
        [-0.5, 0.5, -0.5],
        [0.5, 0.5, -0.5],
      ],
    },
    {
      n: [1, 0, 0],
      v: [
        [0.5, -0.5, 0.5],
        [0.5, -0.5, -0.5],
        [0.5, 0.5, -0.5],
        [0.5, 0.5, 0.5],
      ],
    },
    {
      n: [-1, 0, 0],
      v: [
        [-0.5, -0.5, -0.5],
        [-0.5, -0.5, 0.5],
        [-0.5, 0.5, 0.5],
        [-0.5, 0.5, -0.5],
      ],
    },
    {
      n: [0, 1, 0],
      v: [
        [-0.5, 0.5, 0.5],
        [0.5, 0.5, 0.5],
        [0.5, 0.5, -0.5],
        [-0.5, 0.5, -0.5],
      ],
    },
    {
      n: [0, -1, 0],
      v: [
        [-0.5, -0.5, -0.5],
        [0.5, -0.5, -0.5],
        [0.5, -0.5, 0.5],
        [-0.5, -0.5, 0.5],
      ],
    },
  ];
  const uvs: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const position = new Float32Array(24 * 3);
  const normal = new Float32Array(24 * 3);
  const uv = new Float32Array(24 * 2);
  const vertices = new Float32Array(24 * 8);
  const indices = new Uint16Array(36);
  let vi = 0;
  let ii = 0;
  for (let f = 0; f < 6; f++) {
    const face = faces[f];
    if (face === undefined) continue;
    const base = f * 4;
    for (let i = 0; i < 4; i++) {
      const v = face.v[i];
      const u = uvs[i];
      if (v === undefined || u === undefined) continue;
      position[vi * 3 + 0] = v[0] ?? 0;
      position[vi * 3 + 1] = v[1] ?? 0;
      position[vi * 3 + 2] = v[2] ?? 0;
      normal[vi * 3 + 0] = face.n[0] ?? 0;
      normal[vi * 3 + 1] = face.n[1] ?? 0;
      normal[vi * 3 + 2] = face.n[2] ?? 0;
      uv[vi * 2 + 0] = u[0];
      uv[vi * 2 + 1] = u[1];
      vertices[vi * 8 + 0] = v[0] ?? 0;
      vertices[vi * 8 + 1] = v[1] ?? 0;
      vertices[vi * 8 + 2] = v[2] ?? 0;
      vertices[vi * 8 + 3] = face.n[0] ?? 0;
      vertices[vi * 8 + 4] = face.n[1] ?? 0;
      vertices[vi * 8 + 5] = face.n[2] ?? 0;
      vertices[vi * 8 + 6] = u[0];
      vertices[vi * 8 + 7] = u[1];
      vi += 1;
    }
    indices[ii++] = base;
    indices[ii++] = base + 1;
    indices[ii++] = base + 2;
    indices[ii++] = base;
    indices[ii++] = base + 2;
    indices[ii++] = base + 3;
  }
  return {
    kind: 'mesh',
    vertices,
    indices,
    attributes: { position, normal, uv },
    aabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 36,
        vertexCount: 24,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
    materialSlots: [{ slotName: 'default' }],
  };
}

describe('desktopRenderKernelAddon resolution', () => {
  it('returns undefined cleanly for unavailable targets and throws when required', async () => {
    const missing = await desktopRenderKernelAddon('freebsd', 'x64');
    expect(missing).toBeUndefined();
    await expect(desktopRenderKernelAddon('freebsd', 'x64', { required: true })).rejects.toThrow(
      /Missing native RenderKernel desktop addon/,
    );

    if (isNativeRenderKernelAvailable()) {
      const local = await desktopRenderKernelAddon(process.platform, process.arch, {
        required: true,
      });
      expect(local).toBeDefined();
      expect(local?.fileName).toBe(
        `forgeax-render-kernel.${process.platform}-${process.arch}.node`,
      );
    }
  });

  it('defaults desktop renderer to native-kernel when addon is available with clean fallback and opt-out', () => {
    expect(resolveDesktopRendererChoice(undefined, undefined, true)).toBe('native-kernel');
    expect(resolveDesktopRendererChoice(undefined, undefined, false)).toBe('rhi-wgpu-native');
    expect(resolveDesktopRendererChoice(undefined, 'rhi-wgpu-native', true)).toBe(
      'rhi-wgpu-native',
    );
    expect(resolveDesktopRendererChoice('rhi-wgpu-native', 'native-kernel', true)).toBe(
      'rhi-wgpu-native',
    );
    expect(resolveDesktopRendererChoice('native-kernel', 'rhi-wgpu-native', false)).toBe(
      'native-kernel',
    );
  });
});

describe.skipIf(!isNativeRenderKernelAvailable())(
  'ForgeaxDesktopNativeRenderer (real ECS World -> NativeRenderKernel)',
  () => {
    it('renders a live ForgeAX ECS World with multi-light shadows and incremental partial transforms', () => {
      const world = new World();
      const assets = new AssetRegistry();
      world.bindAssets(assets).unwrap();

      const cubeHandle = assets.create(makeCubeMeshAsset()).unwrap();

      // Ground plane
      world
        .spawn(
          { component: Transform, data: { pos: [0, -0.5, 0], scale: [30, 1, 30] } },
          { component: MeshFilter, data: { assetHandle: cubeHandle } },
          { component: MeshRenderer, data: {} },
          { component: ShadowParticipation, data: { cast: false, receive: true } },
        )
        .unwrap();

      // 200 dynamic 3D cubes
      const gridSide = 15;
      const cubeEntities = [];
      for (let i = 0; i < 200; i++) {
        const gx = (i % gridSide) - 7;
        const gz = Math.floor(i / gridSide) - 6;
        const entity = world
          .spawn(
            {
              component: Transform,
              data: { pos: [gx * 1.4, 0.6, gz * 1.4], scale: [0.85, 1.1, 0.85] },
            },
            { component: MeshFilter, data: { assetHandle: cubeHandle } },
            { component: MeshRenderer, data: {} },
          )
          .unwrap();
        cubeEntities.push(entity);
      }

      // Camera looking at the grid
      const camEntity = world
        .spawn(
          { component: Transform, data: { pos: [14, 12, 16] } },
          {
            component: Camera,
            data: {
              ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 160 }),
              clearColor: new Float32Array([0.04, 0.08, 0.16, 1]),
            },
          },
        )
        .unwrap();
      setTransformLookAt(world, camEntity, [14, 12, 16], [0, 0.5, 0]).unwrap();

      // Directional shadow light + PointLight + SpotLight
      world
        .spawn({
          component: DirectionalLight,
          data: {
            direction: [-0.5, -0.85, -0.4],
            color: [1, 0.96, 0.9],
            intensity: 2.2,
            castShadow: true,
            shadowDistance: 24,
          },
        })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [5, 3, 5] } },
          {
            component: PointLight,
            data: { color: [0.25, 0.55, 1.0], intensity: 20, range: 18 },
          },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [-5, 4, -3] } },
          {
            component: SpotLight,
            data: {
              direction: [0.2, -1, 0.1],
              color: [1.0, 0.75, 0.3],
              intensity: 24,
              range: 20,
              outerConeDeg: 40,
            },
          },
        )
        .unwrap();

      propagateTransforms(world);

      const desktop = createForgeaxDesktopNativeRenderer(world, assets, {
        headless: true,
        shadowMapSize: 512,
      }).unwrap();

      try {
        // 1. Synchronous pixel witness frame from live ECS World
        const witness = desktop.renderWitnessFrame(320, 180).unwrap();
        expect(witness.receipt.executedPasses).toBe(3);
        expect(witness.image.width).toBe(320);
        expect(witness.image.height).toBe(180);

        const skyR = witness.image.pixels[0] ?? 0;
        const skyG = witness.image.pixels[1] ?? 0;
        const skyB = witness.image.pixels[2] ?? 0;
        let nonSkyPixels = 0;
        let brightPixels = 0;
        for (let i = 0; i < witness.image.pixels.length; i += 4) {
          const r = witness.image.pixels[i] ?? 0;
          const g = witness.image.pixels[i + 1] ?? 0;
          const b = witness.image.pixels[i + 2] ?? 0;
          if (Math.abs(r - skyR) + Math.abs(g - skyG) + Math.abs(b - skyB) > 15) {
            nonSkyPixels += 1;
          }
          if (r * 0.299 + g * 0.587 + b * 0.114 > 110) {
            brightPixels += 1;
          }
        }
        expect(nonSkyPixels).toBeGreaterThan(10000);
        expect(brightPixels).toBeGreaterThan(2000);

        // 2. 64 async pipelined frames with continuous 5% partial ECS Transform updates
        for (let f = 0; f < 64; f++) {
          const start = (f * 10) % cubeEntities.length;
          for (let k = 0; k < 10; k++) {
            const idx = (start + k) % cubeEntities.length;
            const entity = cubeEntities[idx];
            if (entity === undefined) continue;
            const gx = (idx % gridSide) - 7;
            const gz = Math.floor(idx / gridSide) - 6;
            const angle = (f * 0.08 + idx * 0.1) * 0.5;
            world
              .set(entity, Transform, {
                pos: [gx * 1.4, 0.6 + Math.sin(f * 0.1 + k) * 0.3, gz * 1.4],
                quat: [0, Math.sin(angle), 0, Math.cos(angle)],
                scale: [0.85, 1.1, 0.85],
              })
              .unwrap();
          }
          propagateTransforms(world);
          desktop.submitFrameAsync(320, 180, 1 / 60).unwrap();
        }

        // Hide 1 entity + despawn 20 entities on final frame
        const hiddenTarget = cubeEntities[0];
        if (hiddenTarget !== undefined) {
          world
            .addComponent(hiddenTarget, {
              component: Visibility,
              data: { state: VisibilityStateValue.hidden },
            })
            .unwrap();
        }
        for (let i = 180; i < 200; i++) {
          const e = cubeEntities[i];
          if (e !== undefined) world.despawn(e).unwrap();
        }
        propagateTransforms(world);
        desktop.submitFrameAsync(320, 180, 1 / 60).unwrap();
        desktop.flush().unwrap();

        const stats = desktop.getStats().unwrap();
        expect(stats.trackedObjects).toBe(181); // 1 ground + 180 remaining cubes
        expect(stats.lastRemoveCount).toBe(20);
        expect(stats.thread.completedFrames).toBe(66);
        expect(stats.thread.inFlightFrames).toBe(0);
        // Incremental dirty sync proof: 64 * 10 dirty moves + baseline << 66 * 201 (13,266)
        expect(stats.thread.dirtyRowsUploaded).toBeLessThan(2000);
      } finally {
        desktop.dispose();
        assets.release(cubeHandle).unwrap();
      }
    });

    it('boots a real ForgeAX createApp loop for 60 completed frames through createNativeKernelDesktopHost', async () => {
      const w = 160;
      const h = 120;
      const uiBanner = new Uint8Array(w * h * 4);
      for (let y = 0; y < 20; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          uiBanner[o + 0] = 30;
          uiBanner[o + 1] = 200;
          uiBanner[o + 2] = 250;
          uiBanner[o + 3] = 255;
        }
      }
      let uiPainted = false;

      const host = createNativeKernelDesktopHost({
        headless: true,
        width: w,
        height: h,
        shadowMapSize: 256,
        ui: {
          kind: 'rgba',
          paint: () => {
            if (uiPainted) return null;
            uiPainted = true;
            return uiBanner;
          },
        },
      }).unwrap();

      const world = new World();
      world.bindAssets(host.assets).unwrap();
      const cubeHandle = host.assets.create(makeCubeMeshAsset()).unwrap();

      const hero = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], scale: [1.4, 1.4, 1.4] } },
          { component: MeshFilter, data: { assetHandle: cubeHandle } },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      const cam = world
        .spawn(
          { component: Transform, data: { pos: [0, 1.5, 4] } },
          {
            component: Camera,
            data: { ...perspective({ fov: Math.PI / 4, aspect: w / h, near: 0.1, far: 50 }) },
          },
        )
        .unwrap();
      setTransformLookAt(world, cam, [0, 1.5, 4], [0, 0, 0]).unwrap();
      world
        .spawn({
          component: DirectionalLight,
          data: {
            direction: [-0.4, -0.8, -0.5],
            color: [1, 0.96, 0.9],
            intensity: 2.5,
            castShadow: true,
            cascadeCount: 2,
          },
        })
        .unwrap();
      world
        .spawn({
          component: Skylight,
          data: { color: [0.35, 0.45, 0.6], groundColor: [0.15, 0.12, 0.1], intensity: 0.8 },
        })
        .unwrap();

      let clockMs = 0;
      const lifecycle = createPlatformLifecycle();
      const clock = createPlatformClock(() => clockMs, 'milliseconds');
      const platform = {
        now: clock.now,
        visible: () => true,
        display: () =>
          ok({
            width: w,
            height: h,
            drawingWidth: w,
            drawingHeight: h,
            pixelRatio: 1,
            safeArea: { x: 0, y: 0, width: w, height: h },
          }),
        subscribe: lifecycle.subscribe,
        requestFrame: () => ok(() => {}),
        dispose: lifecycle.dispose,
      };

      let completedCount = 0;
      const app = (
        await createApp({
          platform,
          renderer: host.renderer,
          world,
          assets: host.assets,
          plugins: [scenePlugin()],
          onFrameCompleted: () => {
            completedCount += 1;
          },
        })
      ).unwrap();

      try {
        // Drive 60 real App frames (pause -> stepFrame) with live hero rotation
        app.start().unwrap();
        app.pause().unwrap();
        for (let f = 0; f < 60; f++) {
          clockMs += 16.666;
          const half = f * 0.04;
          world
            .set(hero, Transform, {
              pos: [0, Math.sin(f * 0.1) * 0.25, 0],
              quat: [0, Math.sin(half), 0, Math.cos(half)],
              scale: [1.4, 1.4, 1.4],
            })
            .unwrap();
          app.stepFrame(1 / 60).unwrap();
          await Promise.resolve();
        }
        host.sceneRenderer.flush().unwrap();

        expect(completedCount).toBe(60);
        const stats = host.getStats().unwrap();
        expect(stats.thread.completedFrames).toBe(60);
        expect(stats.trackedObjects).toBe(1);

        // Verify witness readback contains both the cyan top UI banner and lit 3D hero cube
        const witness = host.renderWitnessFrame(w, h)?.unwrap();
        expect(witness).toBeDefined();
        if (witness !== undefined) {
          const topIdx = (8 * w + 80) * 4;
          expect(witness.image.pixels[topIdx + 2]).toBeGreaterThan(200); // cyan UI banner
          const midIdx = (60 * w + 80) * 4;
          const midLum =
            (witness.image.pixels[midIdx] ?? 0) +
            (witness.image.pixels[midIdx + 1] ?? 0) +
            (witness.image.pixels[midIdx + 2] ?? 0);
          expect(midLum).toBeGreaterThan(150);
        }
      } finally {
        await app.dispose();
        host.dispose();
        platform.dispose();
      }
    });

    it('renders ECS Skin joint animation and folds 200-instance Instances component into hardware instancing', () => {
      const world = new World();
      const assets = new AssetRegistry();
      world.bindAssets(assets).unwrap();

      // 1. Skinned quad MeshAsset (1 joint; 14 floats/vertex = pos3+nrm3+uv2+skinIndex2+skinWeight4)
      const sqPos = new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0.6, 0.6, 0, -0.6, 0.6, 0]);
      const sqNrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
      const sqUv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
      const sqIdx = new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const sqWgt = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
      const sqVerts = new Float32Array(4 * 14);
      for (let i = 0; i < 4; i++) {
        const o = i * 14;
        sqVerts[o + 0] = sqPos[i * 3 + 0] ?? 0;
        sqVerts[o + 1] = sqPos[i * 3 + 1] ?? 0;
        sqVerts[o + 2] = sqPos[i * 3 + 2] ?? 0;
        sqVerts[o + 3] = sqNrm[i * 3 + 0] ?? 0;
        sqVerts[o + 4] = sqNrm[i * 3 + 1] ?? 0;
        sqVerts[o + 5] = sqNrm[i * 3 + 2] ?? 1;
        sqVerts[o + 6] = sqUv[i * 2 + 0] ?? 0;
        sqVerts[o + 7] = sqUv[i * 2 + 1] ?? 0;
        // skinIndex (2 floats = 4 u16 = 0) at o+8, o+9
        sqVerts[o + 10] = 1; // skinWeight.x = 1
      }
      const skinQuad: MeshAsset = {
        kind: 'mesh',
        vertices: sqVerts,
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        attributes: {
          position: sqPos,
          normal: sqNrm,
          uv: sqUv,
          skinIndex: sqIdx,
          skinWeight: sqWgt,
        },
        aabb: new Float32Array([-0.6, -0.6, -0.1, 0.6, 0.6, 0.1]),
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 6,
            vertexCount: 4,
            materialSlot: 0,
            topology: 'triangle-list',
          },
        ],
        materialSlots: [{ slotName: 'default' }],
      };
      const skinMeshHandle = assets.create(skinQuad).unwrap();
      const skeletonAsset: SkeletonAsset = {
        kind: 'skeleton',
        jointCount: 1,
        inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      };
      const skelHandle = assets.create(skeletonAsset).unwrap();

      const jointEntity = world
        .spawn({ component: Transform, data: { pos: [-1.4, 0, 0] } })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: skinMeshHandle } },
          { component: MeshRenderer, data: {} },
          { component: Skin, data: { skeleton: skelHandle, joints: [jointEntity] } },
        )
        .unwrap();

      // 2. 200-instance cube batch via ForgeAX `Instances` component
      const cubeHandle = assets.create(makeCubeMeshAsset()).unwrap();
      const instTransforms = new Float32Array(200 * 16);
      for (let i = 0; i < 200; i++) {
        const off = i * 16;
        instTransforms[off + 0] = 0.25;
        instTransforms[off + 5] = 0.25;
        instTransforms[off + 10] = 0.25;
        instTransforms[off + 12] = ((i % 20) - 9.5) * 0.4;
        instTransforms[off + 13] = -1.2;
        instTransforms[off + 14] = (Math.floor(i / 20) - 5) * 0.4;
        instTransforms[off + 15] = 1;
      }
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, -2] } },
          { component: MeshFilter, data: { assetHandle: cubeHandle } },
          { component: MeshRenderer, data: {} },
          { component: Instances, data: { transforms: instTransforms } },
        )
        .unwrap();

      const cam = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4.5] } },
          {
            component: Camera,
            data: {
              ...perspective({ fov: Math.PI / 3, aspect: 200 / 120, near: 0.1, far: 50 }),
              clearColor: new Float32Array([0.02, 0.02, 0.04, 1]),
            },
          },
        )
        .unwrap();
      setTransformLookAt(world, cam, [0, 0, 4.5], [0, 0, 0]).unwrap();
      world
        .spawn({
          component: DirectionalLight,
          data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 2.5 },
        })
        .unwrap();
      propagateTransforms(world);

      const desktop = createForgeaxDesktopNativeRenderer(world, assets, {
        headless: true,
      }).unwrap();
      try {
        const w1 = desktop.renderWitnessFrame(200, 120).unwrap();
        // 1 skinned quad + 200 hardware-instanced cubes = 201 objects folded into <= 3 draw calls!
        expect(desktop.getStats().unwrap().trackedObjects).toBe(201);
        expect(w1.receipt.submittedDrawCount).toBeLessThanOrEqual(3);
        const leftLum1 =
          (w1.image.pixels[(60 * 200 + 68) * 4] ?? 0) +
          (w1.image.pixels[(60 * 200 + 68) * 4 + 1] ?? 0);
        const rightLum1 =
          (w1.image.pixels[(60 * 200 + 132) * 4] ?? 0) +
          (w1.image.pixels[(60 * 200 + 132) * 4 + 1] ?? 0);
        expect(leftLum1).toBeGreaterThan(150);
        expect(rightLum1).toBeLessThan(70);

        // Move jointEntity from x=-1.4 to x=+1.4 and re-render
        world.set(jointEntity, Transform, { pos: [1.4, 0, 0] }).unwrap();
        propagateTransforms(world);
        const w2 = desktop.renderWitnessFrame(200, 120).unwrap();
        const leftLum2 =
          (w2.image.pixels[(60 * 200 + 68) * 4] ?? 0) +
          (w2.image.pixels[(60 * 200 + 68) * 4 + 1] ?? 0);
        const rightLum2 =
          (w2.image.pixels[(60 * 200 + 132) * 4] ?? 0) +
          (w2.image.pixels[(60 * 200 + 132) * 4 + 1] ?? 0);
        expect(leftLum2).toBeLessThan(70);
        expect(rightLum2).toBeGreaterThan(150);
      } finally {
        desktop.dispose();
      }
    });
  },
);
