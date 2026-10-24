import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  discoverSdkTemplates,
  SDK_MANIFEST_VERSION,
  SDK_RESOURCE_ALLOWLIST,
  SDK_SOURCE_EXCLUDED_PATHS,
  SDK_SOURCE_FORMAT,
  SDK_SOURCE_GIT_DEPENDENCIES,
  SDK_SOURCE_ROOT,
  SDK_SOURCE_WASM,
  SDK_TEMPLATE_RESOURCE_ALLOWLIST,
  SDK_TEMPLATES,
  sdkResourceManifest,
  sdkTemplateResourceManifest,
} from '../forgeax/sdk-lib.mjs';
import { reduceTestProject } from '../test/reduce-test-project.mjs';
import quality from '../test/render-quality.json' with { type: 'json' };

test('SDK template discovery fails closed on orphan and invalid descriptors', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-templates-'));
  try {
    await mkdir(resolve(root, 'orphan'));
    assert.throws(() => discoverSdkTemplates(root), /sdk-template-descriptor-missing/);
    await rm(resolve(root, 'orphan'), { recursive: true, force: true });
    await mkdir(resolve(root, 'broken'));
    await writeFile(
      resolve(root, 'broken', 'template.json'),
      JSON.stringify({ id: 'broken', purpose: 'broken', defaultIdentity: {}, journeys: [] }),
    );
    assert.throws(() => discoverSdkTemplates(root), /sdk-template-descriptor-invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SDK source contract keeps the source root and prebuilt WASM closure explicit', () => {
  assert.equal(SDK_MANIFEST_VERSION, '1.11.0');
  assert.equal(SDK_SOURCE_FORMAT, 'git-archive-public-snapshot');
  assert.deepEqual(SDK_SOURCE_EXCLUDED_PATHS, [
    '.gitmodules',
    'forgeax-engine-assets',
    '.github',
    'third_party/wgpu/.github',
    'third_party/blitz/.github',
    'tools/view/.github',
  ]);
  assert.equal(SDK_SOURCE_ROOT, 'source/engine');
  assert.deepEqual(SDK_TEMPLATES, discoverSdkTemplates());
  assert.deepEqual(
    SDK_TEMPLATES.map(({ id }) => id),
    ['empty', 'game-3d'],
  );
  assert.deepEqual(
    SDK_SOURCE_WASM.map(({ package: packageName }) => packageName),
    [
      '@forgeax/engine-physics-rapier2d',
      '@forgeax/engine-physics-rapier3d',
      '@forgeax/engine-ui-blitz',
      '@forgeax/engine-wgpu-wasm',
      '@forgeax/engine-fbx',
      '@forgeax/engine-codec',
    ],
  );
  assert.equal(
    SDK_SOURCE_WASM.find(
      ({ package: packageName }) => packageName === '@forgeax/engine-wgpu-wasm',
    )?.files.includes('provenance.json'),
    true,
  );
  for (const entry of SDK_SOURCE_WASM) {
    assert.equal(new Set(entry.files).size, entry.files.length);
    assert.equal(
      entry.files.every((file) => !file.startsWith('/')),
      true,
    );
  }
  for (const entry of SDK_SOURCE_WASM.filter((entry) => entry.package.includes('physics-rapier'))) {
    assert.deepEqual(entry.postinstallScripts, []);
    assert.deepEqual(entry.files, [
      'rapier-native.mjs',
      'rapier-native.d.mts',
      'rapier.wasm',
      'rapier.mjs',
      'rapier.d.mts',
      'LICENSE',
      'provenance.json',
    ]);
  }
});

test('SDK resource closure is an explicit public allowlist', () => {
  assert.deepEqual(SDK_RESOURCE_ALLOWLIST, [
    {
      id: 'preview-canonical-kit',
      package: '@forgeax/engine-preview',
      sourceRoot: 'packages/preview/assets/canonical-kit',
      packageRoot: 'assets/canonical-kit',
      files: ['cook-receipt.json', 'sky.hdr', 'sky.hdr.meta.json'],
    },
  ]);
  assert.deepEqual(sdkResourceManifest(), SDK_RESOURCE_ALLOWLIST);
  for (const resource of SDK_RESOURCE_ALLOWLIST) {
    assert.equal(new Set(resource.files).size, resource.files.length);
    assert.equal(resource.sourceRoot.startsWith('/'), false);
    assert.equal(resource.packageRoot.startsWith('/'), false);
    assert.equal(resource.sourceRoot.includes('forgeax-engine-assets'), false);
    assert.equal(resource.packageRoot.includes('forgeax-engine-assets'), false);
    assert.equal(
      resource.files.every((file) => !file.startsWith('/')),
      true,
    );
  }
});

test('SDK artifact schema admits exact Engine reuse references', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../../schemas/sdk-manifest.schema.json', import.meta.url), 'utf8'),
  );
  const validate = new Ajv2020().compile(schema.$defs.artifact);
  const artifact = {
    path: 'source/engine/packages/math/dist/index.mjs',
    bytes: 42,
    sha256: 'a'.repeat(64),
  };
  assert.equal(
    validate({ ...artifact, enginePath: 'node_modules/@forgeax/engine-math/dist/index.mjs' }),
    true,
  );
  assert.equal(validate({ ...artifact, enginePath: '' }), false);
});

test('SDK package inventory admits the embedded View tool at its shipped path', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../../schemas/sdk-manifest.schema.json', import.meta.url), 'utf8'),
  );
  const validate = new Ajv2020().compile(schema.$defs.package);
  const tool = {
    name: '@forgeax/view',
    version: '1.2.3',
    role: 'tool',
    root: 'tools/view',
    fileCount: 1,
    byteCount: 1,
  };
  assert.equal(validate(tool), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...tool, root: 'tools/unknown' }), false);
});

test('SDK source schema admits every expanded maintained dependency', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../../schemas/sdk-manifest.schema.json', import.meta.url), 'utf8'),
  );
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
    schema.$defs.source.properties.gitDependencies,
  );
  const dependencies = SDK_SOURCE_GIT_DEPENDENCIES.map((root) => ({
    root,
    commit: 'a'.repeat(40),
  }));
  assert.equal(validate(dependencies), true, JSON.stringify(validate.errors));
  assert.equal(
    validate([...dependencies, { root: 'unknown-source', commit: 'a'.repeat(40) }]),
    false,
  );
});

test('SDK templates need no contributor-only resource closure', () => {
  assert.deepEqual(SDK_TEMPLATE_RESOURCE_ALLOWLIST, []);
  assert.deepEqual(sdkTemplateResourceManifest(), []);
});

test('SDK manifest admits a pack-only template set with no copied resources', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../../schemas/sdk-manifest.schema.json', import.meta.url), 'utf8'),
  );
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile({
    ...schema.properties.templateResources,
    $defs: schema.$defs,
  });
  assert.equal(validate([]), true, JSON.stringify(validate.errors));
  assert.equal(
    validate([{ id: 'generated-assets', root: 'templates/game-3d/assets/', files: [] }]),
    false,
  );
});

test('SDK CI workload reduces only the generated consumer through the shared test-project owner', async () => {
  const source = await readFile(new URL('../forgeax/verify-sdk.mjs', import.meta.url), 'utf8');
  const selected = source.slice(source.indexOf('async function verifySelectedTemplate()'));
  assert.match(
    selected,
    /if \(process\.env\.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'\) \{\s*await reduceTestProject\(selectedProject\);\s*\}/,
  );
  const template = new URL('../../templates/game-3d/assets/', import.meta.url);
  const original = await readFile(new URL('scene.pack.ts', template), 'utf8');
  const root = await mkdtemp(resolve(tmpdir(), 'sdk-ci-consumer-'));
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'assets/scene.pack.ts'), original);
    await reduceTestProject(root);
    const reduced = await readFile(resolve(root, 'assets/scene.pack.ts'), 'utf8');
    const light = /DirectionalLight: \{([^{}]*)\}/.exec(reduced)?.[1] ?? '';
    assert.match(light, new RegExp(`mapSize: ${quality.shadowMapSize}\\b`));
    assert.match(light, new RegExp(`cascadeCount: ${quality.cascadeCount}\\b`));
    assert.equal(
      await readFile(new URL('scene.pack.ts', template), 'utf8'),
      original,
      'source template remains immutable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
