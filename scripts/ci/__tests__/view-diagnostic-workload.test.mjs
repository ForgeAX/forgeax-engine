import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { constants, runInNewContext } from 'node:vm';
import { installRuntimeVase } from '../../template-probes/game-3d/runtime-vase/install.mjs';
import { reduceTestProject } from '../../test/reduce-test-project.mjs';
import quality from '../../test/render-quality.json' with { type: 'json' };

const source = await readFile(
  new URL('../../../tools/view/scripts/verify-diagnostic-pages-integration.mjs', import.meta.url),
  'utf8',
);
const start = source.indexOf('async function prepareDiagnosticGameProject(');
const end = source.indexOf('\ntry {\n for (const directory', start);
assert.ok(start >= 0 && end > start);
const prepare = runInNewContext(
  `${source.slice(start, end)}; prepareDiagnosticGameProject`,
  {
    assert,
    reduceTestProject,
    cp,
    readFile,
    writeFile,
    resolve,
    root: resolve('.'),
    existsSync,
    pathToFileURL,
  },
  { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
);
const template = resolve('templates/game-3d');
const viewIntegration = resolve('scripts/ci/run-view-integration.mjs');
const viewPlan = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, [viewIntegration, '--candidate', ...args], {
      encoding: 'utf8',
    }),
  );
test('complete View owner receipts retain setup headroom inside four original jobs', async () => {
  const receipts = [
    JSON.parse(
      await readFile(
        new URL('./fixtures/view-completed-42130885413.json', import.meta.url),
        'utf8',
      ),
    ),
    JSON.parse(
      await readFile(new URL('./fixtures/view-partial-42955764870.json', import.meta.url), 'utf8'),
    ),
  ];
  const [complete, partial] = receipts;
  assert.equal(Object.hasOwn(complete.completedOwnerSeconds, 'modeling'), false);
  assert.deepEqual(partial.uncompletedOwners, ['modeling']);
  const full = viewPlan('--dry-run').filter(([owner]) => owner !== 'prepare');
  const shards = Array.from({ length: 4 }, (_value, index) =>
    viewPlan('--shard', String(index), '--dry-run').filter(([owner]) => owner !== 'prepare'),
  );
  assert.deepEqual(shards.flat().map(JSON.stringify).sort(), full.map(JSON.stringify).sort());
  const owners = shards.map((steps) => [...new Set(steps.map(([owner]) => owner))]);
  assert.equal(new Set(owners.flat()).size, owners.flat().length);
  for (const owner of owners.flat())
    assert.ok(
      receipts.some(
        (receipt) =>
          Object.hasOwn(receipt.completedOwnerSeconds, owner) ||
          Object.hasOwn(receipt.retainedOwnerSeconds, owner),
      ),
      `complete owner requires a measured or retained forecast: ${owner}`,
    );
  const ownerSeconds = (owner) =>
    Math.max(
      ...receipts.flatMap((receipt) => [
        receipt.completedOwnerSeconds?.[owner] ?? 0,
        receipt.retainedOwnerSeconds?.[owner] ?? 0,
      ]),
    );
  const finishes = owners.map(
    (groups) =>
      groups.reduce((sum, owner) => sum + ownerSeconds(owner), 0) +
      Math.max(...receipts.map((receipt) => receipt.prepareSeconds)) +
      Math.max(...receipts.map((receipt) => receipt.setupAndTransferReserveSeconds)),
  );
  const jobBudgetSeconds = Math.min(...receipts.map((receipt) => receipt.jobBudgetSeconds));
  assert.ok(
    Math.max(...finishes) <= jobBudgetSeconds,
    `complete owners must fit the unchanged 30-minute jobs: ${finishes}`,
  );
});

test('the RHI diagnostic runs first while Modeling keeps its complete GPU owner', () => {
  const shards = Array.from({ length: 4 }, (_value, index) =>
    viewPlan('--shard', String(index), '--dry-run'),
  );
  const groupOwner = (file) =>
    shards.flatMap((steps, shard) =>
      steps.filter(([, , args]) => args[0] === file).map(([owner]) => ({ owner, shard })),
    );
  assert.deepEqual(groupOwner('tools/view/scripts/verify-diagnostic-pages-integration.mjs'), [
    { owner: 'diagnostics', shard: 3 },
  ]);
  assert.deepEqual(groupOwner('tools/view-plugins/integration/verify-modeling.mjs'), [
    { owner: 'modeling', shard: 3 },
  ]);
  assert.equal(
    shards[3].filter(([owner]) => owner === 'diagnostics')[0][2][0],
    'tools/view/scripts/verify-diagnostic-pages-integration.mjs',
    'the live RHI replay must start before the other GPU diagnostic owners',
  );
  assert.deepEqual(
    shards[2].filter(([owner]) => owner !== 'prepare').map(([owner]) => owner),
    ['game3d', 'game3d'],
    'the complete Game 3D chain stays contiguous',
  );
  assert.equal(
    shards[3].at(-1)[0],
    'modeling',
    'Modeling runs after the complete diagnostic replay',
  );
  assert.deepEqual(
    [
      ...new Set(
        shards[0].filter(([owner]) => owner.startsWith('runtime-')).map(([owner]) => owner),
      ),
    ].sort(),
    ['runtime-js', 'runtime-ts'],
    'both complete publication chains share the balanced contract/plugin shard',
  );
  assert.ok(viewPlan('--list-groups').includes('modeling'));
  assert.deepEqual(viewPlan('--list-shards'), [0, 1, 2, 3]);
});
for (const viewport of [
  { width: 860, height: 660 },
  { width: 1440, height: 900 },
])
  test(`the diagnostic resize journey restores its ${viewport.width}x${viewport.height} viewport`, async () => {
    const calls = [];
    const resizeCalls = [...source.matchAll(/await page\.setViewportSize\([^;]+\);/g)];
    assert.equal(resizeCalls.length, 2, 'both real resize transitions remain');
    await runInNewContext(`(async () => { ${resizeCalls.map(([call]) => call).join('\n')} })()`, {
      viewport,
      page: { setViewportSize: async (size) => calls.push({ ...size }) },
    });
    assert.deepEqual(calls[0], { width: 1280, height: 800 });
    assert.deepEqual(
      calls[1],
      viewport,
      'the later RHI journey must return to its configured viewport',
    );
  });
test('Scene resume waits for the actual resize after a completed old-size frame', async () => {
  const start = source.indexOf(
    ' await page.waitForFunction(',
    source.indexOf(' await resizeSceneBuffer(0.5);'),
  );
  const end = source.indexOf('\n scenePresentation.resumed=', start);
  assert.ok(start >= 0 && end > start);
  const canvas = { width: 272, clientWidth: 1204, clientHeight: 658, checkVisibility: () => true };
  const renderer = { execution: { frame: { completed: 90 } } };
  const calls = [];
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    process: { env: { FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1' } },
    document: { querySelector: () => canvas },
    __forgeaxGameInspection: { renderer: () => renderer },
    devicePixelRatio: 2,
    sceneOpened: { preview: { target: { targetId: 'preview-target', generation: 8 } } },
    client: {
      resizePreview: async (request) => {
        assert.deepEqual(calls, ['resized-ready']);
        calls.push({ ...request });
      },
    },
    scenePresentation: {
      active: { canvas: { width: 272 } },
      afterCapture: { after: { renderer: { execution: { frame: { completed: 89 } } } } },
    },
    page: {
      locator: (selector) => {
        assert.equal(selector, 'canvas');
        return { first: () => ({ evaluate: async (read) => read(canvas) }) };
      },
      waitForFunction: async (ready, input, options) => {
        assert.equal(options.timeout, 90000);
        assert.equal(
          ready(input),
          false,
          'an old-size completion must not admit the resized preview',
        );
        canvas.width = 160;
        assert.equal(ready(input), true, 'actual resize and resumed completion admit the preview');
        renderer.execution.frame.completed = 89;
        assert.equal(ready(input), false, 'resizing alone must not replace frame completion');
        renderer.execution.frame.completed = 90;
        calls.push('resized-ready');
      },
    },
  });
  assert.deepEqual(
    calls,
    [
      'resized-ready',
      { targetId: 'preview-target', targetGeneration: 8, width: 2408, height: 1316 },
    ],
    'the workspace receives the actual DPR extent only after the resized frame is ready',
  );
});
for (const operation of ['start', 'stop'])
  test(`the actual CLI preserves backend ${operation} failure state and its owner log before asserting`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'view-backend-evidence-'));
    const log = resolve(root, 'backend.log');
    const calls = [];
    const failure = {
      ok: false,
      error: {
        hint: `Engine backend ${operation} is still pending; inspect ${log} and backend status.`,
      },
    };
    await writeFile(log, `actual backend ${operation} failure\n`);
    const cliStart = source.indexOf('const cli = async ');
    const cliEnd = source.indexOf('\nasync function independentFacts', cliStart);
    const cli = runInNewContext(`${source.slice(cliStart, cliEnd)}; cli`, {
      assert,
      cp,
      writeFile,
      resolve,
      console,
      output: root,
      workspaceRoot: root,
      runUnifiedCli: async (args) => {
        calls.push(Array.from(args).slice(0, 2));
        return args[1] === operation ? failure : { ok: true, value: { phase: 'unreachable' } };
      },
    });
    try {
      await assert.rejects(cli(['backend', operation]), /Engine backend .* is still pending/);
      assert.deepEqual(calls, [
        ['backend', operation],
        ['backend', 'status'],
      ]);
      const evidence = JSON.parse(
        await readFile(resolve(root, `backend-${operation}-failure.json`), 'utf8'),
      );
      assert.deepEqual(evidence.result, failure);
      assert.equal(evidence.status.value.phase, 'unreachable');
      assert.equal(
        await readFile(resolve(root, `backend-${operation}.log`), 'utf8'),
        `actual backend ${operation} failure\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    result.push(...(entry.isDirectory() ? await files(root, `${path}/`) : [path]));
  }
  return result.sort();
}
for (const lightweight of [false, true])
  test(`View diagnostic copies the complete formal project with lightweight=${lightweight}`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'view-diagnostic-ci-test-'));
    const reference = await mkdtemp(resolve(tmpdir(), 'view-diagnostic-ci-reference-'));
    const sources = new Map();
    for (const path of await files(resolve(template, 'assets')))
      sources.set(path, await readFile(resolve(template, 'assets', path)));
    try {
      // The diagnostic project is the formal template plus the Engine's runtime vase probe.
      await cp(resolve(template, 'assets'), resolve(reference, 'assets'), { recursive: true });
      await installRuntimeVase(reference);
      const originals = new Map();
      for (const path of await files(resolve(reference, 'assets')))
        originals.set(path, await readFile(resolve(reference, 'assets', path)));
      const manifest = await prepare(template, root, lightweight);
      assert.equal(manifest.id, 'template-game-3d');
      assert.deepEqual(await files(resolve(root, 'assets')), [...originals.keys()]);
      for (const [path, bytes] of sources)
        assert.deepEqual(
          await readFile(resolve(template, 'assets', path)),
          bytes,
          'formal source remains immutable',
        );
      for (const [path, bytes] of originals) {
        const copied = await readFile(resolve(root, 'assets', path));
        {
          const expected =
            lightweight && path === 'scene.pack.ts'
              ? Buffer.from(
                  bytes
                    .toString()
                    .replaceAll(
                      'DirectionalLight: {',
                      `DirectionalLight: {cascadeCount: ${quality.cascadeCount},mapSize: 128,`,
                    ),
                )
              : bytes;
          assert.deepEqual(copied, expected, path);
        }
      }
      assert.equal(await readFile(resolve(root, 'forge.json'), 'utf8'), JSON.stringify(manifest));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(reference, { recursive: true, force: true });
    }
  });

test('View diagnostic retains sixty ready frames and the original ninety-second admission', () => {
  assert.match(source, /__diagnosticReadyCompletedFrames\[identity\]>=60/);
  assert.match(source, /\},undefined,\{timeout:90000\}\)/);
  assert.match(source, /await assertAuthoredSky/);
  assert.match(
    source,
    /prepareDiagnosticGameProject\(template, gameRoot, process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'\)/,
  );
});

// RGB bands from a real 320x180 independent-game screenshot of the display atmosphere sky
// (lightweight View integration on 2b4dea7c5) at the sampled rows 3 and 18.
const capturedSkyBands = [
  {
    x: 2,
    bands: [
      [
        [
          [167, 184, 192],
          [166, 184, 191],
          [167, 184, 192],
          [166, 184, 192],
        ],
        [
          [169, 184, 192],
          [169, 184, 192],
          [168, 184, 192],
          [168, 185, 192],
        ],
        [
          [170, 185, 192],
          [170, 185, 192],
          [170, 185, 192],
          [169, 186, 191],
        ],
        [
          [171, 186, 192],
          [172, 186, 192],
          [172, 186, 192],
          [171, 186, 192],
        ],
      ],
      [
        [
          [184, 178, 170],
          [184, 178, 171],
          [184, 178, 170],
          [184, 178, 170],
        ],
        [
          [183, 179, 170],
          [184, 178, 170],
          [184, 178, 171],
          [184, 178, 170],
        ],
        [
          [183, 179, 170],
          [183, 179, 170],
          [183, 179, 170],
          [183, 179, 170],
        ],
        [
          [184, 178, 170],
          [184, 178, 170],
          [183, 179, 170],
          [184, 178, 170],
        ],
      ],
    ],
  },
];
const skyStart = source.indexOf('async function assertAuthoredSky(');
const skyEnd = source.indexOf('async function prepareDiagnosticGameProject(', skyStart);
assert.ok(skyStart >= 0 && skyEnd > skyStart);
async function checkSky(pixels) {
  const check = runInNewContext(`${source.slice(skyStart, skyEnd)}; assertAuthoredSky`, {
    assert,
    writeFile: async () => {},
    resolve,
    output: '/sky-evidence',
    parseImage: () => ({ ok: true, value: { width: 320, height: 180, bytes: pixels } }),
  });
  await check(Buffer.alloc(0), 'independent');
}
function screenshotPixels() {
  const pixels = new Uint8Array(320 * 180 * 4);
  for (const { x, bands } of capturedSkyBands)
    for (const [band, rows] of bands.entries())
      for (const [dy, row] of rows.entries())
        for (const [dx, rgb] of row.entries())
          pixels.set([...rgb, 255], (([3, 18][band] + dy) * 320 + x + dx) * 4);
  return pixels;
}
test('real compact screenshot admits the authored atmosphere sky', async () => {
  await checkSky(screenshotPixels());
});
test('compact sky gate still rejects uniform blue clear-color fallback', async () => {
  const pixels = new Uint8Array(320 * 180 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([60, 90, 150, 255], offset);
  await assert.rejects(checkSky(pixels), /sky horizon gradient/);
});
test('compact sky gate still rejects missing sky', async () => {
  await assert.rejects(checkSky(new Uint8Array(320 * 180 * 4)), /authored blue sky/);
});
