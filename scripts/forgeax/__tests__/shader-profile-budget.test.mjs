import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

test('profile packaging admits its own heap before reading complete publications', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-profile-budget-'));
  const write = (file, source) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  };
  try {
    for (const file of [
      'scripts/forgeax/prepare-shader-release-inputs.mjs',
      'scripts/lib/shader-source-budget.mjs',
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(new URL(`../../../${file}`, import.meta.url), join(root, file));
    }
    write('package.json', '{"type":"module"}');
    const resources = readFileSync(
      new URL('../../lib/runner-resources.mjs', import.meta.url),
      'utf8',
    );
    write(
      'scripts/lib/runner-resources.mjs',
      `${resources.replace('export function runnerResources(', 'function actualRunnerResources(')}
      export const runnerResources = () => ({cpus: 8, memoryBytes: 16 * 1024 ** 3});`,
    );
    write(
      'scripts/lib/shared-build-cache.mjs',
      `import {resolve, dirname} from 'node:path';
      export const reusableSharedShader = (_root, path) => resolve(dirname(path), 'shaders/manifest.json');
      export const sharedShaderInputFingerprint = () => "fixture";`,
    );
    write(
      'packages/vite-plugin-shader/dist/source-digest.mjs',
      'export const engineShaderSourceDigest = () => "fixture-source";',
    );
    write(
      'packages/vite-plugin-shader/dist/packaged-profiles.mjs',
      `import {getHeapStatistics} from 'node:v8';
      export const PACKAGED_PROFILE_NAMES = ['base-ssao', 'point-ssao'];
      export const PACKAGED_PROFILES_FILE = 'profiles.json.gz';
      export const decodePackagedProfiles = () => undefined;
      export const packagedProfilePublication = () => undefined;
      export function encodePackagedProfiles(input) {
        if (getHeapStatistics().heap_size_limit < 8192 * 1024 ** 2) throw Error('default heap reached profile encoder');
        if (process.env.FORGEAX_SHADER_COMPILE_WORKERS !== '1') throw Error('SDK worker count changed');
        if (!process.env.NODE_OPTIONS.includes('--trace-warnings')) throw Error('lost environment options');
        return JSON.stringify(input);
      }`,
    );
    write(
      'packages/shader/src/default-standard-pbr.wgsl',
      '#import forgeax::slot::surface::main\n',
    );
    write(
      'packages/shader/src/surface.wgsl',
      '#define_import_path forgeax_material::default_standard_surface\nfixture\n',
    );
    for (const profile of ['base-ssao', 'point-ssao']) {
      write(
        `shared-build-inputs-release/${profile}/shaders/manifest.json`,
        JSON.stringify({ profile, bytes: 'original' }),
      );
    }
    const result = spawnSync(
      process.execPath,
      ['scripts/forgeax/prepare-shader-release-inputs.mjs'],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: '--trace-warnings --max-old-space-size=128',
          FORGEAX_SHADER_COMPILE_WORKERS: '1',
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = JSON.parse(
      readFileSync(
        join(root, 'packages/vite-plugin-shader/dist/engine-inputs/profiles.json.gz'),
        'utf8',
      ),
    );
    assert.deepEqual(output.publications, {
      'base-ssao': { profile: 'base-ssao', bytes: 'original' },
      'point-ssao': { profile: 'point-ssao', bytes: 'original' },
    });
    assert.equal(output.shaderSourceDigest, 'fixture-source');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
