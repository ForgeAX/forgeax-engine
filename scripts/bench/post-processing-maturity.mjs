#!/usr/bin/env node
// Production Renderer carrier. Run under /tmp/forgeax-physical-gpu.lock.
// Pass envelopes include gaps; they are not an outer query or an FPS claim.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { create, globals } from '@forgeax/engine-dawn-node';
import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera,
  CloudLayer,
  CloudQualityValue,
  createCloudLayerFeature,
  DepthOfField,
  DepthOfFieldQualityValue,
  DirectionalLight,
  Fog,
  LightProbe,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  ScreenSpaceReflection,
  TONEMAP_ACES_FILMIC,
  VolumetricFog,
  VolumetricFogSamplingValue,
} from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { createRenderer } from '@forgeax/engine-runtime';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { writeReferencePng } from '../../apps/shared/png-codec.mjs';
import {
  attachRecorder,
  buildFrameModel,
  buildResourceLifecycle,
  decodeTape,
  decodeToRgba8,
  halfToFloat,
  openReplay,
  replayDeviceRequest,
  tapeDigest,
} from '../../packages/rhi-debug/dist/index.mjs';
import * as webgpu from '../../packages/rhi-webgpu/dist/index.mjs';

const output = resolve(process.env.FORGEAX_POST_EVIDENCE ?? 'artifacts/post-processing-maturity');
mkdirSync(output, { recursive: true });
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
const identity = await gpu.requestAdapter();
assert.ok(identity, 'native adapter required');
const manifest = readFileSync('shared-build-inputs/shaders/manifest.json', 'utf8');
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const ssrIdentity = {
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  lockSha256: hashFile('pnpm-lock.yaml'),
  buildSha256: hashFile('packages/render/dist/index.mjs'),
};
const manifestUrl = `data:application/json,${encodeURIComponent(manifest)}`;
const value = (result) => {
  if (!result.ok) throw result.error;
  return result.value;
};
const p = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const stats = (values) => ({ p50: p(values, 0.5), p95: p(values, 0.95) });
const image = (name, rgba, width, height) =>
  writeFileSync(resolve(output, `${name}.png`), writeReferencePng(rgba, width, height));
const json = (name, data) =>
  writeFileSync(resolve(output, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);

// Reuse the timing owner's interval projection; never sum pass percentiles.
function intervals(frame) {
  const summary = value(
    summarizeGpuPassTimingIntervals(frame.passes, frame.timestampPeriodNanoseconds),
  );
  return Object.fromEntries(
    ['sum', 'union', 'envelope', 'overlap'].map((key) => [
      `${key}Ms`,
      summary[`${key}Nanoseconds`] / 1e6,
    ]),
  );
}

async function fixture(width, height, capture = false) {
  console.log(`[post-processing] initializing ${width}x${height} capture=${capture}`);
  let surface, surfaceDevice, surfaceFormat;
  const canvas = {
    width,
    height,
    getContext: () => ({
      configure(desc) {
        surfaceDevice = desc.device;
        surfaceFormat = desc.format;
      },
      unconfigure() {},
      getCurrentTexture() {
        surface ??= surfaceDevice.createTexture({
          size: [width, height],
          format: surfaceFormat,
          usage: 0x11,
          viewFormats: [surfaceFormat === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
        return surface;
      },
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  const recorder = capture ? value(attachRecorder(webgpu)) : undefined;
  const renderer = value(
    await createRenderer(
      canvas,
      {
        ...(recorder ? { rhi: recorder.backend.rhi } : {}),
        features: [createCloudLayerFeature()],
        ssrIdentity,
        gpuPassTiming: { maxPassesPerFrame: 128, maxFramesInFlight: 2, retentionFrames: 8 },
      },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  console.log(`[post-processing] renderer ready ${width}x${height}`);
  const world = new World();
  const lease = value(renderer.attach(world));
  const profile = {
    ...renderer.inspect().profile,
    renderPath: 'deferred',
    ibl: false,
  };
  value(renderer.setProfile(profile));
  const spawnMesh = (position, scale, material, mesh = HANDLE_CUBE) =>
    value(
      world.spawn(
        { component: Transform, data: { pos: position, scale } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        {
          component: MeshRenderer,
          data: { materials: [world.allocSharedRef('MaterialAsset', material)] },
        },
      ),
    );
  spawnMesh(
    [0, -1, -2],
    [12, 0.1, 20],
    Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.2, metallic: 0.1 }),
  );
  spawnMesh(
    [-1, 0, -2],
    [1.4, 2, 1.4],
    Materials.standard({ baseColor: [0.65, 0.12, 0.04, 1], roughness: 0.5, metallic: 0 }),
  );
  spawnMesh(
    [1.5, 0.3, -5],
    [1, 2.5, 1],
    Materials.standard({ baseColor: [0.04, 0.2, 0.6, 1], roughness: 0.6, metallic: 0 }),
  );
  spawnMesh(
    [-0.2, 0.1, 1],
    [0.05, 2, 0.05],
    Materials.standard({ baseColor: [0.05, 0.7, 0.1, 1], roughness: 0.6, metallic: 0 }),
  );
  spawnMesh(
    [1.1, 1, -3],
    [0.15, 0.15, 0.15],
    Materials.standard({
      baseColor: [0, 0, 0, 1],
      emissive: [12, 6, 2],
      roughness: 1,
      metallic: 0,
    }),
    HANDLE_SPHERE,
  );
  spawnMesh(
    [0.6, 0.3, 0.2],
    [1, 1.7, 0.05],
    Materials.standard({
      baseColor: [0.2, 0.1, 0.8, 0.35],
      roughness: 0.6,
      metallic: 0,
      renderState: {
        depthWriteEnabled: false,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      },
    }),
  );
  const sun = value(
    world.spawn(
      { component: Transform, data: {} },
      {
        component: DirectionalLight,
        data: {
          direction: [-0.5, -0.8, -0.3],
          color: [1, 0.9, 0.8],
          intensity: 2,
          castShadow: false,
        },
      },
    ),
  );
  value(
    world.spawn(
      { component: Transform, data: { pos: [0, 0, -2] } },
      {
        component: LightProbe,
        data: {
          radius: 50,
          irradiance: new Float32Array([1, 1, 1, ...new Array(24).fill(0)]),
        },
      },
    ),
  );
  const point = value(
    world.spawn(
      { component: Transform, data: { pos: [0, 1, 2] } },
      {
        component: PointLight,
        data: {
          intensity: 3,
          range: 20,
          color: [1, 0.4, 0.1],
        },
      },
    ),
  );
  const camera = value(
    world.spawn(
      { component: Transform, data: { pos: [0, 1, 6] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: width / height,
          near: 0.1,
          far: 200,
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_ACES_FILMIC,
          exposure: 1,
          bloom: BLOOM_DISABLED,
          clearColor: [0.05, 0.1, 0.2, 1],
        },
      },
    ),
  );
  const density = world.allocSharedRef('TextureAsset', {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 8, height: 8, depth: 8 } },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(512).fill(128),
  });
  let cloud,
    analytic,
    volumes = [];
  function configure(config) {
    value(
      renderer.setProfile({
        ...profile,
        ssao: config.ao
          ? {
              algorithm: 'gtao',
              quality: config.quality ?? 'medium',
              radius: 0.6,
              intensity: 1,
              bias: 0.025,
            }
          : false,
        volumetricFog:
          config.fogQuality === 'high'
            ? { quality: 'high', depth: 64, tileSize: 4 }
            : { quality: 'low', depth: 48, tileSize: 16 },
      }),
    );
    value(
      world.set(camera, Camera, {
        bloom: config.bloom ? BLOOM_ENABLED : BLOOM_DISABLED,
        antialias: config.taa ? ANTIALIAS_TAA : ANTIALIAS_NONE,
      }),
    );
    if (world.hasComponent(camera, DepthOfField))
      value(world.removeComponent(camera, DepthOfField));
    if (config.dof)
      value(
        world.addComponent(camera, {
          component: DepthOfField,
          data: {
            focusDistance: 8,
            fStop: 1.4,
            maxRadiusPixels: 16,
            quality: DepthOfFieldQualityValue[config.quality ?? 'medium'],
          },
        }),
      );
    if (world.hasComponent(camera, ScreenSpaceReflection))
      value(world.removeComponent(camera, ScreenSpaceReflection));
    if (config.ssr)
      value(world.addComponent(camera, { component: ScreenSpaceReflection, data: {} }));
    if (cloud) {
      value(world.despawn(cloud));
      cloud = undefined;
    }
    if (config.cloud)
      cloud = value(
        world.spawn({
          component: CloudLayer,
          data: {
            baseHeight: 2,
            thickness: 3,
            scale: 0.15,
            coverage: 0.7,
            density: 0.4,
            wind: config.wind ?? [0, 0, 0],
            quality: CloudQualityValue[config.quality ?? 'medium'],
            shadowRange: 100,
          },
        }),
      );
    if (analytic) {
      value(world.despawn(analytic));
      analytic = undefined;
    }
    if (config.analytic)
      analytic = value(
        world.spawn({ component: Fog, data: { density: 0.025, color: [0.2, 0.3, 0.5] } }),
      );
    for (const owner of volumes) value(world.despawn(owner));
    volumes = [];
    for (let i = 0; i < (config.owners ?? (config.volume ? 1 : 0)); i++)
      volumes.push(
        value(
          world.spawn({
            component: VolumetricFog,
            data: {
              light: config.sunVolume ? sun : point,
              density,
              sampling: VolumetricFogSamplingValue.density,
              boundsMin: [-4 + i * 0.25, -2, -8],
              boundsMax: [4 + i * 0.25, 5, 5],
              extinction: [0.03, 0.03, 0.03],
              albedo: [0.8, 0.8, 0.8],
              emission: [0, 0, 0],
              maxDistance: 30,
            },
          }),
        ),
      );
  }
  async function draw(read = false) {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    if (read) value(renderer.requestObservation(['linear-hdr', 'final-display']));
    const start = performance.now();
    const receipt = value(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    const cpuMs = performance.now() - start;
    value(await receipt.completed);
    const latencyMs = performance.now() - start;
    const observed = value(
      await renderer.observe(receipt, {
        include: read ? ['timings', 'linear-hdr', 'final-display'] : ['timings'],
      }),
    );
    assert.equal(
      observed.timings?.status,
      'complete',
      'every sampled pass requires real timestamps',
    );
    return {
      cpuMs,
      latencyMs,
      ...intervals(observed.timings.frame),
      timing: observed.timings.frame,
      ...(read ? { observations: observed.observations } : {}),
    };
  }
  async function snapshot(name) {
    const frame = await draw(true);
    const read = frame.observations.find((row) => row.domain === 'final-display');
    assert.ok(read);
    const { width: w, height: h, format, bytesPerRow } = read.metadata;
    const bytes = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      bytes.set(read.bytes.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
    const rgba = decodeToRgba8(bytes, format, w, h);
    image(name, rgba, w, h);
    json(`${name}-inspection`, renderer.inspect());
    return rgba;
  }
  async function captureFrame(name) {
    assert.ok(recorder);
    const pending = recorder.captureFrame();
    value(await recorder.frameBoundary());
    const live = await draw(true);
    const hdr = live.observations.find((row) => row.domain === 'linear-hdr');
    assert.ok(hdr);
    assert.equal(hdr.metadata.format, 'rgba16float');
    const hdrView = new DataView(hdr.bytes.buffer, hdr.bytes.byteOffset, hdr.bytes.byteLength);
    let hdrMax = 0;
    for (let y = 0; y < hdr.metadata.height; y++)
      for (let x = 0; x < hdr.metadata.width; x++) {
        for (let c = 0; c < 3; c++) {
          const sample = halfToFloat(
            hdrView.getUint16(y * hdr.metadata.bytesPerRow + x * 8 + c * 2, true),
          );
          assert.ok(Number.isFinite(sample), 'combined linear HDR must remain finite');
          hdrMax = Math.max(hdrMax, sample);
        }
      }
    assert.ok(
      hdrMax > 1,
      'emissive HDR highlight must survive cloud/fog/blend before tone mapping',
    );
    writeFileSync(resolve(output, `${name}-linear-hdr.rgba16`), hdr.bytes);
    value(await recorder.frameBoundary());
    const captured = value(await pending);
    writeFileSync(resolve(output, `${name}.rhitape`), captured.bytes);
    const tape = value(decodeTape(captured.bytes));
    const model = buildFrameModel(tape);
    const lifecycle = buildResourceLifecycle(tape);
    const cloudTextures = model.resources.filter(
      (resource) =>
        resource.kind === 'texture' &&
        /^cloud-history-(radiance|transmittance|depth)-[ab]$/.test(
          resource.descriptor?.desc?.label ?? '',
        ) &&
        resource.lifecycle.state === 'live',
    );
    assert.equal(cloudTextures.length, 6, 'one active cloud ping-pong MRT required');
    const cloudHistoryBytes = cloudTextures.reduce((sum, resource) => {
      assert.equal(resource.lifecycle.byteEstimate.status, 'known');
      return sum + resource.lifecycle.byteEstimate.bytes;
    }, 0);
    const cloudFacts = Object.values(renderer.inspect().cloudLayer).find(
      (row) => row.status === 'available',
    ).resourceFacts;
    assert.equal(
      cloudFacts.declaredHistoryBytes,
      cloudHistoryBytes,
      'cloud inspection must match the six actual recorded half-resolution texture descriptors',
    );
    const cloudWork = model.works.find((work) =>
      work.pipeline.shaders.some((shader) => shader.source?.includes('struct CloudResolveParams')),
    );
    const adapter = value(await webgpu.rhi.requestAdapter());
    const replayDevice = value(
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits)),
    );
    const replay = value(
      await openReplay(tape, {
        device: replayDevice,
        createShaderModule: webgpu.createShaderModule,
      }),
    );
    const works = [];
    let finalReplay;
    try {
      const selected = model.works
        .filter((work) => work.kind === 'draw')
        .filter(
          (work) =>
            work === cloudWork ||
            work.pipeline.shaders.some((shader) =>
              /DepthOfFieldParams|BloomCompositeParams|analytic_fog/.test(shader.source ?? ''),
            ),
        );
      for (const work of selected) {
        const inspected = value(
          await replay.inspectWork(work.workIndex, ['pipeline', 'bindings', 'pixels']),
        );
        works.push({
          workIndex: work.workIndex,
          entryPoints: work.pipeline.shaders.map((shader) => shader.entryPoint),
          bindings: inspected.bindings,
          attachment: inspected.attachment && {
            format: inspected.attachment.format,
            width: inspected.attachment.width,
            height: inspected.attachment.height,
          },
        });
        if (inspected.attachment) {
          const a = inspected.attachment;
          image(
            `${name}-work-${work.workIndex}`,
            decodeToRgba8(a.bytes, a.format, a.width, a.height),
            a.width,
            a.height,
          );
        }
      }
      const finalWork = model.works.findLast(
        (work) =>
          (work.kind === 'draw' || work.kind === 'draw-indexed') &&
          work.attachments.colorViewHandleIds.length > 0,
      );
      assert.ok(finalWork, 'final display writer required');
      const attachment = value(
        await replay.inspectWork(finalWork.workIndex, ['pixels']),
      ).attachment;
      assert.ok(attachment, 'fresh replay final attachment required');
      const observed = live.observations.find((row) => row.domain === 'final-display');
      assert.ok(observed);
      const tight = new Uint8Array(observed.metadata.width * observed.metadata.height * 4);
      for (let y = 0; y < observed.metadata.height; y++)
        tight.set(
          observed.bytes.subarray(
            y * observed.metadata.bytesPerRow,
            y * observed.metadata.bytesPerRow + observed.metadata.width * 4,
          ),
          y * observed.metadata.width * 4,
        );
      const livePixels = decodeToRgba8(
        tight,
        observed.metadata.format,
        observed.metadata.width,
        observed.metadata.height,
      );
      const replayPixels = decodeToRgba8(
        attachment.bytes,
        attachment.format,
        attachment.width,
        attachment.height,
      );
      assert.equal(replayPixels.length, livePixels.length);
      let maxDelta = 0;
      for (let i = 0; i < livePixels.length; i++)
        maxDelta = Math.max(maxDelta, Math.abs(livePixels[i] - replayPixels[i]));
      // Same-device fresh replay retains the ordinary pixel-smoke epsilon.
      assert.ok(maxDelta / 255 <= 0.05, `final replay delta ${maxDelta}/255 exceeds 0.05`);
      image(`${name}-replay`, replayPixels, attachment.width, attachment.height);
      image(`${name}-capture-live`, livePixels, observed.metadata.width, observed.metadata.height);
      finalReplay = { workIndex: finalWork.workIndex, maxDelta, epsilon: 0.05 };
    } finally {
      value(await replay.dispose());
    }
    json(`${name}-rhi`, {
      digest: tapeDigest(captured.bytes),
      unseeded: model.unseededResources,
      lifecycle,
      cloudHistoryBytes,
      finalReplay,
      hdr: { ...hdr.metadata, maxRgb: hdrMax },
      works,
      roster: model.works.map((work) => ({
        index: work.workIndex,
        kind: work.kind,
        entryPoints: work.pipeline.shaders.map((shader) => shader.entryPoint),
      })),
    });
  }
  return {
    configure,
    draw,
    snapshot,
    captureFrame,
    renderer,
    world,
    camera,
    setSunIntensity(intensity) {
      value(world.set(sun, DirectionalLight, { intensity }));
    },
    resize(nextWidth, nextHeight) {
      // The host releases only its completed offscreen surface; Renderer owns
      // graph/history resize from the next canvas extent.
      surface?.destroy();
      surface = undefined;
      width = canvas.width = nextWidth;
      height = canvas.height = nextHeight;
      value(world.set(camera, Camera, { aspect: width / height }));
    },
    assertAdmission(config) {
      const state = renderer.inspect();
      if (config.ao) assert.ok(state.perFramePassNames.includes('ssao-calc'));
      if (config.dof) assert.equal(state.depthOfField.status, 'active');
      if (config.bloom) assert.equal(state.bloom.state, 'active');
      if (config.cloud)
        assert.ok(Object.values(state.cloudLayer).some((row) => row.status === 'available'));
      if (config.volume || config.owners) {
        assert.equal(state.volumetricFog.status, 'available');
        assert.equal(state.volumetricFog.ownerCount, config.owners ?? 1);
      }
      if (config.analytic) assert.ok(state.perFramePassNames.includes('analytic-fog'));
      if (config.taa) assert.equal(state.temporal.mode, 'taa');
      if (config.ssr) {
        assert.notEqual(state.ssr.status, 'fallback-only', JSON.stringify(state.ssr.failure));
        assert.ok(state.ssr.passRoster.length > 0, 'SSR must execute real work');
      }
    },
    async dispose() {
      value(await renderer.dispose());
      surface?.destroy();
      if (recorder) value(await recorder.dispose());
    },
  };
}

const evidence = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  identity: {
    ...ssrIdentity,
    shaderManifestSha256: hashFile('shared-build-inputs/shaders/manifest.json'),
    hostPlatform: process.platform,
    hostArchitecture: process.arch,
    nodeVersion: process.version,
  },
  adapter: {
    info: {
      vendor: identity.info?.vendor,
      architecture: identity.info?.architecture,
      device: identity.info?.device,
      description: identity.info?.description,
    },
    features: [...identity.features],
  },
  method: {
    warmup: 32,
    sampleWindow: 60,
    order: 'ABBA: off,on,on,off',
    gpuMetric:
      'all submitted measured pass interval envelope; raw ticks retained; no portable native outer query',
    cpuMetric: 'synchronous Renderer.draw only; completion latency separate',
    resources:
      'accepted descriptor-derived resident bytes in inspection; not driver allocator peaks',
    budgets: {
      envelopeP95Ms: 16.67,
      source: '60 Hz frame target; diagnostic envelope budget, not full-frame certification',
    },
  },
  results: [],
};
const all = {
  ao: true,
  dof: true,
  bloom: true,
  cloud: true,
  volume: true,
  analytic: true,
  taa: true,
  ssr: true,
};
const captureOnly = process.argv.includes('--capture');
if (process.argv.includes('--quality')) {
  const f = await fixture(320, 180, true);
  const config = { cloud: true };
  const delta = (a, b) => {
    assert.equal(a.length, b.length);
    let total = 0,
      max = 0;
    // Cloud sky ROI excludes the ground, objects and blend pane.
    const roiPixels = 320 * 35;
    for (let i = 0; i < roiPixels; i++)
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[i * 4 + c] - b[i * 4 + c]);
        total += d;
        max = Math.max(max, d);
      }
    return { mean: total / (roiPixels * 3 * 255), max: max / 255 };
  };
  const warm = async () => {
    for (let i = 0; i < 32; i++) await f.draw();
  };
  try {
    f.configure(config);
    await warm();
    f.assertAdmission(config);
    const baseline = await f.snapshot('cloud-stationary');
    const stationary = [];
    for (let i = 0; i < 16; i++)
      stationary.push(delta(baseline, await f.snapshot(`cloud-stable-${i}`)));
    // Reuse the existing fog stability RGB tolerance for a static medium.
    assert.ok(
      stationary.every((row) => row.mean <= 0.005),
      JSON.stringify(stationary),
    );
    f.setSunIntensity(0);
    await warm();
    const lightingSignal = delta(baseline, await f.snapshot('cloud-unlit'));
    assert.ok(lightingSignal.mean > 0.005, 'zero-light control must remove cloud illumination');
    f.setSunIntensity(2);
    await warm();
    const lightRestored = delta(baseline, await f.snapshot('cloud-light-restored'));
    assert.ok(lightRestored.mean <= 0.005, JSON.stringify(lightRestored));
    value(f.world.set(f.camera, Transform, { pos: [2, 1, 6] }));
    value(f.world.set(f.camera, Camera, { historyVersion: 1 }));
    await f.snapshot('cloud-cut-first');
    const cutInspection = f.renderer.inspect();
    await warm();
    await f.snapshot('cloud-cut-converged');
    value(f.world.set(f.camera, Transform, { pos: [0, 1, 6] }));
    value(f.world.set(f.camera, Camera, { historyVersion: 2 }));
    await warm();
    const cutRestored = delta(baseline, await f.snapshot('cloud-cut-restored'));
    assert.ok(cutRestored.mean <= 0.005, JSON.stringify(cutRestored));
    f.resize(321, 181);
    await f.snapshot('cloud-resize-first');
    const resizeInspection = f.renderer.inspect();
    await warm();
    await f.snapshot('cloud-resize-converged');
    f.resize(320, 180);
    await warm();
    const resizeRestored = delta(baseline, await f.snapshot('cloud-resize-restored'));
    assert.ok(resizeRestored.mean <= 0.005, JSON.stringify(resizeRestored));
    json('cloud-quality', {
      stationary,
      lightingSignal,
      lightRestored,
      cutRestored,
      resizeRestored,
      cutInspection,
      resizeInspection,
      tolerance: 0.005,
      toleranceSource: 'existing volumetric-fog-stability browser static-medium RGB oracle',
    });
    f.configure({ ...all, wind: [500, 0, 0] });
    await warm();
    f.assertAdmission(all);
    await f.snapshot('combined-live');
    await f.captureFrame('combined');
  } finally {
    await f.dispose();
  }
} else if (captureOnly) {
  const f = await fixture(320, 180, true);
  try {
    f.configure({ ...all, wind: [500, 0, 0] });
    for (let i = 0; i < 32; i++) await f.draw();
    f.assertAdmission(all);
    await f.snapshot('combined-live');
    await f.captureFrame('combined');
  } finally {
    await f.dispose();
  }
} else {
  const resolutions = process.argv.includes('--quick')
    ? [[320, 180]]
    : [
        [1920, 1080],
        [2560, 1440],
        [3840, 2160],
      ];
  for (const [width, height] of resolutions) {
    const f = await fixture(width, height);
    try {
      const cases = [
        ['bloom', { bloom: true }],
        ...['low', 'medium', 'high'].flatMap((quality) => [
          [`gtao-${quality}`, { ao: true, quality }],
          [`dof-${quality}`, { dof: true, quality }],
          [`cloud-${quality}`, { cloud: true, quality }],
        ]),
        ['volume-1', { volume: true }],
        ['volume-8', { owners: 8 }],
        ['volume-high', { volume: true, fogQuality: 'high' }],
        ['combined', all],
      ];
      for (const [name, config] of cases) {
        const blocks = [];
        try {
          for (const [block, active] of [false, true, true, false].entries()) {
            f.configure(active ? config : {});
            for (let i = 0; i < 32; i++) await f.draw();
            f.assertAdmission(active ? config : {});
            const rows = [];
            for (let i = 0; i < 60; i++) rows.push(await f.draw());
            blocks.push({
              block,
              active,
              rows,
              inspection: f.renderer.inspect(),
              summary: Object.fromEntries(
                ['cpuMs', 'latencyMs', 'sumMs', 'unionMs', 'envelopeMs', 'overlapMs'].map((key) => [
                  key,
                  stats(rows.map((row) => row[key])),
                ]),
              ),
            });
            if (block === 1 && (width === 1920 || process.argv.includes('--quick')))
              await f.snapshot(`${name}-${width}x${height}`);
          }
          const on = blocks.filter((block) => block.active).flatMap((block) => block.rows);
          const off = blocks.filter((block) => !block.active).flatMap((block) => block.rows);
          evidence.results.push({
            name,
            width,
            height,
            config,
            status: 'measured',
            blocks,
            on: stats(on.map((row) => row.envelopeMs)),
            off: stats(off.map((row) => row.envelopeMs)),
            deltaP50Ms:
              p(
                on.map((row) => row.envelopeMs),
                0.5,
              ) -
              p(
                off.map((row) => row.envelopeMs),
                0.5,
              ),
            envelopeWithin16_67ms:
              p(
                on.map((row) => row.envelopeMs),
                0.95,
              ) <= 16.67,
          });
        } catch (error) {
          evidence.results.push({
            name,
            width,
            height,
            config,
            status: 'failed',
            error: { code: error.code, detail: error.detail, message: error.message },
            blocks,
          });
        }
        json('performance', evidence);
        console.log(
          `[post-processing] ${name} ${width}x${height} ${evidence.results.at(-1).status}`,
        );
      }
    } finally {
      await f.dispose();
    }
  }
}
json('performance', evidence);
// Dawn's process-global GPU instance remains live after Renderer disposal.
// All Renderer/replay resources have been released before ending this carrier.
delete globalThis.navigator.gpu;
process.exit(evidence.results.some((result) => result.status === 'failed') ? 1 : 0);
