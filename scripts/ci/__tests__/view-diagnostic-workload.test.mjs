import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { constants, runInNewContext } from 'node:vm';
import { installRuntimeVase } from '../../template-probes/game-3d/runtime-vase/install.mjs';
import { reduceTestProject } from '../../test/reduce-test-project.mjs';
import quality from '../../test/render-quality.json' with { type: 'json' };
import { renderModelInCliProcess } from '../modeling-cli-render.mjs';

const viewPin = execFileSync('git', ['ls-files', '--stage', '--', 'tools/view'], {
  encoding: 'utf8',
}).match(/^160000 ([a-f0-9]{40}) 0\ttools\/view\r?$/m)?.[1];
assert.ok(viewPin, 'View diagnostic contracts require the maintained source gitlink');
const source = execFileSync(
  'git',
  ['-C', 'tools/view', 'show', `${viewPin}:scripts/verify-diagnostic-pages-integration.mjs`],
  { encoding: 'utf8' },
).replaceAll('\r\n', '\n');
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
const viewPlanForCI = (ci, ...args) =>
  JSON.parse(
    execFileSync(process.execPath, [viewIntegration, '--candidate', ...args], {
      encoding: 'utf8',
      env: { ...process.env, CI: ci },
    }),
  );
const viewPlan = (...args) => viewPlanForCI('false', ...args);
test('only self-contained fixture copies omit the optional Engine content library', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-fixture-libraries-'));
  const manifestPath = resolve(root, 'forge.json');
  const manifest = {
    id: 'fixture',
    roots: { engine: 'entry' },
    assetLibraries: ['@forgeax/engine/content', 'test-extra-library'],
  };
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(manifestPath, JSON.stringify(manifest));
    await reduceTestProject(root);
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);

    await reduceTestProject(root, { omitEngineContent: true });
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), {
      ...manifest,
      assetLibraries: ['test-extra-library'],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the View plan retains every command except the duplicate TypeScript cold reopen', async () => {
  const original = JSON.parse(
    await readFile(
      new URL('./fixtures/view-probe-population-c65c03331d.json', import.meta.url),
      'utf8',
    ),
  );
  // Preserve the historical population plus the admitted MCP carrier contracts.
  const appContracts = original.commands.find(({ args }) =>
    args.includes('tools/forgeax-mcp/__tests__/app/program-host.test.mjs'),
  );
  assert.ok(appContracts);
  appContracts.args.push(
    ...[
      'card-contract',
      'codex-binding',
      'codex-file',
      'codex-routing',
      'compact-card',
      'context-probe',
      'host-lifecycle',
      'hosting',
      'multi-card',
      'preview-program',
      'source-broker',
      'source-reuse',
      'stdio-lifetime',
      'view-plugin',
    ].map((name) => `tools/forgeax-mcp/__tests__/app/${name}.test.mjs`),
  );
  appContracts.args.sort();
  const actual = viewPlan('--dry-run').map(([, command, args, env = {}]) => ({
    command,
    args: args.includes('tools/forgeax-mcp/__tests__/app/program-host.test.mjs')
      ? [...args].sort()
      : args,
    env,
  }));
  const portable = JSON.parse(JSON.stringify(actual).replaceAll(resolve('.'), '<root>'));
  const retired = original.commands.filter(
    ({ env }) => env.FORGEAX_RUNTIME_PACK_LANGUAGE === 'ts' && env.FORGEAX_RUNTIME_PACK_SNAPSHOT,
  );
  assert.equal(retired.length, 1);
  const retained = original.commands.filter((command) => command !== retired[0]);
  assert.deepEqual(portable.map(JSON.stringify).sort(), retained.map(JSON.stringify).sort());
});
test('CI retains the complete View plan and its diagnostic-page capability flag', () => {
  const local = viewPlan('--dry-run');
  const diagnostic = local.find(([, , args]) =>
    args.includes('tools/view/scripts/verify-diagnostic-pages-integration.mjs'),
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.length, 3);
  diagnostic.push({ FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1' });
  assert.deepEqual(viewPlanForCI('true', '--dry-run'), local);
});
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
    JSON.parse(
      await readFile(new URL('./fixtures/view-partial-43737218283.json', import.meta.url), 'utf8'),
    ),
    JSON.parse(
      await readFile(new URL('./fixtures/view-partial-43746993655.json', import.meta.url), 'utf8'),
    ),
    JSON.parse(
      await readFile(new URL('./fixtures/view-partial-43880193250.json', import.meta.url), 'utf8'),
    ),
  ];
  const [complete, partial, shardEvidence, diagnosticEvidence, lifecycleEvidence] = receipts;
  assert.equal(Object.hasOwn(complete.completedOwnerSeconds, 'modeling'), false);
  assert.deepEqual(partial.uncompletedOwners, ['modeling']);
  assert.deepEqual(shardEvidence.uncompletedOwners, ['diagnostics', 'modeling']);
  assert.deepEqual(diagnosticEvidence.uncompletedOwners, ['modeling']);
  assert.equal(lifecycleEvidence.conclusion, 'cancelled');
  assert.deepEqual(lifecycleEvidence.uncompletedOwners, ['lifecycle']);
  assert.equal(Object.hasOwn(lifecycleEvidence.completedOwnerSeconds, 'lifecycle'), false);
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
          Object.hasOwn(receipt.completedOwnerSeconds ?? {}, owner) ||
          Object.hasOwn(receipt.retainedOwnerSeconds ?? {}, owner),
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

for (const [runId, uncompletedOwners] of [
  [44242238183, ['diagnostic-gpu-2d']],
  [44249977351, []],
]) {
  test(`View placement fits the observed timeout window of run ${runId}`, async () => {
    const receipt = JSON.parse(
      await readFile(new URL(`./fixtures/view-partial-${runId}.json`, import.meta.url), 'utf8'),
    );
    assert.equal(receipt.conclusion, 'cancelled');
    assert.deepEqual(receipt.uncompletedOwners, uncompletedOwners);
    for (const owner of uncompletedOwners) {
      assert.equal(Object.hasOwn(receipt.completedOwnerSeconds, owner), false);
    }
    const finishes = [0, 1, 2, 3].map((shard) => {
      const owners = new Set(
        viewPlan('--shard', String(shard), '--dry-run').map(([owner]) => owner),
      );
      owners.delete('prepare');
      const ownerSeconds = [...owners].map((owner) => {
        const seconds = receipt.completedOwnerSeconds[owner] ?? receipt.retainedOwnerSeconds[owner];
        assert.ok(seconds > 0, `missing complete timing or retained forecast for ${owner}`);
        return seconds;
      });
      return (
        ownerSeconds.reduce((sum, seconds) => sum + seconds, 0) +
        receipt.prepareSeconds +
        receipt.setupAndTransferReserveSeconds +
        (receipt.afterPairingReserveSecondsByShard[shard] ?? 0) +
        (receipt.additionalSourceRecoverySecondsByShard?.[shard] ?? 0)
      );
    });
    assert.ok(
      Math.max(...finishes) <= receipt.jobBudgetSeconds,
      `View lanes, source recovery and browser gates must fit the same run: ${finishes}`,
    );
  });
}

test('measured diagnostic owners share the original four jobs and Modeling runs last', () => {
  const shards = Array.from({ length: 4 }, (_value, index) =>
    viewPlan('--shard', String(index), '--dry-run'),
  );
  const groupOwner = (file) =>
    shards.flatMap((steps, shard) =>
      steps.filter(([, , args]) => args[0] === file).map(([owner]) => ({ owner, shard })),
    );
  assert.deepEqual(groupOwner('tools/view/scripts/verify-diagnostic-pages-integration.mjs'), [
    { owner: 'diagnostic-pages', shard: 3 },
  ]);
  assert.deepEqual(groupOwner('tools/view/scripts/verify-texture-preview-integration.mjs'), [
    { owner: 'diagnostic-texture', shard: 0 },
  ]);
  assert.deepEqual(groupOwner('tools/view/scripts/verify-gpu-texture-preview.mjs'), [
    { owner: 'diagnostic-gpu-2d', shard: 0 },
    { owner: 'diagnostic-gpu-array', shard: 1 },
  ]);
  assert.deepEqual(groupOwner('tools/view/scripts/verify-pack-authoring-integration.mjs'), [
    { owner: 'diagnostic-pack-authoring', shard: 0 },
  ]);
  assert.deepEqual(groupOwner('tools/view/scripts/verify-pack-save-reopen-integration.mjs'), [
    { owner: 'diagnostic-pack-save', shard: 1 },
  ]);
  for (const probe of ['owner-surface-resize', 'page-plugin-lifecycle', 'startup-boundaries'])
    assert.deepEqual(groupOwner(`tools/view/scripts/verify-${probe}.mjs`), [
      { owner: 'lifecycle', shard: 1 },
    ]);
  assert.deepEqual(groupOwner('tools/view-plugins/integration/verify-modeling.mjs'), [
    { owner: 'modeling', shard: 3 },
  ]);
  assert.equal(
    shards[3].filter(([owner]) => owner.startsWith('diagnostic-'))[0][2][0],
    'tools/view/scripts/verify-diagnostic-pages-integration.mjs',
    'the live RHI replay must start before the other GPU diagnostic owners',
  );
  assert.deepEqual(
    shards[1].filter(([owner]) => owner !== 'prepare').map(([owner]) => owner),
    [
      'game3d',
      'game3d',
      'lifecycle',
      'lifecycle',
      'lifecycle',
      'diagnostic-pack-save',
      'diagnostic-gpu-array',
    ],
    'the complete Game 3D chain stays contiguous before the other owners',
  );
  assert.equal(
    shards[3].at(-1)[0],
    'modeling',
    'Modeling runs after the complete diagnostic replay',
  );
  assert.deepEqual(
    shards[2].filter(([owner]) => owner !== 'prepare').map(([owner]) => owner),
    ['plugin', 'workspace', 'workspace', 'runtime-js', 'runtime-js'],
    'the plugin journey starts before its remaining paired probes',
  );
  assert.deepEqual(groupOwner('tools/view/scripts/verify-runtime-content-engine.mjs'), [
    { owner: 'runtime-js', shard: 2 },
    { owner: 'runtime-js', shard: 2 },
    { owner: 'runtime-ts', shard: 3 },
  ]);
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
    ' await project.waitForFunction(',
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
    project: {
      locator: (selector) => {
        assert.equal(selector, 'canvas#app');
        return { evaluate: async (read) => read(canvas) };
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
          let expected = bytes;
          if (lightweight && path === 'scene.pack.ts') {
            expected = Buffer.from(
              bytes
                .toString()
                .replaceAll(
                  'DirectionalLight: {',
                  `DirectionalLight: {cascadeCount: ${quality.cascadeCount},mapSize: 128,`,
                )
                .replace(
                  'resolution: 128,',
                  `resolution: ${Math.min(128, quality.reflectionResolution)},`,
                ),
            );
          } else if (lightweight && path === 'player/character.pack.ts') {
            expected = Buffer.from(
              bytes
                .toString()
                .replace(
                  'default: CONVOY_DEFAULT_RESOLUTION,',
                  `default: Math.min(CONVOY_DEFAULT_RESOLUTION, ${quality.proceduralTextureResolution}),`,
                ),
            );
          } else if (lightweight && path === 'geometry.pack.ts') {
            expected = Buffer.from(
              bytes
                .toString()
                .replace(
                  /createSphereGeometry\(([^,]+), (\d+), (\d+)\)/g,
                  (_, radius, width, height) =>
                    `createSphereGeometry(${radius}, ${Math.min(+width, quality.geometry.sphereWidth)}, ${Math.min(+height, quality.geometry.sphereHeight)})`,
                ),
            );
          }
          assert.deepEqual(copied, expected, path);
        }
      }
      assert.equal(await readFile(resolve(root, 'forge.json'), 'utf8'), JSON.stringify(manifest));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(reference, { recursive: true, force: true });
    }
  });

test('hidden Scene settling never depends on animation frames in its suspended document', async () => {
  const begin = source.indexOf(' const waitForHiddenScene=');
  const end = source.indexOf('\n scenePresentation.hidden=', begin);
  assert.ok(begin >= 0 && end > begin);
  const calls = [];
  const fact = {
    renderer: { execution: { world: { identity: 'scene' }, frame: { submitted: 60 } } },
  };
  let advances = false;
  const hidden = runInNewContext(`${source.slice(begin, end)}; waitForHiddenScene`, {
    assert,
    sceneWorld: 'scene',
    sceneFacts: async () => {
      calls.push('facts');
      if (advances) fact.renderer.execution.frame.submitted++;
      return structuredClone(fact);
    },
    project: {
      evaluate: async () => {
        throw new Error('hidden document cannot schedule rAF');
      },
    },
    page: {
      locator: () => ({
        waitFor: async (options) => {
          assert.equal(options.state, 'hidden');
          assert.equal(options.timeout, 10000);
        },
      }),
      waitForTimeout: async (milliseconds) => {
        assert.equal(milliseconds, 1000);
        calls.push('settle');
      },
    },
  });
  await hidden();
  assert.deepEqual(calls, ['settle', 'facts', 'settle', 'facts']);
  // A continuing producer must still fail the original submission oracle.
  advances = true;
  await assert.rejects(hidden(), /inactive Scene must stop continuous submissions/);
});

test('View diagnostic retains bounded cold readiness and sixty actual ready frames', async () => {
  const begin = source.indexOf(' const waitForReadyPictures=');
  const end = source.indexOf('\n const sceneCompletedFrames=', begin);
  assert.ok(begin >= 0 && end > begin);
  const events = [];
  const context = {
    __forgeaxGameInspection: { renderer: () => ({ execution: { world: { identity: 'scene' } } }) },
    __diagnosticReadyCompletedFrames: { scene: 0 },
    __diagnosticReadiness: {},
    performance: { now: () => 42 },
    project: {
      async waitForFunction(predicate, minimum, options) {
        events.push({ minimum, timeout: options.timeout });
        context.__diagnosticReadyCompletedFrames.scene = minimum - 1;
        assert.equal(predicate(minimum), false, 'an incomplete picture window is rejected');
        context.__diagnosticReadyCompletedFrames.scene = minimum;
        assert.equal(predicate(minimum), true);
      },
      async evaluate(callback) {
        events.push('steady-start');
        callback();
      },
    },
  };
  await runInNewContext(`(async () => {${source.slice(begin, end)}})()`, context);
  assert.deepEqual(events, [
    { minimum: 1, timeout: 90000 },
    'steady-start',
    { minimum: 60, timeout: 90000 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.__diagnosticReadiness)), {
    steadyWait: { identity: 'scene', milliseconds: 42, ready: 1 },
  });
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

test('Modeling independent renders finish in separate one-shot CLI processes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'modeling cli lifetime-'));
  try {
    const cli = resolve(root, 'cli.mjs');
    await writeFile(
      cli,
      `process.stdout.write(JSON.stringify({ ok: true, value: { pid: process.pid, args: process.argv.slice(2) } }) + '\\n');`,
    );
    const input = { source: 'assets/wheel-rim.pack.ts', views: ['top'], values: { spokes: 7 } };
    const first = await renderModelInCliProcess(cli, root, input);
    const second = await renderModelInCliProcess(cli, root, input);
    assert.notEqual(first.pid, second.pid);
    for (const result of [first, second]) {
      assert.notEqual(result.pid, process.pid);
      assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
      assert.deepEqual(result.args.slice(0, 2), ['model', 'render']);
      assert.deepEqual(JSON.parse(result.args[result.args.indexOf('--input') + 1]), input);
      assert.deepEqual(result.args.slice(-4), ['--root', root, '--detail', '--json']);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
