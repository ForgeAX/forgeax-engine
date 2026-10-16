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

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    frames: { type: 'string', default: '180' },
    warmup: { type: 'string', default: '60' },
    path: { type: 'string', default: 'deferred' },
    profile: { type: 'boolean', default: false },
  },
});
const label = positionals[0] ?? 'cohort';
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('label must be a filename-safe identifier');
const frames = Number(options.frames);
const warmup = Number(options.warmup);
if (![frames, warmup].every((value) => Number.isSafeInteger(value) && value > 0))
  throw new Error('frames and warmup must be positive integers');
if (!['forward', 'deferred'].includes(options.path))
  throw new Error('path must be forward or deferred');
const outputDirectory = 'artifacts/standard-deferred';
mkdirSync(outputDirectory, { recursive: true });
const quantile = (samples, fraction) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
};
const summarize = (samples) => ({
  mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  median: quantile(samples, 0.5),
  p95: quantile(samples, 0.95),
});
const root = process.cwd();
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
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
  { createRenderer },
  { createProfiler },
] = await Promise.all(['ecs', 'geometry', 'scene', 'render', 'runtime', 'profiler'].map(moduleOf));
const {
  Camera,
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
const manifest = readFileSync(`${root}/shared-build-inputs/shaders/manifest.json`);
const shaderManifestUrl = URL.createObjectURL(new Blob([manifest], { type: 'application/json' }));
const profiler = options.profile ? createProfiler() : undefined;
const renderer = value(
  await createRenderer(
    canvas,
    {
      ...(profiler === undefined ? {} : { profiler }),
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        renderPath: options.path,
        ssao: { quality: 'medium' },
      },
    },
    { shaderManifestUrl },
  ),
);
const world = new World();
const geometry = value(createSphereGeometry(0.45, 32, 16));
const mesh = world.allocSharedRef('MeshAsset', geometry);
const materials = Array.from({ length: 12 }, (_, i) =>
  world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.2 + i * 0.035, 0.4, 0.6 - i * 0.03, 1],
      metallic: i / 16,
      roughness: 0.3 + i * 0.04,
    }),
  ),
);
for (let i = 0; i < 306; i++)
  value(
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [
            ((i % 18) - 8.5) * 1.05,
            ((Math.floor(i / 18) % 6) - 2.5) * 1.05,
            -Math.floor(i / 108) * 1.4,
          ],
        },
      },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [materials[i % 12]] } },
    ),
  );
const camera = value(
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 14] } },
    {
      component: Camera,
      data: {
        fov: Math.PI / 3,
        aspect: width / height,
        near: 0.1,
        far: 50,
        antialias: 1,
        tonemap: 1,
        bloom: 0,
      },
    },
  ),
);
value(
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.3, -0.4, -1],
      intensity: 2,
      castShadow: true,
      cascadeCount: 4,
      mapSize: 1024,
      shadowDistance: 35,
    },
  }),
);
value(world.spawn({ component: Skylight, data: { intensity: 0.5 } }));
const lease = value(renderer.attach(world));
const timings = [];
const errors = [];
renderer.subscribe((e) => {
  if (e.kind === 'error') errors.push(e.error);
});
async function frame(x) {
  value(world.set(camera, Transform, { pos: [x, 0, 14] }));
  value(world.update(1 / 60));
  value(propagateTransforms(world));
  const t = performance.now();
  const receipt = value(
    renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
  );
  const submitted = performance.now();
  value(await receipt.completed);
  return { start: t, submitted, end: performance.now(), receipt };
}
try {
  for (let i = 0; i < warmup; i++) await frame(0);
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
    for (let i = 0; i < frames; i++) samples.push(await frame(moving ? Math.sin(i / 30) * 1.5 : 0));
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
      samples: samples.map((v) => ({
        cpuSubmitMs: v.submitted - v.start,
        completedFrameMs: v.end - v.start,
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
  value(renderer.requestObservation(['linear-hdr']));
  const observedFrame = await frame(0);
  const observations = value(
    await renderer.observe(observedFrame.receipt, { include: ['linear-hdr'] }),
  );
  const pixels = observations.observations.find((item) => item.domain === 'linear-hdr');
  if (pixels === undefined) throw new Error('missing benchmark pixel evidence');
  writeFileSync(`${outputDirectory}/${label}.rgba16f`, pixels.bytes);
  if (errors.length) throw new Error(JSON.stringify(errors));
  const result = {
    label,
    sourceCommit,
    sourceDirty:
      execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
        cwd: root,
        encoding: 'utf8',
      }).trim() !== '',
    renderRuntimeSha256: readdirSync(`${root}/packages/render/dist`, { recursive: true })
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
      .digest('hex'),
    pixelSha256: createHash('sha256').update(pixels.bytes).digest('hex'),
    pixelMetadata: pixels.metadata,
    shaderManifestSha256: createHash('sha256').update(manifest).digest('hex'),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model,
      softwareGpuThreads: process.env.LP_NUM_THREADS ?? null,
    },
    backend: 'Dawn',
    profiled: options.profile,
    renderPath: options.path,
    warmupFrames: warmup,
    quantiles: 'nearest-rank: sorted[ceil(p*n)-1]',
    width,
    height,
    receivers: 306,
    trianglesPerReceiver: geometry.indices.length / 3,
    settings: { ssao: 'medium', fxaa: true, cascades: 4, mapSize: 1024, shadowDistance: 35 },
    timings,
    gpuDriven: renderer.inspect().renderScene.gpuDriven,
    passes: renderer.inspect().perFramePassNames,
  };
  writeFileSync(`${outputDirectory}/${label}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  lease.dispose();
  renderer.dispose();
  texture?.destroy();
  URL.revokeObjectURL(shaderManifestUrl);
  delete globalThis.navigator.gpu;
}
process.exit(0);
