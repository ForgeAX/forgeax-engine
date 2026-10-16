import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildManifest, scanDemos } from '../scripts/scan-demos.mjs';

async function writeDemo(appsDir, route, manifest = {}) {
  const directory = join(appsDir, ...route.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.html'), '<main>demo</main>\n');
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: `@fixture/${route.replaceAll('/', '-')}`,
        scripts: { dev: 'vite' },
        ...manifest,
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

test('discovers new nested demos without a maintained allowlist', async (t) => {
  const appsDir = await mkdtemp(join(tmpdir(), 'forgeax-demo-gallery-'));
  t.after(() => rm(appsDir, { recursive: true, force: true }));

  await writeDemo(appsDir, 'hello/automatic-demo', {
    description: 'Automatically discovered fixture.',
  });
  await writeDemo(appsDir, 'bevy/second-demo');

  const demos = scanDemos(appsDir);
  assert.deepEqual(
    demos.map(({ route, category }) => ({ route, category })),
    [
      { route: 'bevy/second-demo', category: 'bevy' },
      { route: 'hello/automatic-demo', category: 'hello' },
    ],
  );

  const manifest = buildManifest(appsDir);
  assert.equal(manifest.count, 2);
  assert.deepEqual(manifest.categories, ['bevy', 'hello']);
  assert.equal(manifest.demos[1].url, '/demos/hello/automatic-demo/');
});

test('excludes infrastructure and directories that do not satisfy the demo contract', async (t) => {
  const appsDir = await mkdtemp(join(tmpdir(), 'forgeax-demo-gallery-'));
  t.after(() => rm(appsDir, { recursive: true, force: true }));

  await writeDemo(appsDir, 'demo-gallery');
  await writeDemo(appsDir, 'shared');
  await writeDemo(appsDir, 'hello/valid');
  await writeDemo(appsDir, 'hello/no-dev', { scripts: {} });
  await mkdir(join(appsDir, 'hello', 'no-package'), { recursive: true });
  await writeFile(join(appsDir, 'hello', 'no-package', 'index.html'), '<main>missing package</main>\n');

  assert.deepEqual(
    scanDemos(appsDir).map(({ route }) => route),
    ['hello/valid'],
  );
});

test('stops recursion at a demo root and scans its material packages', async (t) => {
  const appsDir = await mkdtemp(join(tmpdir(), 'forgeax-demo-gallery-'));
  t.after(() => rm(appsDir, { recursive: true, force: true }));

  const demoDir = await writeDemo(appsDir, 'hello/material-demo');
  const nested = join(demoDir, 'assets', 'nested');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'surface.pack.json'), '{}\n');
  await writeFile(join(nested, 'generated.pack.ts'), 'export default {};\n');
  await writeDemo(appsDir, 'hello/material-demo/assets/not-a-separate-demo');

  const demos = scanDemos(appsDir);
  assert.equal(demos.length, 1);
  assert.equal(demos[0].route, 'hello/material-demo');
  assert.deepEqual(
    demos[0].materialPackages.map((path) => path.slice(demoDir.length + 1)),
    ['assets/nested/generated.pack.ts', 'assets/nested/surface.pack.json'],
  );
});
