import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  engineShaderSourceDigest,
  PACKAGED_SOURCE_RECORD,
} from '../../packages/vite-plugin-shader/dist/source-digest.mjs';
import { reusableSharedShader, sharedShaderInputFingerprint } from '../lib/shared-build-cache.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(root, 'packages/shader/src');
const inputIndex = process.argv.indexOf('--input');
const inputRoot = resolve(
  root,
  inputIndex >= 0
    ? (process.argv[inputIndex + 1] ?? 'shared-build-inputs-release')
    : 'shared-build-inputs-release',
);
const outputIndex = process.argv.indexOf('--output');
const outputRoot = resolve(
  root,
  outputIndex >= 0
    ? (process.argv[outputIndex + 1] ?? 'packages/vite-plugin-shader/dist/engine-inputs')
    : 'packages/vite-plugin-shader/dist/engine-inputs',
);
const profileFlags = {
  'base-ssao': ['--no-point-shadows'],
  'point-ssao': [],
};
const profileIndex = process.argv.indexOf('--profile');
const profiles = profileIndex < 0 ? Object.keys(profileFlags) : [process.argv[profileIndex + 1]];
for (const profile of profiles) {
  if (!Object.hasOwn(profileFlags, profile)) throw new Error(`unknown shader profile: ${profile}`);
}
const sharedIndex = process.argv.indexOf('--shared-input-manifest');
if (sharedIndex >= 0 && !process.argv[sharedIndex + 1]) {
  throw new Error('--shared-input-manifest requires a manifest path');
}
const shaderManifests = new Map();
if (process.argv.includes('--build')) {
  for (const profile of profiles) {
    if (process.env.FORGEAX_BUILD_NO_TASK_CACHE !== '1') {
      const inputFingerprint = sharedShaderInputFingerprint(root, {
        pointShadows: !profileFlags[profile].includes('--no-point-shadows'),
        hdrpSsao: !profileFlags[profile].includes('--no-hdrp-ssao'),
      });
      const candidates = [
        ...(sharedIndex >= 0 ? [['shared', resolve(root, process.argv[sharedIndex + 1])]] : []),
        // Core transfers this producer's ordinary receipt and payload inside
        // engine-dist. A mismatched point input cannot satisfy base admission.
        [
          'core',
          resolve(
            root,
            'packages/vite-plugin-shader/dist/engine-inputs/ci',
            profile,
            'manifest.json',
          ),
        ],
        ['cached', resolve(inputRoot, profile, 'manifest.json')],
      ];
      for (const [kind, path] of candidates) {
        const shared = reusableSharedShader(root, path, inputFingerprint, (reason) =>
          console.log(
            `[shader-profile] ${kind} ${profile} unavailable: ${reason}; trying next input`,
          ),
        );
        if (shared !== null) {
          shaderManifests.set(profile, shared);
          console.log(`[shader-profile] verified ${kind} ${profile}; compile count=0`);
          break;
        }
      }
      if (shaderManifests.has(profile)) continue;
    }
    // Inherit the caller's process group so the browser gate's existing
    // supervisor also owns this compiler and its children on cancellation.
    const result = spawnSync(
      process.execPath,
      [
        'scripts/build-shared-inputs.mjs',
        '--root',
        root,
        '--out',
        resolve(inputRoot, profile),
        ...profileFlags[profile],
      ],
      {
        cwd: root,
        env: { ...process.env, FORGEAX_ENGINE_SHADER_SOURCE_BUILD: '1' },
        stdio: 'inherit',
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.signal)
      throw new Error(`Shader profile ${profile} compiler exited by ${result.signal}`);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
const importPattern = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m;

async function collectShaderSources(root) {
  const sources = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await collectShaderSources(path)));
    } else if (entry.isFile() && entry.name.endsWith('.wgsl')) {
      sources.push(path);
    }
  }
  return sources;
}

const imports = {};
for (const path of (await collectShaderSources(sourceRoot)).sort()) {
  const source = await readFile(path, 'utf8');
  const identifier = importPattern.exec(source)?.[1];
  if (identifier !== undefined) imports[identifier] = source;
}

const defaultSurfaceSource = imports['forgeax_material::default_standard_surface'];
if (defaultSurfaceSource === undefined) {
  throw new Error('default_standard_surface is missing from the shader import source catalog');
}
const standardTemplate = await readFile(resolve(sourceRoot, 'default-standard-pbr.wgsl'), 'utf8');
const surfaceSlotModule = /^\s*#import\s+([A-Za-z0-9_.:-]+::slot::surface)::/m.exec(
  standardTemplate,
)?.[1];
if (surfaceSlotModule === undefined) {
  throw new Error('Standard shader does not declare the canonical surface slot import');
}
imports[surfaceSlotModule] = defaultSurfaceSource.replace(
  /^\s*#define_import_path\s+[^\n]+/m,
  `#define_import_path ${surfaceSlotModule}`,
);

const shaderSourceDigest = engineShaderSourceDigest(sourceRoot);
if (shaderSourceDigest === undefined) {
  throw new Error(`engine shader sources are missing: ${sourceRoot}`);
}

await mkdir(outputRoot, { recursive: true });
// These generated copies differ only by the optional SSAO utility.
for (const redundant of ['base-base', 'point-base']) {
  await rm(resolve(outputRoot, redundant), { recursive: true, force: true });
}
await Promise.all(
  profiles.map(async (profile) => {
    const target = resolve(outputRoot, profile);
    // Replace only generated profile payloads, never package declarations or
    // an independently prepared profile beside them.
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await Promise.all([
      cp(
        shaderManifests.get(profile) ?? resolve(inputRoot, profile, 'shaders/manifest.json'),
        resolve(target, 'manifest.json'),
      ),
      writeFile(resolve(target, 'imports.json'), `${JSON.stringify(imports, null, 2)}\n`),
      writeFile(
        resolve(target, PACKAGED_SOURCE_RECORD),
        `${JSON.stringify({ shaderSourceDigest }, null, 2)}\n`,
      ),
    ]);
  }),
);

process.stdout.write(
  `${JSON.stringify({ outputRoot, profiles, imports: Object.keys(imports).length }, null, 2)}\n`,
);
