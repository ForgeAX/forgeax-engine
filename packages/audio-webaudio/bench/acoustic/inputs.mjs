import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';

// One input inventory for native receipts and pre-lease quiet admission.
const fixture = 'packages/audio-webaudio/bench/acoustic';
const sources = [
  'packages/audio/src/acoustic-regions.ts',
  'packages/audio/src/acoustic-controls.ts',
  'packages/audio-webaudio/src/source-bus-routes.ts',
  'packages/audio-webaudio/src/bus-graph.ts',
  'packages/audio-webaudio/src/web-audio-engine.ts',
  'packages/audio/dist/index.mjs',
  'packages/audio-webaudio/dist/index.mjs',
  'shared-build-inputs/manifest.json',
  'shared-build-inputs/production-facts.json',
  'shared-build-inputs/shaders/manifest.json',
  'packages/wgpu-wasm/pkg/provenance.json',
];
export async function inputIdentity(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const assets = `${fixture}/dist/assets`;
  const files = [...['evidence.ts', 'rooms.pack.ts', 'bootstrap.ts', 'kernel.ts', 'vite.config.mjs',
    'recorder.worklet.js', 'inputs.mjs', 'quiet-preflight.mjs', 'run.mjs', 'prepare.mjs', 'index.html', 'vite-env.d.ts',
    'dist/index.html', 'dist/pack-index.json', 'dist/shaders/manifest.json'].map(file => `${fixture}/${file}`),
    'artifacts/roi22-acoustics/sources/tone.wav', 'artifacts/roi22-acoustics/sources/tone.wav.meta.json',
    ...(await readdir(resolve(root, assets), { withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => entry.name).sort().map(f => `${assets}/${f}`)];
  let sdk;
  if (process.env.FORGEAX_AUDIO_SDK_ROOT) {
    const manifest = resolve(process.env.FORGEAX_AUDIO_SDK_ROOT, 'sdk-manifest.json');
    const declaration = JSON.parse(await readFile(manifest, 'utf8'));
    const require = createRequire(resolve(root, 'package.json'));
    const enginePath = await realpath(require.resolve('@forgeax/engine/package.json'));
    if (!enginePath.startsWith(`${await realpath(root)}${sep}`))
      throw new Error('SDK consumer Engine must be installed in the external project');
    const engine = JSON.parse(await readFile(enginePath, 'utf8'));
    if (engine.version !== declaration.sdkVersion) throw new Error('installed Engine/SDK version mismatch');
    const fromEngine = createRequire(enginePath), modules = {};
    files.push(manifest, enginePath, resolve(root, 'package.json'), resolve(root, 'pnpm-lock.yaml'),
      resolve(root, 'scripts/ci/browser-launch.json'));
    for (const owner of ['audio', 'audio-webaudio', 'app', 'vite-plugin-shader']) {
      const packagePath = await realpath(fromEngine.resolve(`@forgeax/engine-${owner}/package.json`));
      const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
      if (packageManifest.name !== `@forgeax/engine-${owner}` || packageManifest.version !== engine.version)
        throw new Error(`SDK owner identity mismatch: ${owner}`);
      const path = await realpath(resolve(dirname(packagePath), packageManifest.main));
      files.push(path, packagePath);modules[owner] = path;
    }
    sdk = { root: await realpath(process.env.FORGEAX_AUDIO_SDK_ROOT), version: declaration.sdkVersion,
      engineCommit: declaration.engineCommit, installedEngine: enginePath, modules };
  } else files.push(...sources);
  const digests = {};
  for (const file of files) digests[file] = hash(await readFile(resolve(root, file)));
  return { head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain'),
    trackedDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { cwd: root })),
    ...(sdk ? { sdk } : {}), digests };
}
