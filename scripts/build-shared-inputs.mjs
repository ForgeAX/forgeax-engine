#!/usr/bin/env node
// Produce the app-neutral engine inputs consumed by every app build.
// Asset catalogs intentionally do not belong here: roots and deployment URL
// projection remain app-owned. CI may use its separate LearnOpenGL producer.

import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { shaderProducerCompileWorkers } from './lib/runner-resources.mjs';
import { admitShaderSourceBudget } from './lib/shader-source-budget.mjs';
import {
  reusableSharedShader,
  sharedShaderInputFingerprint,
  sharedShaderReceipt,
} from './lib/shared-build-cache.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    'Usage: node scripts/build-shared-inputs.mjs [--root <dir>] [--out <dir>] [--no-point-shadows] [--no-hdrp-ssao] [--compiled-shaders] [--fingerprint]\n',
  );
  process.exit(0);
}

const root = resolve(option('--root', '.'));
const output = resolve(root, option('--out', 'shared-build-inputs'));
const compiled = process.argv.includes('--compiled-shaders');
const staging = join(output, '.build');
const virtualEntry = 'virtual:forgeax/repo-build-inputs-entry';
const sourceRoots = [
  join(root, 'packages/shader/src'),
  join(root, 'packages/vfx-render/src/shaders'),
];

function files(directory) {
  if (!statSync(directory).isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
}

function fingerprint(paths) {
  const hash = createHash('sha256');
  for (const path of paths.flatMap(files).sort()) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
  }
  return `sha256:${hash.digest('hex')}`;
}

for (const sourceRoot of sourceRoots) {
  if (!statSync(sourceRoot).isDirectory())
    throw new Error(`shared shader source is not a directory: ${sourceRoot}`);
}

function writeProductionFacts(compileCount, duration) {
  const facts = {
    schemaVersion: 2,
    producer: 'repo-build-inputs',
    inputFingerprint: fingerprint(sourceRoots),
    engineShaderCompileCount: compileCount,
    assetCookHitCount: 0,
    assetCookMissCount: 0,
    assetCookWriteFailureCount: 0,
    stageDurationMs: { producer: duration },
  };
  writeFileSync(join(output, 'production-facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
  return facts;
}

// The producer loads built compiler/plugin packages plus authored shader sources.
// Declarations and timing reports are excluded: they are not compiler inputs.
const engineEntries = {
  // The shared source catalog serves the ordinary Engine template request.
  // Explicit composed producers retain their historical option.
  pointShadows: compiled && !process.argv.includes('--no-point-shadows'),
  hdrpSsao: !process.argv.includes('--no-hdrp-ssao'),
};
// This is the source producer: packaged release profiles must never hide a
// source edit. Verified receipts are its only shortcut around compilation.
process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '1';
const inputFingerprint = sharedShaderInputFingerprint(
  root,
  compiled ? engineEntries : { ...engineEntries, publication: 'source' },
);
if (process.argv.includes('--fingerprint')) {
  process.stdout.write(`${inputFingerprint}\n`);
  process.exit(0);
}
if (
  process.env.FORGEAX_BUILD_NO_TASK_CACHE !== '1' &&
  reusableSharedShader(root, join(output, 'manifest.json'), inputFingerprint, (reason) =>
    console.log(`[shared-build] shader reuse miss: ${reason}`),
  )
) {
  writeProductionFacts(0, 0);
  console.log('[shared-build] verified shader output; compile count=0');
  process.exit(0);
}
if (process.env.FORGEAX_BUILD_NO_TASK_CACHE === '1')
  console.log(
    `[shared-build] shader reuse disabled by FORGEAX_BUILD_NO_TASK_CACHE; expected=${inputFingerprint}`,
  );

const startedAt = performance.now();
const shaderManifest = join(output, 'shaders/manifest.json');
if (compiled) admitShaderSourceBudget({ workerBudget: shaderProducerCompileWorkers });
const { buildEngineShaderTemplateManifest, forgeaxShader } = await import(
  '@forgeax/engine-vite-plugin-shader'
);
rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'shaders'), { recursive: true });
if (compiled) {
  const { build } = await import('vite');
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    plugins: [
      {
        name: 'forgeax:repo-build-inputs-entry',
        resolveId(id) {
          return id === virtualEntry ? id : null;
        },
        load(id) {
          return id === virtualEntry ? 'export {};' : null;
        },
      },
      forgeaxShader({ engineEntries, publication: 'compiled' }),
    ],
    build: {
      emptyOutDir: true,
      outDir: staging,
      assetsInlineLimit: 0,
      rollupOptions: { input: virtualEntry },
    },
  });
  cpSync(join(staging, 'shaders/manifest.json'), shaderManifest);
  rmSync(staging, { recursive: true, force: true });
} else {
  writeFileSync(
    shaderManifest,
    JSON.stringify(await buildEngineShaderTemplateManifest(engineEntries)),
  );
}

const outputRelative = relative(root, output).replaceAll('\\', '/');
const inventory = files(output)
  .map((path) => relative(root, path).replaceAll('\\', '/'))
  .sort();
const manifest = {
  schemaVersion: 2,
  producer: 'repo-build-inputs',
  inputFingerprint: fingerprint(sourceRoots),
  shaderBuild: sharedShaderReceipt(root, join(output, 'shaders/manifest.json'), inputFingerprint),
  ...(compiled ? {} : { shaderPublication: 'source' }),
  payload: { engineShaderManifest: `${outputRelative}/shaders/manifest.json` },
  inventory: inventory.length > 0 ? inventory : [`${outputRelative}/shaders/manifest.json`],
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const facts = writeProductionFacts(
  compiled ? 1 : 0,
  Number((performance.now() - startedAt).toFixed(1)),
);
process.stdout.write(
  `${JSON.stringify({ manifest: join(output, 'manifest.json'), files: inventory.length, facts })}\n`,
);
