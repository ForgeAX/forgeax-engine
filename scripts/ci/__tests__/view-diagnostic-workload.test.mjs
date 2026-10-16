import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { reduceTestProject } from '../../test/reduce-test-project.mjs';
import quality from '../../test/render-quality.json' with { type: 'json' };

const source = await readFile(
  new URL('../../../tools/view-plugins/integration/verify-diagnostic-pages.mjs', import.meta.url),
  'utf8',
);
const start = source.indexOf('async function prepareDiagnosticGameProject(');
const end = source.indexOf('\ntry {\n for (const directory', start);
assert.ok(start >= 0 && end > start);
const prepare = runInNewContext(`${source.slice(start, end)}; prepareDiagnosticGameProject`, {
  assert,
  reduceTestProject,
  cp,
  readFile,
  writeFile,
  resolve,
});
const template = resolve('templates/game-3d');
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
test('Editor resume waits for the actual resize after a completed old-size frame', async () => {
  const start = source.indexOf(
    ' await page.waitForFunction(',
    source.indexOf(' await resizeSceneBuffer(0.5);'),
  );
  const end = source.indexOf('\n editorPresentation.resumed=', start);
  assert.ok(start >= 0 && end > start);
  const canvas = { width: 272, clientWidth: 1204, clientHeight: 658, checkVisibility: () => true };
  const renderer = { execution: { frame: { completed: 90 } } };
  const calls = [];
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    process: { env: { FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1' } },
    document: { querySelector: () => canvas },
    __forgeaxGameInspection: { renderer: () => renderer },
    devicePixelRatio: 2,
    editorOpened: { preview: { target: { targetId: 'preview-target', generation: 8 } } },
    client: {
      resizePreview: async (request) => {
        assert.deepEqual(calls, ['resized-ready']);
        calls.push({ ...request });
      },
    },
    editorPresentation: {
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
    const originals = new Map();
    for (const path of await files(resolve(template, 'assets')))
      originals.set(path, await readFile(resolve(template, 'assets', path)));
    try {
      const manifest = await prepare(template, root, lightweight);
      assert.equal(manifest.id, 'template-game-3d');
      assert.deepEqual(await files(resolve(root, 'assets')), [...originals.keys()]);
      for (const [path, bytes] of originals) {
        assert.deepEqual(
          await readFile(resolve(template, 'assets', path)),
          bytes,
          'formal source remains immutable',
        );
        const copied = await readFile(resolve(root, 'assets', path));
        if (lightweight && path === 'geometry.pack.ts') {
          const geometry = copied.toString();
          assert.ok(
            geometry.includes(
              `createSphereGeometry(0.9, ${quality.geometry.sphereWidth}, ${quality.geometry.sphereHeight})`,
            ),
          );
          assert.ok(
            geometry.includes(
              `createCylinderGeometry(0.75, 0.9, 1, ${quality.geometry.cylinderSegments}, 1)`,
            ),
          );
          assert.ok(
            geometry.includes(
              `createTorusGeometry(1, 0.24, ${quality.geometry.torusRadial}, ${quality.geometry.torusTubular})`,
            ),
          );
          assert.deepEqual(
            geometry.replace(/create(?:Sphere|Cylinder|Torus)Geometry\([^)]*\)/g, 'geometry'),
            bytes
              .toString()
              .replace(/create(?:Sphere|Cylinder|Torus)Geometry\([^)]*\)/g, 'geometry'),
            'all geometry identities and remaining authored content survive',
          );
        } else if (lightweight && path === 'fantasy-meshes.pack.ts') {
          const geometry = copied.toString();
          assert.deepEqual(
            [...geometry.matchAll(/uSegments: (\d+),/g)].map((match) => +match[1]),
            Array(3).fill(quality.geometry.surfaceU),
          );
          assert.deepEqual(
            [...geometry.matchAll(/vSegments: (\d+),/g)].map((match) => +match[1]),
            Array(3).fill(quality.geometry.surfaceV),
          );
          assert.equal(
            geometry.replace(/([uv]Segments:) \d+,/g, '$1 reduced,'),
            bytes.toString().replace(/([uv]Segments:) \d+,/g, '$1 reduced,'),
            'all three surface kernels, double-sided topology and material slots survive',
          );
        } else {
          const expected =
            lightweight && path === 'scene.pack.ts'
              ? Buffer.from(
                  bytes
                    .toString()
                    .replace('mapSize: 1024,', 'mapSize: 128,')
                    .replace('cascadeCount: 3,', `cascadeCount: ${quality.cascadeCount},`),
                )
              : bytes;
          assert.deepEqual(copied, expected, path);
        }
      }
      assert.equal(await readFile(resolve(root, 'forge.json'), 'utf8'), JSON.stringify(manifest));
    } finally {
      await rm(root, { recursive: true, force: true });
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

// RGB bands from the real 320x180 independent-game screenshot in SDK run
// 37197385957 (6c8bfe7114): x=249 hits the HUD, x=2 sees authored sky.
const capturedSkyBands = [
  {
    x: 2,
    bands: [
      [
        [
          [126, 157, 188],
          [126, 156, 188],
          [126, 156, 188],
          [126, 156, 187],
        ],
        [
          [121, 150, 183],
          [121, 150, 183],
          [121, 150, 183],
          [121, 150, 183],
        ],
        [
          [115, 144, 178],
          [115, 144, 177],
          [115, 144, 177],
          [115, 144, 177],
        ],
        [
          [109, 138, 171],
          [108, 138, 170],
          [108, 138, 170],
          [108, 137, 170],
        ],
      ],
      [
        [
          [76, 100, 127],
          [75, 100, 127],
          [75, 100, 126],
          [74, 100, 125],
        ],
        [
          [69, 94, 117],
          [69, 93, 117],
          [70, 92, 117],
          [69, 92, 116],
        ],
        [
          [64, 85, 107],
          [63, 85, 105],
          [64, 84, 106],
          [63, 83, 105],
        ],
        [
          [58, 78, 95],
          [58, 77, 95],
          [58, 76, 95],
          [57, 76, 94],
        ],
      ],
    ],
  },
  {
    x: 249,
    bands: [
      [
        [
          [18, 30, 46],
          [18, 30, 46],
          [18, 30, 46],
          [18, 30, 46],
        ],
        [
          [17, 29, 45],
          [17, 29, 45],
          [17, 29, 45],
          [17, 29, 45],
        ],
        [
          [17, 28, 45],
          [17, 28, 45],
          [17, 28, 45],
          [17, 29, 45],
        ],
        [
          [16, 28, 44],
          [16, 28, 44],
          [16, 28, 44],
          [16, 28, 44],
        ],
      ],
      [
        [
          [136, 126, 78],
          [255, 223, 118],
          [138, 127, 79],
          [14, 24, 38],
        ],
        [
          [24, 32, 40],
          [100, 95, 66],
          [35, 41, 44],
          [92, 88, 63],
        ],
        [
          [253, 221, 117],
          [194, 172, 97],
          [46, 50, 47],
          [135, 125, 77],
        ],
        [
          [137, 125, 78],
          [244, 214, 114],
          [196, 174, 97],
          [131, 120, 76],
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
          pixels.set([...rgb, 255], (([28, 36][band] + dy) * 320 + x + dx) * 4);
  return pixels;
}
test('real compact screenshot admits authored sky beside the HUD', async () => {
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
