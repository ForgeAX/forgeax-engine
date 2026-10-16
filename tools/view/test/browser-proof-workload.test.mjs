import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { browserProofWorkload } from '../scripts/browser-proof-workload.mjs';

test('installed Game3D fixture needs no contributor helper and preserves every light and cascade', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'view-public-game3d-fixture-'));
  try {
    const checkout = join(temp, 'sdk');
    const assets = join(checkout, 'templates/game-3d/assets');
    await mkdir(assets, { recursive: true });
    const authored = 'DirectionalLight: { mapSize: 1024, cascadeCount: 3, castShadow: true },\nPointLight: { intensity: 52, range: 12 },\n';
    await writeFile(join(assets, 'scene.pack.ts'), authored);
    await writeFile(join(assets, 'geometry.pack.ts'), 'createSphereGeometry(1, 32, 24)');
    const source = await readFile(new URL('../scripts/verify-game3d-workspace.mjs', import.meta.url), 'utf8');
    const start = source.indexOf("  await cp(join(checkout, 'templates/game-3d/assets')");
    const end = source.indexOf('  const manifest =', start);
    assert.ok(start >= 0 && end > start);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const prepare = new AsyncFunction('checkout', 'root', 'cp', 'join', 'process', 'pathToFileURL', 'readFile', 'writeFile', 'assert', source.slice(start, end));
    for (const lightweight of [false, true]) {
      const root = join(temp, lightweight ? 'ci-project' : 'ordinary-project');
      await prepare(checkout, root, cp, join, { env: { FORGEAX_BROWSER_CI_LIGHTWEIGHT: lightweight ? '1' : '0' } }, pathToFileURL, readFile, writeFile, assert);
      assert.equal(await readFile(join(root, 'assets/scene.pack.ts'), 'utf8'), lightweight ? authored.replace('mapSize: 1024,', 'mapSize: 256,') : authored);
      assert.equal(await readFile(join(root, 'assets/geometry.pack.ts'), 'utf8'), 'createSphereGeometry(1, 32, 24)');
      assert.equal(await readFile(join(assets, 'scene.pack.ts'), 'utf8'), authored);
    }
    await writeFile(join(assets, 'scene.pack.ts'), authored.replace('mapSize: 1024,', 'mapSize: 512,'));
    await assert.rejects(prepare(checkout, join(temp, 'changed-project'), cp, join, { env: { FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1' } }, pathToFileURL, readFile, writeFile, assert), /view-ci-shadow-fixture-changed/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('CI admits sixty completed frames and repeated device retirement; full diagnostics remain available', () => {
  assert.deepEqual(browserProofWorkload(true), {
    runtimeViewport: { width: 1000, height: 700 }, gameViewport: { width: 1000, height: 700 },
    sceneFrames: 60, resourceCycles: 2,
  });
  assert.deepEqual(browserProofWorkload(false), {
    runtimeViewport: { width: 1440, height: 1000 }, gameViewport: { width: 1440, height: 900 },
    sceneFrames: 300, resourceCycles: 6,
  });
});

test('both real browser probes retain readiness and retirement assertions with the CI workload', async () => {
  const runtime = await readFile(new URL('../scripts/verify-runtime-content-engine.mjs', import.meta.url), 'utf8');
  const game = await readFile(new URL('../scripts/verify-game3d-workspace.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /frameStart \+ workload.sceneFrames, \{ timeout: 180000 \}/);
  assert.match(runtime, /completedFrames - frameStart >= workload.sceneFrames/);
  assert.match(runtime, /index < workload.resourceCycles/);
  assert.match(runtime, /const previewDevice = created.find\(device => device.id === open.previewDevice\)/);
  assert.match(runtime, /assert.ok\(previewDevice, 'opening this dedicated preview must create its canvas-owned GPU device'\)/);
  assert.match(runtime, /released\?\.buffers, 0/);
  assert.match(runtime, /released\?\.textures, 0/);
  assert.match(runtime, /pixels.count > 1000/);
  assert.match(game, /workspace.capture\(args\)/);
  assert.match(game, /dataset.forgeaxFrameCompleted \?\? 0\) >= 60, undefined, \{ timeout: 180_000 \}/);
});

test('the workflow uses every Engine-owned shard and rejects invalid matrix IDs', async () => {
  const workflow = (await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const script = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)          NODE/)[1];
  const execute = shards => {
    let output;
    runInNewContext(script.replace(/^\s*import.*;\n/gm, ''), {
      process: { execPath: 'node', env: { GITHUB_OUTPUT: '/outputs' } },
      execFileSync: (_file, args) => {
        assert.deepEqual(Array.from(args), ['scripts/ci/run-view-integration.mjs', '--list-shards']);
        return JSON.stringify(shards);
      },
      appendFileSync: (_path, value) => { output = value; },
    });
    return JSON.parse(output.trim().slice('shards='.length));
  };
  for (const ids of [[0, 1, 2, 3], [3, 2, 1, 0]]) assert.deepEqual(execute(ids), ids);
  for (const invalid of [[], [0, 1, 2], [0, 1, 2, 3, 4], [0, 1, 2, 2], [0, 1, 2, '3'], [0, 1, 2, -1], [0, 1, 2, 0.5], {}, null]) {
    assert.throws(() => execute(invalid), /four unique numeric shard IDs/);
  }
  const enginePackage = dirname(fileURLToPath(import.meta.resolve('@forgeax/engine/package.json')));
  const engineRunner = resolve(enginePackage, '../../scripts/ci/run-view-integration.mjs');
  const plan = (...args) => JSON.parse(execFileSync(process.execPath, [engineRunner, '--candidate', ...args], { encoding: 'utf8' }));
  const ids = execute(plan('--list-shards'));
  const all = plan('--dry-run').filter(([owner]) => owner !== 'prepare').map(step => JSON.stringify(step)).sort();
  const selected = ids.flatMap(id => plan('--shard', String(id), '--dry-run').filter(([owner]) => owner !== 'prepare').map(step => JSON.stringify(step))).sort();
  assert.deepEqual(selected, all);
  assert.match(workflow, /FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1'/);
  assert.match(workflow, /view_shards: \$\{\{ steps.view-shards.outputs.shards \}\}/);
  assert.match(workflow, /shard: \$\{\{ fromJSON\(needs.build.outputs.view_shards\) \}\}/);
  assert.match(workflow, /run: xvfb-run -a pnpm test:view -- --candidate --shard \$\{\{ matrix.shard \}\}/);
  assert.doesNotMatch(workflow, /--list-groups|VIEW_CONSUMER_GROUPS|--group|owner %/);
  assert.match(workflow, /name: view-candidate-evidence-shard-\$\{\{ matrix.shard \}\}/);
});

test('the Runtime Capture probe preserves its qualified independent-run dimensions under CI', async () => {
  const source = await readFile(new URL('../scripts/verify-engine-plugin-boundary.mjs', import.meta.url), 'utf8');
  assert.match(source, /FORGEAX_BROWSER_CI_VIEWPORT_WIDTH = '1280'/);
  assert.match(source, /FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT = '720'/);
  const capture = await readFile(new URL('../scripts/verify-runtime-capture.mjs', import.meta.url), 'utf8');
  assert.match(capture, /image.naturalWidth === 1280 && image.naturalHeight === 720/);
  assert.match(capture, /assert.ok\(firstFrame >= 300\)/);
  assert.match(capture, /timeout: 30_000/);
});

test('the combined plugin probe bounds panel rendering while retaining its ten Play cycles and original capture gate', async () => {
  const source = await readFile(new URL('../scripts/verify-engine-plugin-boundary.mjs', import.meta.url), 'utf8');
  assert.match(source, /viewport: workload.gameViewport/);
  assert.match(source, /FORGEAX_PLAY_CYCLES \?\? 10/);
  const inline = await readFile(new URL('../scripts/verify-inline-previews.mjs', import.meta.url), 'utf8');
  assert.match(inline, /workspace.capture\(args\)/);
  assert.match(inline, /visible previews render at the panel device-pixel extent/);
});
