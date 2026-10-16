import { decodeCatalogWire } from '@forgeax/engine-pack';
// Node/Dawn harness shared by the hello-gi smoke and the reference tool. The
// Renderer consumes ordinary cooked material publications (the same
// createMaterialPackCooker the Pack plugin uses) and the scene table in
// src/scenes.ts; nothing here owns render passes.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';

export const appRoot = fileURLToPath(new URL('..', import.meta.url));
export const monorepoRoot = resolve(appRoot, '..', '..', '..');
export const shaderSourceDir = resolve(monorepoRoot, 'packages/shader/src');

/**
 * Install the Node `navigator.gpu`: dawn.node by default, or the native wgpu GPU with
 * hardware Ray Query when `FORGEAX_WEBGPU_NODE=wgpu-native`
 * (`FORGEAX_WGPU_NATIVE_RAY_QUERY=off` withholds Ray Query on that same device).
 */
export async function installDawn() {
  if (process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native') {
    const { installNavigatorGpu } = await import('@forgeax/engine-rhi-wgpu-native');
    return installNavigatorGpu().unwrap();
  }
  const { create, globals } = await import('@forgeax/engine-dawn-node');
  Object.assign(globalThis, globals);
  if (!globalThis.navigator)
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
  const gpu = create([]);
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
  return gpu;
}

/** Cook every GI material, plus caller `extra` name -> MaterialAsset sources,
 * through the production Pack cooker and loader gate. `rasterOnly` names skip the
 * ray-hit program the reference tracer needs (materials no ray context admits). */
export async function cookGiMaterials(extra = {}, rasterOnly = []) {
  const { createMaterialPackCooker } = await import('@forgeax/engine-shader-compiler');
  const { normaliseForPack } = await import('@forgeax/engine-import');
  const { validateCookedMaterialRecord } = await import('@forgeax/engine-pack');
  const {
    createMaterialLoader,
    materialParametersToParamSchema,
    projectMaterialRecord,
    selectMaterialPassProgram,
  } = await import('@forgeax/engine-assets-runtime');
  const { rayMaterialContract } = await import('@forgeax/engine-shader');
  const { giMaterialAsset } = await import('../src/materials.ts');
  const { GI_MATERIAL_NAMES } = await import('../src/scenes.ts');
  const cooker = createMaterialPackCooker([shaderSourceDir]);
  const cooked = new Map();
  const sources = [
    ...GI_MATERIAL_NAMES.map((name) => [name, giMaterialAsset(name)]),
    ...Object.entries(extra),
  ];
  for (const [name, source] of sources) {
    const draft = await cooker.cook({ guid: name, source });
    const record = validateCookedMaterialRecord(
      JSON.parse(JSON.stringify(normaliseForPack(draft.payload.cooked))),
    ).unwrap();
    const ready = await createMaterialLoader({
      loadPublication: async () => ({ guid: name, record, artifacts: draft.artifacts }),
    }).load({ guid: name, specializationKey: record.specializationKey ?? '' });
    if (ready.status !== 'Ready')
      throw new Error(`material ${name} publication failed: ${JSON.stringify(ready)}`);
    const [first, ...rest] = ready.record.resolved.passes;
    const asset = { ...source, ...ready.record.resolved, passes: [first, ...rest] };
    if (rasterOnly.includes(name)) {
      cooked.set(name, { source, ready, asset });
      continue;
    }
    const selected = selectMaterialPassProgram(projectMaterialRecord(ready.record), 'forward', {
      backend: 'webgpu',
      capability: 'storage-buffer',
      pipeline: 'ray',
      geometry: 'mesh',
      pass: 'ray-hit',
      profile: 'forgeax-material-ray-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    });
    const artifact = ready.record.programs.find(
      (program) => program.specializationKey === selected.specializationKey,
    )?.artifact;
    if (artifact === undefined) throw new Error(`material ${name} has no ray-hit artifact`);
    cooked.set(name, {
      source,
      ready,
      asset,
      // The reference path tracer consumes the same cooked ray-hit program the GI lane uses.
      program: {
        context: 'ray-hit',
        wgsl: new TextDecoder().decode(artifact.bytes),
        paramSchema: materialParametersToParamSchema(ready.record.parameterContract.parameters, name),
        contract: rayMaterialContract(asset),
        sourceClosureDigest: ready.record.receipt.identity.sourceClosureDigest,
      },
    });
  }
  return cooked;
}

/** A mock WebGPU canvas whose presentation texture is readable by the caller. */
export function createCanvas(width, height, onDevice = () => {}) {
  let native;
  let surface;
  let format = 'rgba8unorm';
  const make = () => {
    surface?.destroy();
    surface = native.createTexture({
      size: [canvas.width, canvas.height],
      format,
      viewFormats: [format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
      usage: 0x11,
    });
  };
  const canvas = {
    width,
    height,
    getContext: (kind) =>
      kind !== 'webgpu'
        ? null
        : {
            configure(config) {
              native = config.device;
              format = config.format;
              onDevice(native);
              make();
            },
            unconfigure() {},
            getCurrentTexture() {
              if (surface?.width !== canvas.width || surface?.height !== canvas.height) make();
              return surface;
            },
          },
    addEventListener() {},
    removeEventListener() {},
    native: () => native,
    surface: () => surface,
    destroy() {
      surface?.destroy();
    },
  };
  return canvas;
}

let manifestUrl;
export async function engineManifestUrl() {
  if (manifestUrl) return manifestUrl;
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  manifestUrl = URL.createObjectURL(
    new Blob([JSON.stringify(await buildEngineShaderManifest({ pointShadows: true }))], {
      type: 'application/json',
    }),
  );
  process.once('exit', () => URL.revokeObjectURL(manifestUrl));
  return manifestUrl;
}

const halfTable = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  halfTable[h] =
    e === 0
      ? s * 2 ** -14 * (f / 1024)
      : e === 31
        ? f
          ? Number.NaN
          : s * Number.POSITIVE_INFINITY
        : s * 2 ** (e - 15) * (1 + f / 1024);
}

/** rgba16float observation rows to a tightly packed RGB Float32Array. */
export function hdrToRgb(observation, width, height) {
  const view = new DataView(
    observation.bytes.buffer,
    observation.bytes.byteOffset,
    observation.bytes.byteLength,
  );
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * observation.metadata.bytesPerRow + x * 8;
      for (let c = 0; c < 3; c++)
        out[(y * width + x) * 3 + c] = halfTable[view.getUint16(offset + c * 2, true)];
    }
  return out;
}

/**
 * One ordinary Renderer over a procedural or caller-spawned World. With
 * `capture`, the RHI Debug recorder wraps the backend exactly as App does for
 * FORGEAX_ENGINE_RHI_DEBUG=1, and `recorder` drives one-frame tapes. `onDevice` sees the
 * native device at canvas configuration, before the Renderer allocates resources.
 */
export async function createGiRenderer({
  width,
  height,
  timing = false,
  capture = false,
  maxPasses = 2048,
  onDevice = () => {},
}) {
  const { constructRuntimeRendererHost } = await import(
    '@forgeax/engine-runtime/internal/renderer-host'
  );
  const errors = [];
  const canvas = createCanvas(width, height, (device) => {
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    onDevice(device);
  });
  let recorder;
  const rhiOptions = {};
  if (capture) {
    const webgpu = await import('@forgeax/engine-rhi-webgpu');
    const { attachRecorder } = await import('@forgeax/engine-rhi-debug');
    recorder = attachRecorder({
      rhi: webgpu.rhi,
      createShaderModule: webgpu.createShaderModule,
      createShaderModuleImmediate: webgpu.createShaderModuleImmediate,
    }).unwrap();
    rhiOptions.rhi = recorder.backend.rhi;
    rhiOptions.rhiInstrumentation = {
      resolveSurfaceDevice: (device) => recorder.backend.unwrapDeviceForSurface(device),
      onFrameBoundary: () => void recorder.frameBoundary(),
      onDeviceLost: () => recorder.deviceLost(),
    };
  }
  const constructed = await constructRuntimeRendererHost(
    canvas,
    {
      ...rhiOptions,
      ...(timing ? { gpuPassTiming: { maxPassesPerFrame: maxPasses } } : {}),
    },
    { shaderManifestUrl: await engineManifestUrl() },
  );
  if (!constructed.ok)
    throw new Error(`renderer bootstrap failed: ${JSON.stringify(constructed.error)}`);
  const { renderer, assets } = constructed.value;
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  return { renderer, assets, canvas, errors, recorder };
}

/** Read the presentation texture the last frame wrote, tightly packed RGBA8. */
export async function readSurface(canvas) {
  const device = canvas.native();
  const surface = canvas.surface();
  const { width, height } = surface;
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 9 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: surface }, { buffer, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(1);
  const mapped = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  buffer.unmap();
  buffer.destroy();
  return { width, height, format: surface.format, bytes: out };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[sorted.length >> 1];
};

/** Per-pass GPU milliseconds, median across the observed GI frames. */
export function summarizeTimings(frames) {
  const complete = frames.filter((t) => t?.status === 'complete' || t?.status === 'partial');
  const diagnostics = frames.filter((t) => t?.status !== 'complete' && t?.status !== 'partial');
  if (complete.length === 0)
    return { status: frames.at(-1)?.status ?? 'missing', diagnostics };
  const byPass = new Map();
  for (const timing of complete)
    for (const pass of timing.frame.passes) {
      if (pass.status !== 'measured') continue;
      const list = byPass.get(pass.passName) ?? [];
      list.push(pass.durationNanoseconds / 1e6);
      byPass.set(pass.passName, list);
    }
  const passes = [...byPass].map(([name, ms]) => ({ name, ms: median(ms), frames: ms.length }));
  const isGi = (name) =>
    /ray|diffuse-gi|diffuse_gi|irradiance|probe|reconstruct|baked-field/i.test(name);
  const intervals = complete.map(({ frame }) => {
    const summary = (passes) => {
      const result = summarizeGpuPassTimingIntervals(passes, frame.timestampPeriodNanoseconds);
      if (!result.ok) throw new Error(`invalid GPU intervals: ${JSON.stringify(result.error)}`);
      return result.value;
    };
    return {
      frameId: frame.frameId,
      all: summary(frame.passes),
      gi: summary(frame.passes.filter((pass) => isGi(pass.passName))),
      timestampPeriodNanoseconds: frame.timestampPeriodNanoseconds,
      passes: frame.passes,
    };
  });
  const medianIntervals = (key) => Object.fromEntries(
    ['sumNanoseconds', 'unionNanoseconds', 'overlapNanoseconds', 'envelopeNanoseconds'].map(
      (field) => [field, median(intervals.map((row) => row[key][field]))],
    ),
  );
  return {
    status: diagnostics.some((t) => t?.status === 'failed') ? 'failed'
      : diagnostics.length > 0 || complete.some((t) => t.status === 'partial') ? 'partial' : 'complete',
    diagnostics,
    frames: complete.length,
    intervalSemantics: 'coverage and envelopes; not exclusive feature cost or native outer duration',
    intervals: { all: medianIntervals('all'), gi: medianIntervals('gi') },
    rawFrames: intervals,
    totalMs: median(complete.map((t) => t.frame.measuredPassNanoseconds / 1e6)),
    giMs: passes.filter((p) => isGi(p.name)).reduce((s, p) => s + p.ms, 0),
    // Median per-frame GI sum: a pass that runs only on some frames (Card relight
    // after a light change) counts on exactly those frames.
    giFrameMs: median(
      complete.map((t) =>
        t.frame.passes
          .filter((p) => p.status === 'measured' && isGi(p.passName))
          .reduce((s, p) => s + p.durationNanoseconds / 1e6, 0),
      ),
    ),
    // Compute passes only; raster pass timestamps are coarse on some drivers (Metal).
    giTransportMs: passes
      .filter((p) => isGi(p.name) && !/composite/.test(p.name))
      .reduce((s, p) => s + p.ms, 0),
    // Graph passes recorded per frame (all, and GI-owned), from the last timed frame.
    passCount: complete.at(-1).frame.passes.length,
    giPassCount: complete.at(-1).frame.passes.filter((p) => isGi(p.passName)).length,
    passes: passes.sort((a, b) => b.ms - a.ms),
  };
}

/** Sponza through the built hello-gi catalog (`vite build` dist), as src/main.ts spawns it. */
export async function spawnSponza(world, assets, distDir) {
  const { createWorldContext } = await import('@forgeax/engine-ecs');
  const { renderComponentsPlugin } = await import('@forgeax/engine-render');
  const { scenePlugin } = await import('@forgeax/engine-scene');
  const { SPONZA } = await import('../src/scenes.ts');
  const { spawnCamera, spawnLight } = await import('../src/build-scene.ts');
  await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
  const restore = installDistCatalog(assets, distDir);
  try {
    const scene = (await assets.loadByGuid(assets.parseGuid(SPONZA.sceneGuid))).unwrap();
    assets.instantiate(world.allocSharedRef('SceneAsset', scene), world).unwrap();
  } finally {
    restore();
  }
  spawnLight(world, SPONZA.light);
  spawnCamera(world, SPONZA.camera, 1);
}

/** Publish cooked materials into the Renderer's asset registry and the World. */
export function publishMaterials(world, assets, cooked) {
  const handles = new Map();
  for (const [name, entry] of cooked) {
    assets.catalog(name, entry.asset).unwrap();
    assets.recordMaterialReadiness(name, entry.ready);
    handles.set(name, world.allocSharedRef('MaterialAsset', entry.asset));
  }
  return (name) => {
    const handle = handles.get(name);
    if (handle === undefined) throw new Error(`unknown GI material ${name}`);
    return handle;
  };
}

export function directProfile(original) {
  const { diffuseGi: _previous, ...profile } = original;
  return {
    ...profile,
    renderPath: 'deferred',
    ibl: false,
    ssao: false,
    pbr: true,
    visibleSurface: true,
  };
}

/** Frame driver: World update, transform propagation, one Renderer submission. */
export async function createFrameDriver({ renderer, world, lease }) {
  const { propagateTransforms } = await import('@forgeax/engine-scene');
  const submit = () =>
    renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
      geometryLane: 'direct',
    });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = submit();
    if (!receipt.ok) throw new Error(`draw failed: ${JSON.stringify(receipt.error)}`);
    const completed = await receipt.value.completed;
    if (!completed.ok) throw new Error(`frame failed: ${JSON.stringify(completed.error)}`);
    return receipt.value;
  };
  const observe = async (domains, include = domains) => {
    renderer.requestObservation(domains).unwrap();
    const receipt = await draw();
    const observed = await renderer.observe(receipt, { include });
    if (!observed.ok) throw new Error(`observe failed: ${JSON.stringify(observed.error)}`);
    return { receipt, observed: observed.value };
  };
  const settle = async (timeoutMs = 180000) => {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      await draw();
      const state = renderer.inspect().diffuseGi;
      if (state === undefined) return;
      if (state.state === 'failed') throw new Error(`diffuse GI failed: ${JSON.stringify(state)}`);
      if (state.state === 'ready' && state.submittedFrames > 0) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`diffuse GI did not settle: ${JSON.stringify(renderer.inspect().diffuseGi)}`);
  };
  return { draw, observe, settle };
}

let pathKernel;
/** The bounded reference path tracer kernel, compiled from the same shader tree. */
export async function compilePathKernel() {
  if (pathKernel) return pathKernel;
  const { buildMaterialSourceCatalog, collectMaterialSources, compileShader } = await import(
    '@forgeax/engine-shader-compiler'
  );
  const sources = buildMaterialSourceCatalog(
    await collectMaterialSources([shaderSourceDir], [shaderSourceDir]),
  ).unwrap();
  const imports = Object.fromEntries(
    [
      'forgeax_material::ray_abi',
      'forgeax_ray::traversal',
      'forgeax_pbr::ray_bsdf',
      'forgeax_pbr::brdf',
      'forgeax_pbr::ibl_shared',
      'forgeax_pbr::lighting_attenuation',
    ].map((id) => [id, sources.get(id).unwrap().source]),
  );
  pathKernel = (
    await compileShader(sources.get('forgeax_ray::path_tracer').unwrap().source, {
      id: 'hello-gi-path-tracer',
      imports,
    })
  ).unwrap().wgsl;
  return pathKernel;
}

/** Light snapshots in the shape the Renderer extracts (color pre-multiplied by intensity). */
export function lightSnapshot(light, on = true, moved = false) {
  const intensity = on ? light.intensity : 0;
  const color = new Float32Array(light.color.map((v) => v * intensity));
  return light.kind === 'point'
    ? {
        kind: 'point',
        position: new Float32Array(moved ? light.moved : light.position),
        color,
        intensity,
        invRangeSquared: 1 / (light.range * light.range),
        shadowAtlasLayer: -1,
      }
    : {
        kind: 'directional',
        contactShadowLength: 0,
        direction: new Float32Array(moved ? light.moved : light.direction),
        color,
        intensity,
      };
}

/** Procedural boxes as exact ray instances over the unit box mesh the Renderer draws. */
export async function proceduralRayScene(scene, cooked, emissive = true) {
  const { createBoxGeometry } = await import('@forgeax/engine-geometry');
  const { boxMatrix } = await import('../src/build-scene.ts');
  const box = createBoxGeometry(2, 2, 2).unwrap();
  const names = [...cooked.keys()];
  const instances = scene.boxes.map((b, i) => {
    const material = b.emissive && !emissive ? 'panel-off' : b.material;
    return {
      instanceId: i,
      geometryId: 0,
      mask: 255,
      materialId: names.indexOf(material),
      positions: box.attributes.position,
      normals: box.attributes.normal,
      tangents: box.attributes.tangent,
      uvSets: [box.attributes.uv],
      indices: box.indices,
      transform: boxMatrix(b.center, b.half, b.yaw ?? 0),
    };
  });
  const materials = names.map((name, id) => ({
    id,
    asset: cooked.get(name).asset,
    program: cooked.get(name).program,
  }));
  return { instances, materials };
}

/**
 * Accumulate `samples` reference paths per pixel on its own device and return
 * mean linear RGB. `scene` is a built RaySurfaceScene. `onAccumulation` sees the
 * raw 20-float accumulation rows, including the first-hit albedo, shading
 * normal + distance and hit identity AOVs.
 */
export async function tracePath({
  device,
  compile,
  scene,
  materials,
  lights,
  camera,
  width,
  height,
  maxBounces,
  environment,
  maxDistance,
  samples,
  resolveTexture,
  receiver = 'full',
  seed = 47,
  onAccumulation,
}) {
  const { createRayPathTracer } = await import('@forgeax/engine-render/internal');
  // Primary rays through pixel centers: the raster lane shades exactly these
  // receivers, so a jittered reference would add silhouette sky to "indirect".
  const rays = pixelCenterRays(camera, width, height);
  const tracer = (
    await createRayPathTracer(device, compile, {
      kernel: await compilePathKernel(),
      scene,
      materials,
      lights,
      ...(resolveTexture === undefined ? {} : { resolveTexture }),
      settings: { width, height, rays, maxBounces, seed, environment, maxDistance, receiver },
    })
  ).unwrap();
  try {
    // Full Sponza loses the native device with 16 deep MASK samples in one
    // command, even with compatible compute batches. Keep every requested
    // sample, but retire each complete path before admitting the next one.
    for (let sample = 0; sample < samples; sample++) {
      const encoder = device.createCommandEncoder({}).unwrap();
      tracer.recordSample(encoder).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
    }
    const size = width * height * 80;
    const staging = device.createBuffer({ size, usage: 9 }).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    encoder.copyBufferToBuffer(tracer.buffers.accumulation, 0, staging, 0, size);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await staging.mapAsync(1)).unwrap();
    const f = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    device.destroyBuffer(staging).unwrap();
    onAccumulation?.(f);
    const out = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++)
      for (let c = 0; c < 3; c++) out[i * 3 + c] = f[i * 20 + c];
    return out;
  } finally {
    tracer.dispose();
  }
}

/** Unjittered camera rays matching the path tracer's camera convention. */
export function pixelCenterRays(camera, width, height) {
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => a.map((v) => v / Math.hypot(...a));
  const forward = norm(sub(camera.target, camera.origin));
  const right = norm(cross(forward, camera.up));
  const up = norm(cross(right, forward));
  const tan = Math.tan(camera.verticalFov / 2);
  const aspect = width / height;
  const rays = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const nx = ((x + 0.5) / width) * 2 - 1;
      const ny = ((y + 0.5) / height) * 2 - 1;
      rays.push({
        origin: camera.origin,
        direction: norm(forward.map((f, i) => f + nx * tan * aspect * right[i] - ny * tan * up[i])),
        coneWidth: 0,
        coneSpread: (2 * tan) / height,
        active: true,
      });
    }
  return rays;
}

/**
 * Serve a built hello-gi `dist/` catalog to `assets.loadByGuid` under Node: a static
 * fetch over pack-index, pack descriptors and their artifacts (the same
 * package-relative resolution the browser runtime uses). Returns a restore function.
 */
export function installDistCatalog(assets, distDir) {
  const indexWire = JSON.parse(readFileSync(resolve(distDir, 'pack-index.json'), 'utf8'));
  const index = decodeCatalogWire(indexWire).unwrap();
  const paths = new Map(
    index.map((entry) => [entry.packageUrl, resolve(distDir, entry.packageUrl.replace(/^\//, ''))]),
  );
  const original = globalThis.fetch;
  const response = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  globalThis.fetch = async (url) => {
    const key = typeof url === 'string' ? url : String(url);
    if (key === '/pack-index.json') return response(indexWire);
    const path = paths.get(key);
    if (path === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (key.endsWith('.json')) {
      const pack = JSON.parse(readFileSync(path, 'utf8'));
      const base = key.slice(0, key.lastIndexOf('/') + 1);
      for (const asset of pack.assets ?? [])
        for (const descriptor of Object.values(asset.artifacts ?? {}))
          if (typeof descriptor?.path === 'string')
            paths.set(
              `${base}${descriptor.path.replace(/^\/+/, '')}`,
              resolve(dirname(path), descriptor.path),
            );
      return response(pack);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => {
        const bytes = readFileSync(path);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
  assets.configurePackIndex('/pack-index.json');
  return () => {
    globalThis.fetch = original;
  };
}
