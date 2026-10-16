import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanMaterialLegacySurface } from '../forgeax/check-material-legacy-surface.mjs';

function packFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ['dist', 'node_modules', '.forgeax-debug'].includes(entry.name)) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...packFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.pack.json')) files.push(path);
  }
  return files;
}

test('app author and load consumers contain no legacy material surface', () => {
  const report = scanMaterialLegacySurface(process.cwd(), {
    paths: ['apps', 'templates'],
    consumerOnly: true,
  });
  const hits = report.hits.filter(({ patterns }) =>
    patterns.some((pattern) =>
      [
        'material-shader-registration',
        'material-artifact-installation',
        'wgsl-sidecar',
        'param-values',
        'global-uv-set',
        'pass-shader',
      ].includes(pattern),
    ),
  );
  assert.deepEqual(
    hits,
    [],
    `legacy app material surface remains:\n${hits
      .map(({ channel, path, patterns }) => `${channel} ${path} [${patterns.join(', ')}]`)
      .join('\n')}`,
  );
});

test('consumer scan catches registration calls but ignores negative fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-material-consumer-'));
  try {
    await mkdir(join(root, 'apps/demo/src/__tests__'), { recursive: true });
    await writeFile(
      join(root, 'apps/demo/src/main.ts'),
      "registry.installMaterialArtifact('demo::shader', { source });\nregistry.registerMaterialShader('demo::legacy');\n",
    );
    await writeFile(
      join(root, 'apps/demo/src/__tests__/negative.ts'),
      "export const fixture = 'installMaterialArtifact(';\n",
    );

    const report = scanMaterialLegacySurface(root, { paths: ['apps'], consumerOnly: true });
    assert.deepEqual(report.hits, [
      {
        channel: 'typescript-import',
        path: 'apps/demo/src/main.ts',
        patterns: ['material-shader-registration', 'material-artifact-installation'],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('material pack passes keep scheduling metadata inside renderState', () => {
  const failures = [];
  for (const root of ['apps', 'templates']) {
    for (const file of packFiles(root)) {
      const pack = JSON.parse(readFileSync(file, 'utf8'));
      for (const asset of pack.assets ?? []) {
        if (asset?.kind !== 'material') continue;
        for (const pass of asset.payload?.passes ?? []) {
          const stale = ['tags', 'queue', 'passKind'].filter((field) => field in pass);
          if (stale.length > 0) failures.push(`${file}: ${pass.name} [${stale.join(', ')}]`);
        }
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `material pass scheduling metadata escaped renderState:\n${failures.join('\n')}`,
  );
});
