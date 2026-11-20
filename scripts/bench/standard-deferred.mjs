// Compare the same built Engine cohort from two checkouts. Run with the
// qualified native graphics environment documented in scripts/ci/README.md.
// One receipt is awaited per frame; overlapping GPU timestamps are not summed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { scenarios } from './standard-deferred-workloads.mjs';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    frames: { type: 'string', default: '180' },
    warmup: { type: 'string', default: '60' },
    path: { type: 'string', default: 'deferred' },
    'projected-receiver': { type: 'boolean', default: false },
    'gbuffer-format': { type: 'string', default: 'full' },
    'shader-publication': { type: 'string' },
    scenario: { type: 'string', default: 'ordinary' },
    'gpu-timing': { type: 'boolean', default: false },
    output: { type: 'string', default: 'artifacts/standard-deferred' },
    profile: { type: 'boolean', default: false },
  },
});
const label = positionals[0] ?? 'cohort';
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('label must be a filename-safe identifier');
const frames = Number(options.frames);
const warmup = Number(options.warmup);
if (!Number.isSafeInteger(frames) || frames < 2 || !Number.isSafeInteger(warmup) || warmup < 1)
  throw new Error('frames must be at least two and warmup at least one');
if (!['forward', 'deferred'].includes(options.path))
  throw new Error('path must be forward or deferred');
const gbufferFormat = options['gbuffer-format'];
if (
  !['full', 'default'].includes(gbufferFormat) ||
  (gbufferFormat === 'default' && options.path !== 'deferred')
)
  throw new Error('gbuffer-format must be full or default; default requires Deferred');
const scenario = options.scenario;
if (!scenarios.includes(scenario))
  throw new Error(`scenario must be one of ${scenarios.join(', ')}`);
if (options.profile && options['gpu-timing'])
  throw new Error('Run CPU profiling and GPU timing independently');
const plain = scenario === 'plain';
const multiview = scenario === 'multiview';
const temporal = scenario === 'temporal';
const outputDirectory = options.output;
mkdirSync(outputDirectory, { recursive: true });
const quantile = (samples, fraction) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
};
const summarize = (samples) => ({
  mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  median: quantile(samples, 0.5),
  p95: quantile(samples, 0.95),
  p99: quantile(samples, 0.99),
});
const root = process.cwd();
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const renderRuntimeSha256 = readdirSync(`${root}/packages/render/dist`, { recursive: true })
  .filter((file) => file.endsWith('.mjs'))
  .sort()
  .reduce(
    (hash, file) =>
      hash
        .update(file)
        .update('\0')
        .update(readFileSync(`${root}/packages/render/dist/${file}`)),
    createHash('sha256'),
  )
  .digest('hex');
const ssrIdentity = temporal
  ? {
      sourceHead: sourceCommit,
      sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      lockSha256: createHash('sha256')
        .update(readFileSync(`${root}/pnpm-lock.yaml`))
        .digest('hex'),
      buildSha256: renderRuntimeSha256,
    }
  : undefined;
const req = createRequire(`${root}/package.json`);
const { create, globals } = req('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
const { patchDawnAdapterPrototype } = await import(
  pathToFileURL(`${root}/scripts/ci/normalize-dawn-device-limits.mjs`)
);
patchDawnAdapterPrototype(globals);
const gpu = create([]);
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
const moduleOf = (packageName) =>
  import(pathToFileURL(`${root}/packages/${packageName}/dist/index.mjs`));
const [
  { World },
  { createSphereGeometry },
  { Transform, propagateTransforms },
  render,
  { createProfiler },
] = await Promise.all(['ecs', 'geometry', 'scene', 'render', 'profiler'].map(moduleOf));
const {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  Camera,
  CameraView,
  DynamicResolution,
  PointLight,
  ReflectionProbe,
  ScreenSpaceReflection,
  MotionBlur,
  MeshFilter,
  MeshRenderer,
  Materials,
  DirectionalLight,
  Skylight,
  DEFAULT_STANDARD_PROFILE,
} = render;
const value = (r) => {
  if (!r.ok) throw r.error;
  return r.value;
};
let texture;
const width = 320,
  height = 180;
const canvas = {
  width,
  height,
  getContext: () => ({
    configure: ({ device, format }) => {
      texture?.destroy();
      texture = device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
    },
    unconfigure() {},
    getCurrentTexture: () => texture,
  }),
};
const manifest = readFileSync(
  options['shader-publication'] ?? `${root}/shared-build-inputs/shaders/manifest.json`,
);
const shaderManifestUrl = URL.createObjectURL(new Blob([manifest], { type: 'application/json' }));
const profiler = options.profile ? createProfiler() : undefined;
const timingIntervals = options['gpu-timing']
  ? (await import(pathToFileURL(`${root}/packages/render/dist/internal.mjs`)))
      .summarizeGpuPassTimingIntervals
  : undefined;
const { constructRuntimeRendererHost } = await import(
  pathToFileURL(`${root}/packages/runtime/dist/renderer-host.mjs`)
);
const constructionStart = performance.now();
const host = value(
  await constructRuntimeRendererHost(
    canvas,
    {
      ...(profiler === undefined ? {} : { profiler }),
      ...(timingIntervals === undefined ? {} : { gpuPassTiming: {} }),
      ...(ssrIdentity === undefined ? {} : { ssrIdentity }),
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        renderPath: options.path,
        ...(gbufferFormat === 'default' ? { gbufferFormat } : {}),
        ...(options['projected-receiver']
          ? { deferredDirectionalShadowReceiver: 'projected' }
          : {}),
        ambientOcclusion: { enabled: !plain, quality: 'medium' },
      },
    },
    { shaderManifestUrl },
  ),
);
const constructionMs = performance.now() - constructionStart;
const { renderer, assets } = host;
const world = new World({ assets });
const geometry = value(createSphereGeometry(0.45, 32, 16));
const mesh = assets.create(geometry).unwrap();
const materials = Array.from({ length: 12 }, (_, i) =>
  assets
    .create(
      Materials.standard({
        baseColor: [0.2 + i * 0.035, 0.4, 0.6 - i * 0.03, 1],
        metallic: i / 16,
        roughness: 0.3 + i * 0.04,
      }),
    )
    .unwrap(),
);
const spawnMesh = (material, pos, scale = [1, 1, 1]) =>
  value(
    world.spawn(
      { component: Transform, data: { pos, scale } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    ),
  );
const receiverCount = scenario === 'overdraw' ? 18 * 6 * 12 : 306;
const occlusion = scenario === 'overdraw' ? 0.55 : 1;
for (let i = 0; i < receiverCount; i++)
  spawnMesh(materials[i % materials.length], [
    ((i % 18) - 8.5) * 1.05 * occlusion,
    ((Math.floor(i / 18) % 6) - 2.5) * 1.05 * occlusion,
    -Math.floor(i / 108) * 1.4,
  ]);

let glassCount = 0;
if (scenario === 'transmission') {
  const glass = assets
    .create(
      Materials.standard({
        baseColor: [0.75, 0.88, 1, 1],
        transmission: 1,
        thickness: 0.2,
        ior: 1.45,
        roughness: 0.34,
      }),
    )
    .unwrap();
  glassCount = 6;
  for (let index = 0; index < glassCount; index++)
    spawnMesh(glass, [(index - 2.5) * 2.1, 0, 1.5], [2, 2, 2]);
}

const lightCount = scenario === 'lights-probes' ? 96 : 0;
for (let index = 0; index < lightCount; index++)
  value(
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [((index % 16) - 7.5) * 1.1, (Math.floor(index / 16) - 2.5) * 0.8, 2],
        },
      },
      {
        component: PointLight,
        data: {
          color: [0.5 + (index % 5) / 10, 0.7, 0.8],
          range: 3,
          intensity: 0.4,
        },
      },
    ),
  );
const probeResolutions = scenario === 'lights-probes' ? [64, 64, 128, 256] : [];
for (const [index, resolution] of probeResolutions.entries())
  value(
    world.spawn(
      { component: Transform, data: { pos: [(index - 1.5) * 4.5, 0, 1] } },
      {
        component: ReflectionProbe,
        data: {
          resolution,
          halfExtents: [2.1, 3, 4],
          priority: 1,
          intensity: 1,
          updateIntent: 0,
        },
      },
    ),
  );

const aa = temporal ? ANTIALIAS_TAA : plain ? ANTIALIAS_NONE : ANTIALIAS_FXAA;
const scale = temporal ? 0.75 : 1;
const spawnCamera = (pos) =>
  value(
    world.spawn(
      { component: Transform, data: { pos } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: (multiview ? width / 2 : width) / height,
          near: 0.1,
          far: 50,
          antialias: aa,
          tonemap: 1,
          bloom: 0,
        },
      },
    ),
  );
const camera = spawnCamera([0, 0, 14]);
if (multiview) {
  world
    .addComponent(camera, { component: CameraView, data: { viewport: [0, 0, 0.5, 1] } })
    .unwrap();
  world
    .addComponent(spawnCamera([2, 0, 14]), {
      component: CameraView,
      data: { viewport: [0.5, 0, 0.5, 1], order: 1 },
    })
    .unwrap();
}
if (temporal) {
  world
    .addComponent(camera, {
      component: DynamicResolution,
      data: { minScale: scale, maxScale: scale, targetGpuMs: 16.67 },
    })
    .unwrap();
  world.addComponent(camera, { component: MotionBlur, data: {} }).unwrap();
}
value(
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.3, -0.4, -1],
      intensity: 2,
      castShadow: !plain,
      // Use the same four-cascade shadow and receiver-bias workload for both formats.
      cascadeCount: 4,
      mapSize: 1024,
      shadowDistance: 35,
    },
  }),
);
value(world.spawn({ component: Skylight, data: { intensity: 0.5 } }));
const movingReceiver = temporal ? spawnMesh(materials[0], [0, 0, 2], [1.5, 1.5, 1.5]) : undefined;
const lease = value(renderer.attach(world));
const timings = [];
const gpuSamples = [];
const errors = [];
renderer.subscribe((e) => {
  if (e.kind === 'error') errors.push(e.error);
});
async function frame(x) {
  value(world.set(camera, Transform, { pos: [x, 0, 14] }));
  if (movingReceiver !== undefined)
    value(world.set(movingReceiver, Transform, { pos: [-2 * x, 0, 2] }));
  value(world.update(1 / 60));
  value(propagateTransforms(world));
  const deadline = performance.now() + 30_000;
  let t, submitted, receipt;
  let pendingFrames = 0;
  for (;;) {
    t = performance.now();
    receipt = value(renderer.draw({ source: lease }));
    submitted = performance.now();
    if (receipt.presentation === 'ready') break;
    pendingFrames++;
    value(await receipt.completed);
    if (performance.now() >= deadline) throw new Error('Renderer preparation timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  value(await receipt.completed);
  return { start: t, submitted, end: performance.now(), receipt, pendingFrames };
}
try {
  const presentationStart = performance.now();
  const initial = await frame(0);
  for (let i = 1; i < warmup; i++) await frame(0);
  let firstFeature;
  if (temporal) {
    const demandStart = performance.now();
    world
      .addComponent(camera, {
        component: ScreenSpaceReflection,
        data: { maxDistance: 4, thickness: 0.12, maxRoughness: 0.85 },
      })
      .unwrap();
    let ready = await frame(0);
    let pendingFrames = ready.pendingFrames;
    let fallbackFrames = 0;
    for (
      let ssr = renderer.inspect().ssr;
      !ssr.passRoster.includes('ssr-compose');
      ssr = renderer.inspect().ssr
    ) {
      if (performance.now() - demandStart >= 30_000)
        throw new Error(`SSR preparation timed out: ${JSON.stringify(ssr.failure)}`);
      fallbackFrames++;
      ready = await frame(0);
      pendingFrames += ready.pendingFrames;
    }
    firstFeature = {
      name: 'ssr',
      presentationMs: ready.end - demandStart,
      pendingFrames,
      fallbackFrames,
    };
    for (let i = 1; i < warmup; i++) await frame(0);
  }
  if (probeResolutions.length > 0) {
    for (
      let i = 0;
      i < 160 && renderer.inspect().reflectionProbes.activeCount < probeResolutions.length;
      i++
    )
      await frame(0);
    if (renderer.inspect().reflectionProbes.activeCount !== probeResolutions.length)
      throw new Error('The measured scene did not publish all reflection probes');
  }
  let cpuSession;
  let phaseSession;
  if (options.profile) {
    cpuSession = new Session();
    cpuSession.connect();
    await cpuSession.post('Profiler.enable');
    await cpuSession.post('Profiler.start');
    // Finish explicitly after the measured frames so materialization is outside
    // each sample. Profiled runs are diagnostics, not timing comparison inputs.
    phaseSession = value(
      profiler.startCapture({
        frameLimit: frames * 2 + 1,
        eventLimit: frames * 2 * 512,
        detail: 'nested',
      }),
    );
  }
  for (const moving of [false, true]) {
    const samples = [];
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      const sample = await frame(moving ? Math.sin(i / 30) * 1.5 : 0);
      samples.push(sample);
      if (timingIntervals === undefined) continue;
      const observation = value(
        await renderer.observe(sample.receipt, { include: ['timings'] }),
      ).timings;
      const gpu =
        observation?.status === 'complete'
          ? value(
              timingIntervals(
                observation.frame.passes,
                observation.frame.timestampPeriodNanoseconds,
              ),
            )
          : null;
      gpuSamples.push({
        moving,
        index: i,
        observation,
        unionMs: gpu === null ? null : gpu.unionNanoseconds / 1e6,
      });
    }
    const elapsed = performance.now() - start;
    timings.push({
      moving,
      frames: samples.length,
      elapsedMs: elapsed,
      completedFps: (samples.length * 1000) / elapsed,
      meanSubmitIntervalMs:
        (samples.at(-1).submitted - samples[0].submitted) / (samples.length - 1),
      meanRecordMs: samples.reduce((sum, v) => sum + v.submitted - v.start, 0) / samples.length,
      cpuSubmitMs: summarize(samples.map((v) => v.submitted - v.start)),
      completedFrameMs: summarize(samples.map((v) => v.end - v.start)),
      completionIntervalMs: summarize(samples.slice(1).map((v, i) => v.end - samples[i].end)),
      samples: samples.map((v) => ({
        cpuSubmitMs: v.submitted - v.start,
        completedFrameMs: v.end - v.start,
        completedAtMs: v.end - start,
      })),
    });
  }
  if (cpuSession !== undefined) {
    const { profile } = await cpuSession.post('Profiler.stop');
    cpuSession.disconnect();
    writeFileSync(`${outputDirectory}/${label}.cpuprofile`, JSON.stringify(profile));
    await frame(0);
    writeFileSync(
      `${outputDirectory}/${label}.profile.json`,
      JSON.stringify(value(phaseSession.finish())),
    );
  }
  // Pixel evidence is a separate untimed frame; capture/readback must not
  // contaminate CPU submission samples or completed-frame throughput.
  if (timingIntervals !== undefined) {
    writeFileSync(`${outputDirectory}/${label}.gpu.json`, JSON.stringify(gpuSamples));
    if (gpuSamples.some(({ unionMs }) => unionMs === null))
      throw new Error('GPU timestamp evidence is incomplete. Raw observations were retained.');
  }
  const domain = multiview ? 'final-display' : 'linear-hdr';
  value(renderer.requestObservation([domain]));
  const observedFrame = await frame(0);
  const observations = value(await renderer.observe(observedFrame.receipt, { include: [domain] }));
  const pixels = observations.observations.find((item) => item.domain === domain);
  if (pixels === undefined) throw new Error('missing benchmark pixel evidence');
  const pixelFile = `${label}.${multiview ? 'display' : 'rgba16f'}`;
  writeFileSync(`${outputDirectory}/${pixelFile}`, pixels.bytes);
  const inspection = renderer.inspect();
  const passNames = inspection.perFramePassNames ?? [];
  if (
    scenario === 'transmission' &&
    !passNames.some((pass) => pass.includes('transmission-forward'))
  )
    throw new Error('Transmission did not execute');
  if (
    temporal &&
    (!passNames.some((pass) => pass.includes('taa-resolve')) ||
      !passNames.some((pass) => pass.includes('ssr-compose')))
  )
    throw new Error('TAAU and SSR must execute for the temporal workload');
  if (errors.length) throw new Error(JSON.stringify(errors));
  const result = {
    label,
    sourceCommit,
    sourceDirty:
      execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
        cwd: root,
        encoding: 'utf8',
      }).trim() !== '',
    renderRuntimeSha256,
    adapter: inspection.deviceInfo?.adapterInfo,
    viewConfiguration: inspection.viewConfiguration,
    pixelSha256: createHash('sha256').update(pixels.bytes).digest('hex'),
    pixelMetadata: pixels.metadata,
    pixelFile,
    domain,
    shaderManifestSha256: createHash('sha256').update(manifest).digest('hex'),
    shaderManifestBytes: manifest.length,
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model,
      softwareGpuThreads: process.env.LP_NUM_THREADS ?? null,
    },
    backend: 'Dawn',
    profiled: options.profile,
    gpuTimed: timingIntervals !== undefined,
    scenario,
    allocation: inspection.renderGraphResourceAllocation,
    renderPath: options.path,
    gbufferFormat,
    constructionMs,
    firstPresentationMs: initial.end - presentationStart,
    initialPendingFrames: initial.pendingFrames,
    firstFeature,
    warmupFrames: warmup,
    quantiles: 'nearest-rank: sorted[ceil(p*n)-1]',
    width,
    height,
    receivers: receiverCount,
    trianglesPerReceiver: geometry.indices.length / 3,
    settings: {
      ssao: plain ? 'off' : 'medium',
      fxaa: aa === ANTIALIAS_FXAA,
      antialias: temporal ? 'taau' : plain ? 'none' : 'fxaa',
      internalScale: scale,
      viewCount: multiview ? 2 : 1,
      lightCount,
      probeResolutions,
      glassCount,
      occlusion,
      cascades: 4,
      mapSize: 1024,
      shadowDistance: 35,
      projectedReceiver: options['projected-receiver'],
    },
    timings,
    gpuDriven: inspection.renderScene.gpuDriven,
    passes: passNames,
  };
  writeFileSync(`${outputDirectory}/${label}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  lease.dispose();
  await renderer.dispose();
  texture?.destroy();
  URL.revokeObjectURL(shaderManifestUrl);
  delete globalThis.navigator.gpu;
}
process.exit(0);
