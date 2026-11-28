#!/usr/bin/env node
// Real ForgeAX ECS World desktop 3D benchmark for ForgeaxDesktopNativeRenderer
// (dedicated Rust OS render thread + wgpu 30 Metal / DX12 / Vulkan).
//
// Workload:
//   - 1,001 live ECS entities: 1 ground plane + 1,000 3D cubes (Transform + GlobalTransform +
//     MeshFilter + MeshRenderer + ShadowParticipation)
//   - Orbiting perspective Camera + shadow-casting DirectionalLight + PointLight + SpotLight
//   - Continuous partial change: 5% (50 cubes) rotating/bobbing ECS Transform mutations +
//     propagateTransforms(world) every frame (zero static-frame shortcuts)
//   - 3-pass 4-BGL pipeline per frame: 1024x1024 Shadow Depth -> 1280x720 HDR Forward Lit/Shadow
//     -> Fullscreen ACES Tonemap (to native OS swapchain or offscreen in --headless)

import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { AssetRegistry } from '../../assets-runtime/dist/index.mjs';
import { World } from '../../ecs/dist/index.mjs';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  perspective,
  ShadowParticipation,
  SpotLight,
} from '../../render/dist/index.mjs';
import { isNativeRenderKernelAvailable } from '../../render-kernel/dist/desktop/index.mjs';
import { propagateTransforms, setTransformLookAt, Transform } from '../../scene/dist/index.mjs';
import { createForgeaxDesktopNativeRenderer } from '../dist/desktop-platform.mjs';

const args = new Set(process.argv.slice(2));
const headless = args.has('--headless') || process.env.FORGEAX_NATIVE_DESKTOP_HEADLESS === '1';
const framesArg = process.argv.find((a) => a.startsWith('--frames='));
const totalFrames = framesArg ? Math.max(30, Number(framesArg.split('=')[1])) : 140;
const cubesArg = process.argv.find((a) => a.startsWith('--cubes='));
const cubeCount = cubesArg ? Math.max(20, Number(cubesArg.split('=')[1])) : 1000;
const addonPathArg = process.argv.find((a) => a.startsWith('--addon='));
const addonPath = addonPathArg ? addonPathArg.slice('--addon='.length) : undefined;

if (!isNativeRenderKernelAvailable(addonPath)) {
  console.error(
    '[ecs-desktop-bench] Native RenderKernel addon not found. Build with: pnpm --filter @forgeax/engine-render-kernel build:native',
  );
  process.exit(1);
}

function makeCubeMeshAsset() {
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
  const uvs = [
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
    const base = f * 4;
    for (let i = 0; i < 4; i++) {
      position[vi * 3 + 0] = face.v[i][0];
      position[vi * 3 + 1] = face.v[i][1];
      position[vi * 3 + 2] = face.v[i][2];
      normal[vi * 3 + 0] = face.n[0];
      normal[vi * 3 + 1] = face.n[1];
      normal[vi * 3 + 2] = face.n[2];
      uv[vi * 2 + 0] = uvs[i][0];
      uv[vi * 2 + 1] = uvs[i][1];
      vertices[vi * 8 + 0] = face.v[i][0];
      vertices[vi * 8 + 1] = face.v[i][1];
      vertices[vi * 8 + 2] = face.v[i][2];
      vertices[vi * 8 + 3] = face.n[0];
      vertices[vi * 8 + 4] = face.n[1];
      vertices[vi * 8 + 5] = face.n[2];
      vertices[vi * 8 + 6] = uvs[i][0];
      vertices[vi * 8 + 7] = uvs[i][1];
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

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

const world = new World();
const assets = new AssetRegistry();
world.bindAssets(assets).unwrap();

const cubeHandle = assets.create(makeCubeMeshAsset()).unwrap();

// Ground plane
world
  .spawn(
    { component: Transform, data: { pos: [0, -0.5, 0], scale: [64, 1, 64] } },
    { component: MeshFilter, data: { assetHandle: cubeHandle } },
    { component: MeshRenderer, data: {} },
    { component: ShadowParticipation, data: { cast: false, receive: true } },
  )
  .unwrap();

// Grid of 3D cubes
const gridSide = Math.ceil(Math.sqrt(cubeCount));
const cubeEntities = [];
const cubeCoords = new Float32Array(cubeCount * 3);
for (let i = 0; i < cubeCount; i++) {
  const gx = (i % gridSide) - gridSide / 2;
  const gz = Math.floor(i / gridSide) - gridSide / 2;
  const y0 = 0.6 + (i % 3) * 0.35;
  cubeCoords[i * 3 + 0] = gx * 1.4;
  cubeCoords[i * 3 + 1] = y0;
  cubeCoords[i * 3 + 2] = gz * 1.4;
  const entity = world
    .spawn(
      {
        component: Transform,
        data: { pos: [gx * 1.4, y0, gz * 1.4], scale: [0.85, 1.2, 0.85] },
      },
      { component: MeshFilter, data: { assetHandle: cubeHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  cubeEntities.push(entity);
}

const camEntity = world
  .spawn(
    { component: Transform, data: { pos: [24, 14, 24] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.2, far: 180 }),
        clearColor: new Float32Array([0.05, 0.09, 0.17, 1]),
      },
    },
  )
  .unwrap();
setTransformLookAt(world, camEntity, [24, 14, 24], [0, 0.5, 0]).unwrap();

world
  .spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.55, -0.8, -0.45],
      color: [1.0, 0.97, 0.92],
      intensity: 2.4,
      castShadow: true,
      shadowDistance: 32,
    },
  })
  .unwrap();

world
  .spawn(
    { component: Transform, data: { pos: [10, 5, 10] } },
    { component: PointLight, data: { color: [0.3, 0.6, 1.0], intensity: 40, range: 28 } },
  )
  .unwrap();

world
  .spawn(
    { component: Transform, data: { pos: [-10, 6, -8] } },
    {
      component: SpotLight,
      data: {
        direction: [0.25, -1, 0.2],
        color: [1.0, 0.78, 0.35],
        intensity: 50,
        range: 30,
        outerConeDeg: 42,
      },
    },
  )
  .unwrap();

propagateTransforms(world);

const desktop = createForgeaxDesktopNativeRenderer(world, assets, {
  headless,
  maxInFlight: 2,
  shadowMapSize: 1024,
  ...(addonPath ? { addonPath } : {}),
  ...(headless
    ? {}
    : {
        window: {
          title: 'ForgeAX ECS -> NativeRenderKernel Desktop (wgpu 30)',
          width: 1280,
          height: 720,
        },
      }),
}).unwrap();

try {
  // 1. Deterministic pixel witness on live ECS World
  const witness = desktop.renderWitnessFrame(640, 360).unwrap();
  assert.equal(witness.receipt.executedPasses, 3);
  let nonSky = 0;
  let bright = 0;
  const skyR = witness.image.pixels[0];
  const skyG = witness.image.pixels[1];
  const skyB = witness.image.pixels[2];
  for (let i = 0; i < witness.image.pixels.length; i += 4) {
    const r = witness.image.pixels[i];
    const g = witness.image.pixels[i + 1];
    const b = witness.image.pixels[i + 2];
    if (Math.abs(r - skyR) + Math.abs(g - skyG) + Math.abs(b - skyB) > 15) nonSky++;
    if (r * 0.299 + g * 0.587 + b * 0.114 > 110) bright++;
  }
  assert(nonSky > 30000, `expected >30k rendered ECS pixels, got ${nonSky}`);
  assert(bright > 4000, `expected >4k lit ECS pixels, got ${bright}`);

  let surfaceWidth = 1280;
  let surfaceHeight = 720;
  if (!headless) {
    for (let i = 0; i < 10; i++) {
      desktop.pollWindowEvents().unwrap();
      await delay(10);
    }
    const [pw, ph] = desktop.getWindowPhysicalSize().unwrap();
    if (pw > 0 && ph > 0) {
      surfaceWidth = pw;
      surfaceHeight = ph;
    }
  }

  // 2. Continuous 5% partial-change ECS gameplay + render loop
  const editN = Math.max(1, Math.floor(cubeCount * 0.05));
  const ecsTimes = [];
  const renderSubmitTimes = [];
  const totalMainTimes = [];
  const wallStart = performance.now();

  for (let f = 0; f < totalFrames; f++) {
    if (!headless) {
      for (const ev of desktop.pollWindowEvents().unwrap()) {
        if (ev.kind === 'resized' && ev.width > 0 && ev.height > 0) {
          surfaceWidth = ev.width;
          surfaceHeight = ev.height;
        }
      }
    }

    const t0 = performance.now();
    const startIdx = (f * editN) % cubeCount;
    for (let k = 0; k < editN; k++) {
      const idx = (startIdx + k) % cubeCount;
      const entity = cubeEntities[idx];
      const cx = cubeCoords[idx * 3 + 0];
      const cy = cubeCoords[idx * 3 + 1] + Math.sin(f * 0.08 + k) * 0.3;
      const cz = cubeCoords[idx * 3 + 2];
      const half = (f * 0.05 + idx * 0.13) * 0.5;
      world
        .set(entity, Transform, {
          pos: [cx, cy, cz],
          quat: [0, Math.sin(half), 0, Math.cos(half)],
          scale: [0.85, 1.2, 0.85],
        })
        .unwrap();
    }
    const camAngle = 0.45 + f * 0.015;
    setTransformLookAt(
      world,
      camEntity,
      [Math.sin(camAngle) * 24, 14, Math.cos(camAngle) * 24],
      [0, 0.5, 0],
    ).unwrap();
    propagateTransforms(world);
    const t1 = performance.now();

    desktop.submitFrameAsync(surfaceWidth, surfaceHeight, 1 / 60).unwrap();
    const t2 = performance.now();

    if (f >= 20) {
      ecsTimes.push(t1 - t0);
      renderSubmitTimes.push(t2 - t1);
      totalMainTimes.push(t2 - t0);
    }
  }

  desktop.flush().unwrap();
  const wallElapsedMs = performance.now() - wallStart;
  const stats = desktop.getStats().unwrap();

  assert.equal(stats.thread.completedFrames, totalFrames + 1);
  assert.equal(stats.thread.inFlightFrames, 0);

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);

  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        mode: headless ? 'headless' : 'native-window',
        adapter: stats.thread.adapterName,
        backend: stats.thread.backendName,
        surfaceExtent: [surfaceWidth, surfaceHeight],
        ecsEntities: cubeCount + 1,
        rotatingEntitiesPerFrame: editN,
        passesPerFrame: 3,
        completedFrames: stats.thread.completedFrames,
        witnessNonSkyPixels: nonSky,
        witnessBrightPixels: bright,
        wallFps: +((totalFrames * 1000) / wallElapsedMs).toFixed(1),
        ecsPropagateP50Ms: +pct(ecsTimes, 0.5).toFixed(4),
        renderSubmitMainThreadP50Ms: +pct(renderSubmitTimes, 0.5).toFixed(4),
        renderSubmitMainThreadP95Ms: +pct(renderSubmitTimes, 0.95).toFixed(4),
        renderSubmitMainThreadMeanMs: +mean(renderSubmitTimes).toFixed(4),
        totalMainThreadP50Ms: +pct(totalMainTimes, 0.5).toFixed(4),
        totalMainThreadP95Ms: +pct(totalMainTimes, 0.95).toFixed(4),
        renderThreadAvgPlanUs: +(stats.thread.totalPlanUs / stats.thread.completedFrames).toFixed(1),
        renderThreadAvgEncodeSubmitUs: +(
          stats.thread.totalEncodeSubmitUs / stats.thread.completedFrames
        ).toFixed(1),
        dirtyRowsUploaded: stats.thread.dirtyRowsUploaded,
        dirtyRangeWrites: stats.thread.dirtyRangeWrites,
      },
      null,
      2,
    ),
  );
} finally {
  desktop.dispose();
  assets.release(cubeHandle).unwrap();
}
