#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { build } from 'vite';
import { verifyProvenance } from '../../packages/wgpu-wasm/scripts/provenance.mjs';
import { runnerResources, shaderCompileWorkers } from '../lib/runner-resources.mjs';
import {
  reusableSharedShader,
  sharedShaderInputFingerprint,
  sharedShaderReceipt,
} from '../lib/shared-build-cache.mjs';

const HELP = `Build the shared app-neutral LearnOpenGL inputs for CI app shards.

Shared scope: one asset catalog and one engine built-in shader manifest. The optional
catalog-only mode intentionally omits serialized asset payload bytes for CI app shards.
App boundary: each app still owns its final pack-index, deployment base, dev server,
HMR, and custom shader entries. This command does not build an app deployment.

Producer: shared-app-inputs
Consumers: app-shard-0, app-shard-1, app-shard-2
Contract: scripts/ci/build-artifact-contract.json (sharedInputs)
Validate: node scripts/ci/verify-build-artifact-input.mjs --consumer app-shard --input-root <download-dir>
Recover: rebuild this command when the manifest is missing or stale; download the
complete shared-app-inputs artifact when provenance or inventory validation fails.
The retention/fallback policy is a charter-insufficient gap; cache is only an accelerator.

Options:
  --root <dir>         Repository root (default: .)
  --out <dir>          Output directory (default: shared-app-inputs)
  --asset-root <dir>   LearnOpenGL source root
  --shader-root <dir>  Engine shader source root
  --shader-input-manifest <p> Reuse an explicitly verified shader producer output
  --catalog-only       Emit catalog metadata without serialized asset payload bytes
  --projection-out <d> Also emit a catalog-only projection from the full build
  --github-output <p>  Write the trusted producer fingerprint to this output file
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const root = resolve(option('--root', '.'));
const output = resolve(root, option('--out', 'shared-app-inputs'));
const assetRoot = resolve(root, option('--asset-root', 'forgeax-engine-assets/learn-opengl'));
const shaderRoot = resolve(root, option('--shader-root', 'packages/shader/src'));
const githubOutput = option('--github-output', null);
const projectionOption = option('--projection-out', null);
const projectionOutput = projectionOption === null ? null : resolve(root, projectionOption);
const catalogOnly = process.argv.includes('--catalog-only');
const shaderInputOption = option('--shader-input-manifest', null);
const staging = join(output, '.build');
const VIRTUAL_ENTRY = 'virtual:forgeax/shared-app-inputs-entry';
const productionStartedAt = performance.now();

function files(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
}

async function fingerprint(roots) {
  const hash = createHash('sha256');
  for (const sourceRoot of roots) {
    for (const path of files(sourceRoot)) {
      hash.update(`${relative(root, path).replaceAll('\\', '/')}\0`);
      hash.update(await readFile(path));
    }
  }
  return hash.digest('hex');
}

for (const source of [assetRoot, shaderRoot]) {
  if (!statSync(source).isDirectory()) {
    throw new Error(`shared input source is not a directory: ${source}`);
  }
}
const assetRootRelative = relative(root, assetRoot);
if (assetRootRelative.startsWith('..')) {
  throw new Error(`--asset-root must be inside --root: ${assetRoot}`);
}
const engineShaderRoot = resolve(
  dirname(createRequire(import.meta.url).resolve('@forgeax/engine-shader/package.json')),
  'src',
);
if (realpathSync(shaderRoot) !== realpathSync(engineShaderRoot)) {
  throw new Error(
    `--shader-root must name the engine shader source compiled by forgeaxShader: ${engineShaderRoot}`,
  );
}

// This producer owns the shared projection. Consumers can inherit its output
// path, including during artifact-miss recovery, but the producer must never
// read that path after clearing it or substitute an unchecked packaged profile.
delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '1';
// Use the repository producer's cgroup CPU bound without raising the shader
// plugin's existing sixteen-worker ceiling on larger hosts.
const resources = runnerResources();
process.env.FORGEAX_SHADER_COMPILE_WORKERS = String(
  shaderCompileWorkers(resources, process.env.FORGEAX_SHADER_COMPILE_WORKERS),
);
console.log(
  `[shared-build] shader workers=${process.env.FORGEAX_SHADER_COMPILE_WORKERS} cpus=${resources.cpus} containerized=${resources.containerized}`,
);

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const engineEntries = { pointShadows: true, hdrpSsao: true };
const shaderInputFingerprint = sharedShaderInputFingerprint(root, engineEntries);
// Admission happens after clearing our output. An inherited/self-referencing
// consumer path cannot survive as a hidden dependency of source recovery.
const shaderInputManifest = shaderInputOption === null ? null : resolve(root, shaderInputOption);
const preparedShader =
  process.env.FORGEAX_BUILD_NO_TASK_CACHE !== '1' &&
  shaderInputManifest !== null &&
  reusableSharedShader(root, shaderInputManifest, shaderInputFingerprint, (reason) =>
    console.log(`[shared-build] explicit shader reuse miss: ${reason}`),
  );
if (preparedShader) {
  process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = shaderInputManifest;
  process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '0';
  console.log('[shared-build] verified explicit shader input; compiling only the asset catalog');
}

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  plugins: [
    {
      name: 'forgeax:shared-app-inputs-entry',
      resolveId(id) {
        return id === VIRTUAL_ENTRY ? id : null;
      },
      load(id) {
        return id === VIRTUAL_ENTRY ? 'export {};' : null;
      },
    },
    // The shared manifest is consumed by every browser shard. Keep the
    // optional engine entries required by the real point-shadow and SSAO
    // browser paths in that one producer-owned projection, so a shard never
    // silently installs the graph without its post-process pipelines.
    forgeaxShader({ engineEntries }),
    pluginPack({ roots: [assetRoot], importers: [audioImporter, gltfImporter, imageImporter] }),
  ],
  build: {
    emptyOutDir: true,
    outDir: staging,
    assetsInlineLimit: 0,
    rollupOptions: { input: VIRTUAL_ENTRY },
  },
});

const catalogPath = join(staging, 'pack-index.json');
const shaderManifestPath = join(staging, 'shaders', 'manifest.json');
if (!statSync(catalogPath).isFile() || !statSync(shaderManifestPath).isFile()) {
  throw new Error('shared input build did not emit a pack catalog and engine shader manifest');
}

mkdirSync(join(output, 'assets'), { recursive: true });
mkdirSync(join(output, 'shaders'), { recursive: true });
cpSync(catalogPath, join(output, 'assets', 'catalog.json'));
if (!catalogOnly) {
  const payloadRoot = join(output, 'assets', 'payload');
  cpSync(assetRoot, join(payloadRoot, assetRootRelative), { recursive: true });
  cpSync(join(staging, 'assets'), join(payloadRoot, 'assets'), { recursive: true });
}
// The self-contained manifest is the entire shared shader consumer closure.
cpSync(shaderManifestPath, join(output, 'shaders/manifest.json'));
rmSync(staging, { recursive: true, force: true });

// Transfer the exact verified compiler substrate alongside its shader output.
// Two source-valid Rust builds can differ bytewise; consumers must use this
// producer's bytes before checking the unchanged shader input fingerprint.
await verifyProvenance();
cpSync(join(root, 'packages/wgpu-wasm/pkg'), join(output, 'compiler'), { recursive: true });

const inventory = files(output)
  .map((path) => relative(root, path).replaceAll('\\', '/'))
  .sort();
const manifest = {
  schemaVersion: 1,
  producer: 'shared-app-inputs',
  shaderBuild: sharedShaderReceipt(
    root,
    join(output, 'shaders/manifest.json'),
    shaderInputFingerprint,
  ),
  inputFingerprint: await fingerprint([assetRoot, shaderRoot]),
  inventory: ['shared-app-inputs/assets/catalog.json', 'shared-app-inputs/shaders/manifest.json'],
  payload: {
    assetCatalog: 'shared-app-inputs/assets/catalog.json',
    ...(catalogOnly ? {} : { assetPayloadRoot: 'shared-app-inputs/assets/payload' }),
    engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
  },
  ...(catalogOnly
    ? {}
    : {
        payloadInventory: inventory,
      }),
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
if (projectionOutput !== null) {
  if (catalogOnly) throw new Error('--projection-out requires a full shared-input build');
  if (projectionOutput === output) throw new Error('--projection-out must differ from --out');
  rmSync(projectionOutput, { recursive: true, force: true });
  mkdirSync(join(projectionOutput, 'assets'), { recursive: true });
  cpSync(join(output, 'assets', 'catalog.json'), join(projectionOutput, 'assets', 'catalog.json'));
  cpSync(join(output, 'shaders'), join(projectionOutput, 'shaders'), { recursive: true });
  cpSync(join(output, 'compiler'), join(projectionOutput, 'compiler'), { recursive: true });
  writeFileSync(
    join(projectionOutput, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: manifest.schemaVersion,
        producer: manifest.producer,
        shaderBuild: manifest.shaderBuild,
        inputFingerprint: manifest.inputFingerprint,
        inventory: manifest.inventory,
        payload: {
          assetCatalog: manifest.payload.assetCatalog,
          engineShaderManifest: manifest.payload.engineShaderManifest,
        },
      },
      null,
      2,
    )}\n`,
  );
}
// These counters describe work this producer actually performed. Compressed artifact
// bytes and whole-job duration are deliberately left to the reporter, which reads
// GitHub's artifact and job records after upload.
const productionFacts = {
  schemaVersion: 1,
  producer: manifest.producer,
  inputFingerprint: manifest.inputFingerprint,
  cacheState: 'cold',
  payloadMode: catalogOnly ? 'catalog-only' : 'full',
  sourceScanCount: 1,
  sourceFileCount: files(assetRoot).length,
  payloadEmitCount: catalogOnly ? 0 : 2,
  engineCompileCount: preparedShader ? 0 : 1,
  buildDurationSeconds: Number(((performance.now() - productionStartedAt) / 1000).toFixed(3)),
};
writeFileSync(
  join(output, 'production-facts.json'),
  `${JSON.stringify(productionFacts, null, 2)}\n`,
);
if (githubOutput !== null)
  appendFileSync(githubOutput, `input_fingerprint=${manifest.inputFingerprint}\n`);
process.stdout.write(`${JSON.stringify(manifest)}\n`);
