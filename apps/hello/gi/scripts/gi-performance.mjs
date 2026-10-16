// Balanced off/on GPU measurements without HDR readback or RHI recording.
// This measures the ordinary Renderer; timing-on and timing-off runs are separate.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { optionReader } from './gi-comparison.mjs';
import * as gi from './gi-dawn.mjs';

const option = optionReader(process.argv.slice(2));
const sceneId = option('scene', 'sponza');
const gather = option('gather', 'irradiance-field');
if (!['exact', 'irradiance-field', 'screen-probe'].includes(gather)) throw new Error(`invalid gather ${gather}`);
const size = Number(option('size', '512'));
const warmup = Number(option('warmup', '256'));
const frames = Number(option('frames', '32'));
const cycles = Number(option('cycles', '3'));
const timingMode = option('pass-timing', 'on');
if (!['on', 'off'].includes(timingMode)) throw new Error(`invalid pass-timing ${timingMode}`);
const timing = timingMode === 'on';
const out = resolve(option('out', resolve(gi.monorepoRoot, 'artifacts/gi-performance')));
const dist = resolve(option('sponza-dist', resolve(gi.appRoot, 'dist')));
for (const [name, value] of Object.entries({ size, warmup, frames, cycles }))
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
mkdirSync(out, { recursive: true });
await gi.installDawn();
const adapter = await navigator.gpu.requestAdapter();
const { PROCEDURAL_SCENES, SPONZA, diffuseGiFor } = await import('../src/scenes.ts');
const { createGiBoxMesh, spawnProceduralScene } = await import('../src/build-scene.ts');
const scene = sceneId === 'sponza' ? SPONZA : PROCEDURAL_SCENES[sceneId];
if (scene === undefined) throw new Error(`unknown scene ${sceneId}`);
const cooked = sceneId === 'sponza' ? undefined : await gi.cookGiMaterials();
const { renderer, assets, errors } = await gi.createGiRenderer({ width: size, height: size, timing });
const world = new World();
if (sceneId === 'sponza') await gi.spawnSponza(world, assets, dist);
else spawnProceduralScene(world, scene, gi.publishMaterials(world, assets, cooked), 1,
  await createGiBoxMesh());
const lease = renderer.attach(world).unwrap();
const driver = await gi.createFrameDriver({ renderer, world, lease });
const direct = gi.directProfile(renderer.inspect().profile);
const indirect = { ...direct, diffuseGi: diffuseGiFor(gather, scene, { maxBounces: 7 }) };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gi.monorepoRoot }).toString().trim(),
  generatedAt: new Date().toISOString(),
  sourceDiffSha256: sha256(execFileSync('git', ['diff', 'HEAD', '--', 'packages', 'apps/hello/gi', 'scripts/raytracing'], { cwd: gi.monorepoRoot })),
  assetsCommit: execFileSync('git', ['-C', 'forgeax-engine-assets', 'rev-parse', 'HEAD'], { cwd: gi.monorepoRoot }).toString().trim(),
  catalogSha256: sceneId === 'sponza' ? sha256(readFileSync(resolve(dist, 'pack-index.json'))) : undefined,
  adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
    device: adapter.info.device, description: adapter.info.description },
  fallback: adapter.isFallbackAdapter,
  settings: { scene: sceneId, gather, size, warmup, frames, cycles, timing, bounces: 7 },
  semantics: 'queue-completed wall latency and pass interval coverage; neither is exclusive GI GPU cost',
  blocks: [],
};
try {
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const mode of ['off', 'on', 'on', 'off']) {
      renderer.setProfile(mode === 'off' ? direct : indirect).unwrap();
      await driver.settle();
      for (let frame = 0; frame < warmup; frame++) await driver.draw();
      const samples = [];
      const observations = [];
      for (let frame = 0; frame < frames; frame++) {
        const start = performance.now();
        const receipt = await driver.draw();
        samples.push(performance.now() - start);
        if (timing) observations.push((await renderer.observe(receipt, { include: ['timings'] })).unwrap().timings);
      }
      const block = { cycle, mode, wallMs: samples, gpu: timing ? gi.summarizeTimings(observations) : undefined,
        inspect: renderer.inspect().diffuseGi };
      report.blocks.push(block);
      console.log(`[gi-performance] cycle ${cycle + 1}/${cycles} ${mode} completed ${frames} frames`);
      writeFileSync(resolve(out, 'report.json'), `${JSON.stringify({ ...report, errors }, null, 2)}\n`);
    }
  }
} finally {
  renderer.dispose();
}
writeFileSync(resolve(out, 'report.json'), `${JSON.stringify({ ...report, errors }, null, 2)}\n`);
process.exit(errors.length > 0 || report.blocks.some((block) => timing && block.gpu.status !== 'complete') ? 1 : 0);
