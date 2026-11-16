import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { zstdCompressSync } from 'node:zlib';
import { readShaderManifestText } from '../../lib/shader-manifest.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const owners = [
  'apps/hello/triangle/scripts/smoke-dawn.mjs',
  'apps/hello/tilemap/scripts/smoke-dawn.mjs',
  'apps/hello/physics/scripts/smoke.mjs',
  'apps/learn-render/4.advanced-opengl/5.framebuffers/scripts/smoke-dawn.mjs',
  'apps/hello/video-cutscene/scripts/smoke-dawn.mjs',
  'apps/hello/skin/scripts/smoke-writeback-dawn.mjs',
  'apps/hello/asi-world/scripts/smoke-dawn.mjs',
  'apps/hello/culling/scripts/smoke-dawn.mjs',
  'apps/hello/app/scripts/smoke.mjs',
  'apps/hello/tonemap/scripts/smoke-dawn.mjs',
  'apps/hello/fxaa/scripts/smoke-dawn.mjs',
  'apps/learn-render/3.model-loading/1.model-loading/scripts/smoke-dawn.mjs',
  'apps/hello/gltf/scripts/smoke-dawn.mjs',
  'apps/hello/gltf-instancing/scripts/smoke-dawn.mjs',
  'apps/hello/shadow-opt-out/scripts/smoke-dawn.mjs',
  'apps/hello/skin/scripts/smoke-dawn.mjs',
  'apps/hello/video-texture/scripts/smoke-dawn.mjs',
  'apps/hello/picking/scripts/smoke-dawn.mjs',
  'apps/hello/audio/scripts/smoke.mjs',
  'apps/hello/character/scripts/smoke.mjs',
  'apps/hello/text/scripts/smoke-dawn.mjs',
  'apps/hello/transform-hierarchy/scripts/smoke-dawn.mjs',
  'apps/hello/hdrp-lighting/scripts/smoke-dawn.mjs',
  'apps/hello/topology/scripts/smoke-dawn.mjs',
  'apps/shadertoy/fractal-pyramid/scripts/smoke-dawn.mjs',
  'apps/learn-render/5.advanced-lighting/7.bloom/scripts/smoke-dawn.mjs',
  'apps/hello/multi-material/scripts/smoke-dawn.mjs',
  'apps/hello/tilemap-object-layer/scripts/smoke-dawn.mjs',
  'apps/hello/fbx-cube/scripts/smoke-dawn.mjs',
  'apps/hello/fbx-skin/scripts/smoke-dawn.mjs',
  'apps/shadertoy/happy-blob/scripts/smoke-dawn.mjs',
  'apps/hello-multi-uv/scripts/smoke-dawn.mjs',
];
const document = JSON.stringify({
  schemaVersion: 3,
  profile: 'point-ssao',
  entries: [{ identifier: 'probe', source: 'λ "{}%#?&/\\'.repeat(8192) }],
});

function manifestTransport(owner, path, requestedIdentifier) {
  const source = readFileSync(resolve(root, owner), 'utf8');
  const declaration = [
    ...source.matchAll(/\b(ASSETS_MANIFEST_URL|MANIFEST_URL|manifestUrl)\s*=\s*([^;]+);/g),
  ].find(
    (match) =>
      (requestedIdentifier === undefined
        ? match[1] !== 'ASSETS_MANIFEST_URL'
        : match[1] === requestedIdentifier) &&
      (match[2].includes('URL.') || match[2].includes('data:application/json')),
  );
  const expression = (
    declaration?.[2] ?? source.match(/createTilemapSmoke\((`[^`]+`)\)/)?.[1]
  )?.replace("new URL('../dist/shaders/manifest.json', import.meta.url)", 'MANIFEST_PATH');
  const identifier = declaration?.[1] ?? 'MANIFEST_URL';
  assert.ok(expression, `${owner} must expose its actual manifest transport`);
  const cleanup = source.match(
    new RegExp(
      `process\\.once\\('exit',\\s*\\(\\)\\s*=>\\s*URL\\.revokeObjectURL\\(${identifier}\\)\\);`,
    ),
  );
  const releases = [];
  const optionalTry = source.match(
    /let MANIFEST_URL = '';\s*try\s*\{[^}]*\{ type: 'application\/json' \}[^}]*\}\s*catch\s*\{\}/,
  );
  const program =
    owner.includes('/fbx-skin/') && optionalTry !== null
      ? `${optionalTry[0]} MANIFEST_URL;`
      : `const ${identifier} = ${expression}; ${cleanup?.[0] ?? ''} ${identifier};`;
  const url = runInNewContext(program, {
    MANIFEST_PATH: path,
    manifestPath: path,
    DEMO_MANIFEST_PATH: path,
    manifestRaw: expression.includes('manifestRaw') ? readShaderManifestText(path) : undefined,
    demoManifest: expression.includes('demoManifest')
      ? JSON.parse(readShaderManifestText(path))
      : undefined,
    manifestExists: existsSync,
    manifest:
      declaration?.[1] === 'manifestUrl'
        ? path
        : expression.includes('[manifest]')
          ? readShaderManifestText(path)
          : undefined,
    Blob,
    URL,
    readShaderManifestText,
    encodeURIComponent() {
      throw new RangeError('Full-manifest URI encoding exceeds the native string limit');
    },
    process: {
      once(event, release) {
        assert.equal(event, 'exit');
        releases.push(release);
      },
    },
  });
  return { url, releases };
}

for (const owner of owners) {
  test(`${owner} loads the complete native manifest without URI expansion`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeax-native-manifest-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const bytes of [Buffer.from(document), zstdCompressSync(Buffer.from(document))]) {
      const path = join(directory, 'manifest.json');
      writeFileSync(path, bytes);
      const { url, releases } = manifestTransport(owner, path);
      try {
        const response = await fetch(url);
        assert.equal(response.ok, true);
        assert.equal(await response.text(), document);
        assert.equal(releases.length, 1);
      } finally {
        for (const release of releases) release();
      }
      await assert.rejects(fetch(url));
    }
  });

  test(`${owner} preserves missing and corrupt manifest failures`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeax-native-manifest-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'manifest.json');
    if (owner.includes('/fbx-cube/') || owner.includes('/fbx-skin/')) {
      const result = manifestTransport(owner, path);
      assert.equal(result.url, '');
      for (const release of result.releases) release();
    } else {
      assert.throws(() => manifestTransport(owner, path), { code: 'ENOENT' });
    }
    writeFileSync(path, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0xff, 0xff, 0xff]));
    if (owner.includes('/fbx-skin/')) {
      assert.equal(manifestTransport(owner, path).url, '');
    } else {
      assert.throws(() => manifestTransport(owner, path));
    }
  });
}

test('multi-uv asset publication retains its separate full-payload transport and cleanup', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-native-manifest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'manifest.json');
  for (const bytes of [Buffer.from(document), zstdCompressSync(Buffer.from(document))]) {
    writeFileSync(path, bytes);
    const { url, releases } = manifestTransport(
      'apps/hello-multi-uv/scripts/smoke-dawn.mjs',
      path,
      'ASSETS_MANIFEST_URL',
    );
    try {
      assert.equal(await (await fetch(url)).text(), document);
      assert.equal(releases.length, 1);
    } finally {
      for (const release of releases) release();
    }
    await assert.rejects(fetch(url));
  }
});
