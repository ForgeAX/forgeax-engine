// @perf-budget-skip: real generated game, Vite dev runtime and sandboxed Chromium playthrough.
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildCommand } from '../commands.js';
import { type PlayReport, playCommand } from '../play.js';

const PACKAGE = '019fb7ce-2200-7000-8000-000000000000';
const namespace = PackageId.parse(PACKAGE);
if (!namespace.ok) throw namespace.error;
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(namespace.value, key));

const PACK = `import { AssetGuid, definePack, definePackageId } from '@forgeax/engine/pack/source';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { Materials } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';
const id = definePackageId('${PACKAGE}');
const ref = (key: string) => ({ $asset: AssetGuid.format(AssetGuid.derive(id, key)) });
export default definePack({
  schemaVersion: '2.0.0', plugins: true, packageId: id,
  build: () => ok({
    'mesh/box': createBoxGeometry(1, 1, 1).unwrap(),
    'material/box': Materials.standard({ baseColor: '#e0782c', roughness: 0.6 }),
    'plugin/game': { kind: 'plugin', module: { specifier: './game.ts', export: 'game' },
      config: { mesh: ref('mesh/box'), material: ref('material/box') } },
    'plugin/hud': { kind: 'plugin', module: { specifier: './hud.ts', export: 'hud' } },
  }),
});
`;

const GAME = `import type {} from '@forgeax/engine/app';
import type {} from '@forgeax/engine/assets-runtime';
import { Time, Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat } from '@forgeax/engine/math';
import type { Plugin } from '@forgeax/engine/plugin';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, Skylight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';

export const game: Plugin.Object<{ readonly mesh: string; readonly material: string }> = {
  name: 'play-fixture/game',
  inject: ['world', 'assets', 'gameHost'],
  async apply(ctx, config) {
    const world = ctx.world;
    const assets = ctx.assets!;
    const host = ctx.gameHost!;
    host.setPointerLockAllowed(false);
    const mesh = (await assets.load(assets.parseGuid(config.mesh), 'mesh')).unwrap();
    const material = (await assets.load(assets.parseGuid(config.material), 'material')).unwrap();
    // A three-minute round clock whose timeout is the loss screen.
    const state = { presses: 0, heldFrames: 0, clicks: 0, click: null as null | { x: number; y: number }, frames: 0, clock: 0, charge: 0, phase: 'playing' };
    ctx.effect(function* () {
      yield () => {
        assets.release(mesh).unwrap();
        assets.release(material).unwrap();
      };
      const entities = [
        world.spawn({ component: Transform, data: { pos: [0, 0, 4] } },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100, clearColor: [0.08, 0.1, 0.14, 1] } }).unwrap(),
        world.spawn({ component: Skylight, data: { intensity: 0.8, color: [1, 1, 1] } }).unwrap(),
        world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -1, -0.6], color: [1, 1, 1], intensity: 3 } }).unwrap(),
        world.spawn({ component: Transform, data: { pos: [0, 0, 0], quat: quat.fromEuler(quat.create(), 0.5, 0.7, 0, 'XYZ') } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } }).unwrap(),
      ];
      yield () => { for (const entity of entities) world.despawn(entity).unwrap(); };
      const unregister = host.gameProjection?.registerRead({ id: 'fixture.state', title: 'Play fixture', read: () => ({ ...state }) });
      yield () => unregister?.();
      world.addSystem(Update, { name: 'play-fixture/input', queries: [], fn() {
        const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        state.frames += 1;
        state.clock += world.getResource(Time).delta;
        if (state.clock >= 180) state.phase = 'lost';
        if (input.keyboard.justPressedCode('KeyD')) state.presses += 1;
        if (input.keyboard.downCode('KeyW')) state.heldFrames += 1;
        // Charges one unit per second of game time while KeyC is held.
        if (input.keyboard.downCode('KeyC')) state.charge += world.getResource(Time).delta;
        const size = host.drawingBufferSize();
        if (input.mouse.justPressed(0) && input.mouse.position !== undefined && size.width > 0) {
          state.clicks += 1;
          state.click = { x: input.mouse.position.x / size.width, y: input.mouse.position.y / size.height };
        }
      } }).unwrap();
      yield () => world.removeSystem(Update, 'play-fixture/input').unwrap();
    });
  },
};
`;

const HUD = `import type {} from '@forgeax/engine/app';
import type { Plugin } from '@forgeax/engine/plugin';
export const hud: Plugin = {
  name: 'play-fixture/hud',
  inject: ['gameHost'],
  apply(ctx) {
    ctx.effect(() => {
      const root = ctx.gameHost!.uiRoot!;
      const label = root.ownerDocument.createElement('div');
      label.id = 'fixture-hud';
      label.textContent = 'Play fixture';
      root.append(label);
      return () => {
        label.remove();
      };
    });
  },
};
`;

const JOURNEY = `import assert from 'node:assert/strict';
export default async function journey(play) {
  await play.step('keyboard', async () => {
    await play.keyboard.press('KeyD');
    const pressed = await play.waitFor((s) => s.presses === 1);
    const held = await play.keyboard.hold('KeyW', (s) => s.heldFrames >= 3);
    assert.ok(held.heldFrames >= 3);
    return pressed;
  });
  await play.step('mouse', async () => {
    await play.mouse.click({ x: 0.25, y: 0.75 });
    const clicked = await play.waitFor((s) => s.clicks === 1);
    assert.ok(Math.abs(clicked.click.x - 0.25) < 0.02 && Math.abs(clicked.click.y - 0.75) < 0.02);
  });
  await play.screenshot('after input');
  console.log('journey log line');
  await play.step('reload', async () => {
    await play.reload();
    assert.equal((await play.state()).presses, 0);
  });
  return { checks: 3 };
}
`;

const ADVANCE = `import assert from 'node:assert/strict';
export default async function advance(play) {
  const before = await play.state();
  const started = Date.now();
  const lost = await play.advance(180);
  const realMs = Date.now() - started;
  assert.equal(lost.phase, 'lost');
  const advanced = lost.clock - before.clock;
  assert.ok(advanced >= 180 - 1e-6 && advanced < 180 + realMs / 1000 + 0.2, String(advanced));
  // Update-only frames still run every game system once per stepped frame.
  assert.ok(lost.frames - before.frames >= 10800, String(lost.frames - before.frames));
  // render: true keeps drawing every stepped frame.
  const rendered = await play.advance(0.5, { render: true });
  assert.ok(rendered.clock - lost.clock >= 0.5 - 1e-6 && rendered.frames - lost.frames >= 30);
  const invalid = [];
  for (const [seconds, options] of [[0], [601], [Number.NaN], [10, { stepSeconds: 0.5 }], [600, { stepSeconds: 0.01 }]]) {
    await play.advance(seconds, options).then(
      () => invalid.push('accepted'),
      (error) => invalid.push(error.reason),
    );
  }
  // The App runs on its own clock again after the advance.
  const resumed = await play.waitFor((s) => s.frames >= rendered.frames + 5);
  assert.ok(resumed.clock > rendered.clock);
  return { realMs, invalid };
}
`;

const FAILING = `export default async function failing(play) {
  await play.step('collect coin', async () => {
    await play.keyboard.press('KeyD');
    await play.waitFor((s) => s.presses === 99, { timeoutMs: 500 });
  });
}
`;

const RANGE = `export default async function range(play) {
  await play.step('press', async () => {
    await play.keyboard.press('KeyD');
    await play.waitFor((s) => s.presses === 1);
  });
  await play.keyboard.press('KeyD');
  await play.step(
    'check',
    async () => {
      const state = await play.state();
      if (state.presses !== 0) throw new Error('skipped input was replayed: ' + state.presses);
      return state;
    },
    { setup: (ctx) => ctx.advance(0.5) },
  );
  await play.step('past the range', async () => {
    throw new Error('ran past the range');
  });
}
`;

// The same journey reaches the same terminal state on the real-time loop and on the
// lockstep fixed-step clock; the measured game time comes back for the clock check.
const TIMED = `export default async function timed(play) {
  await play.step('press', async () => {
    for (let index = 0; index < 3; index += 1) await play.keyboard.press('KeyD');
    await play.waitFor((s) => s.presses === 3);
  });
  await play.step('charge', async () => {
    await play.keyboard.hold('KeyC', (s) => s.charge >= 1, { timeoutMs: 5000 });
  });
  const before = await play.state();
  const started = Date.now();
  await play.step('rest', () => play.wait(2000));
  const after = await play.state();
  // An explicit advance keeps working on the clock, which steps on afterwards.
  await play.advance(0.5);
  await play.wait(100);
  const advanced = await play.state();
  return {
    terminal: { presses: after.presses, charged: after.charge >= 1, phase: after.phase },
    restGameSeconds: after.clock - before.clock,
    restWallMs: Date.now() - started,
    advancedGameSeconds: advanced.clock - after.clock,
  };
}
`;

// Forces the H13 failure shape in the default Worker topology: from now on,
// every queue submit in the page and its Workers carries a command buffer that
// clears a destroyed buffer, so WebGPU rejects the whole submit. The canvas is
// no longer presented while the game loop and HUD keep running.
const BROKEN_SUBMIT = `function breakSubmit() {
  if (typeof GPUQueue === 'undefined') return false;
  let device;
  const createCommandEncoder = GPUDevice.prototype.createCommandEncoder;
  GPUDevice.prototype.createCommandEncoder = function (...args) {
    device = this;
    return createCommandEncoder.apply(this, args);
  };
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (buffers) {
    if (device === undefined) return submit.call(this, buffers);
    const destroyed = device.createBuffer({ label: 'destroyed-fixture', size: 16, usage: GPUBufferUsage.COPY_DST });
    destroyed.destroy();
    const encoder = createCommandEncoder.call(device);
    encoder.clearBuffer(destroyed);
    return submit.call(this, [encoder.finish(), ...buffers]);
  };
  return true;
}
export default async function brokenSubmit(play) {
  // Break only after the startup fade: an error before then is a startup fatal.
  await play.page.waitForFunction(() => document.querySelector('#forgeax-loading')?.style.display === 'none');
  const warnings = [];
  play.page.on('console', (message) => {
    if (message.text().startsWith('[forgeax] renderer error')) warnings.push(message.type());
  });
  const realms = [play.page, ...play.page.workers()];
  const broken = await Promise.all(realms.map((realm) => realm.evaluate(breakSubmit)));
  if (!broken.includes(true)) throw new Error('no WebGPU realm to break');
  const before = await play.state();
  await play.waitFor((s) => s.frames >= before.frames + 30);
  await play.screenshot('broken');
  await play.waitFor((s) => s.frames >= before.frames + 60);
  return { warnings };
}
`;

// One playthrough serves both runs: development (iterated under --time-scale) and the
// built release both read the registered projection; only `advance` needs the development
// host, so the script guards it with `play.release`. With `external`, the page also asks
// another host for a file, which release play must block.
const releaseScript = (external: boolean) => `export default async function playthrough(play) {
  const hud = await play.step('input', async () => {
    await play.keyboard.press('KeyD');
    await play.mouse.click([0.25, 0.75]);
    await play.wait(200);
    return play.page.evaluate(() => document.querySelector('#fixture-hud')?.textContent);
  });
  const phase = (await play.state()).phase;
  await play.waitFor((state) => state.phase === 'playing', { timeoutMs: 5000 });
  const reads = [];
  if (play.release) await play.advance(1).then(() => reads.push('advance'), (error) => reads.push(error.reason));
  ${
    external
      ? "const fetched = await play.page.evaluate(() => fetch('https://example.com/forgeax-release-probe.json').then(() => 'loaded', () => 'blocked'));"
      : "const fetched = 'none';"
  }
  await play.screenshot('checked');
  return { release: play.release, hud, phase, reads, fetched };
}
`;

let root = '';
// Vite's dependency-cache identity after the first plays; later plays must keep it.
let depsIdentity: unknown;
const readDepsIdentity = async () => {
  const { hash, configHash, browserHash } = JSON.parse(
    await readFile(resolve(root, '.forgeax/play/vite/deps/_metadata.json'), 'utf8'),
  );
  return { hash, configHash, browserHash };
};

beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'forgeax-project-play-'));
  await cp(resolve(import.meta.dirname, '../../../../templates/empty'), root, {
    recursive: true,
    filter: (source) => !/(^|\/)(node_modules|dist|\.forgeax)(\/|$)/.test(source),
  });
  await mkdir(resolve(root, 'assets/play'), { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
  await Promise.all([
    writeFile(resolve(root, 'assets/play/play.pack.ts'), PACK),
    writeFile(resolve(root, 'assets/play/game.ts'), GAME),
    writeFile(resolve(root, 'assets/play/hud.ts'), HUD),
    writeFile(resolve(root, 'scripts/journey.mjs'), JOURNEY),
    writeFile(resolve(root, 'scripts/failing.mjs'), FAILING),
    writeFile(resolve(root, 'scripts/advance.mjs'), ADVANCE),
    writeFile(resolve(root, 'scripts/range.mjs'), RANGE),
    writeFile(resolve(root, 'scripts/timed.mjs'), TIMED),
    writeFile(resolve(root, 'scripts/broken-submit.mjs'), BROKEN_SUBMIT),
    writeFile(resolve(root, 'scripts/playthrough.mjs'), releaseScript(false)),
    writeFile(resolve(root, 'scripts/playthrough-external.mjs'), releaseScript(true)),
    writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({
        ...manifest,
        roots: { engine: guid('plugin/game'), frontend: guid('plugin/hud') },
      })}\n`,
    ),
  ]);
});

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

// CI budget for two plays; a cold contributor workspace without SDK shader
// artifacts can need longer locally (FORGEAX_PLAY_E2E_TIMEOUT_MS).
const PLAY_E2E_TIMEOUT_MS = Number(process.env.FORGEAX_PLAY_E2E_TIMEOUT_MS ?? 600_000);

// Both plays start together on one fixture root: the project lock runs them one
// at a time, so the second reuses the play-owned Vite dependency cache and the
// project DDC instead of racing the first one's optimizer.
it(
  'runs two concurrent plays of one project in turn: a passing journey and a failing step',
  async () => {
    const progress: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      if (String(chunk).startsWith('forgeax project play:')) progress.push(String(chunk));
      return write(chunk, ...rest);
    }) as typeof process.stderr.write;
    // Exercise the cold failing-script startup seen in CI, then queue the
    // passing journey behind its live lock. Neither script may race Vite's cache.
    const coldFailing = playCommand({ root, script: 'scripts/failing.mjs' });
    await vi.waitFor(
      () => expect(existsSync(resolve(root, '.forgeax/play/lock.json'))).toBe(true),
      { timeout: 15_000 },
    );
    const [journey, failing] = await Promise.all([
      playCommand({ root, script: 'scripts/journey.mjs', headless: true, requireUi: true }),
      coldFailing,
    ]).finally(() => {
      process.stderr.write = write;
    });
    expect(journey, JSON.stringify(journey)).toMatchObject({
      ok: true,
      value: {
        passed: true,
        script: 'scripts/journey.mjs',
        steps: 3,
        returned: { checks: 3 },
        state: { presses: 0, phase: 'playing' },
        rendered: true,
        errors: { console: 0, page: 0 },
        report: 'artifacts/play/scripts/journey/play.json',
      },
    });
    expect(Buffer.byteLength(JSON.stringify(journey))).toBeLessThan(1024);
    const report = JSON.parse(
      await readFile(resolve(root, 'artifacts/play/scripts/journey/play.json'), 'utf8'),
    ) as PlayReport;
    expect(report.screenshots.map((shot) => [shot.name, shot.rendered])).toEqual([
      ['after input', true],
      ['final', true],
      ['viewport 1280x600', true],
    ]);
    expect(report.viewports).toEqual(['1280x720', '1280x600']);
    for (const shot of report.screenshots) expect((await stat(shot.path)).size).toBeGreaterThan(0);
    expect(report.log).toEqual(['journey log line']);
    expect(report.execution).toBe('healthy');

    expect(failing, JSON.stringify(failing)).toMatchObject({
      ok: false,
      error: {
        code: 'play-step-failed',
        detail: {
          reason: 'wait-timeout',
          step: 'collect coin',
          action: 'collect coin: waitFor',
          state: { presses: 1 },
          // Failure frames are diagnostics, kept out of the deliverable artifacts/.
          screenshot: '.forgeax/diag/artifacts/play/scripts/failing/01-failure.png',
        },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(failing))).toBeLessThan(1024);
    expect(
      (await stat(resolve(root, '.forgeax/diag/artifacts/play/scripts/failing/01-failure.png')))
        .size,
    ).toBeGreaterThan(0);
    expect(existsSync(resolve(root, 'artifacts/play/scripts/failing/01-failure.png'))).toBe(false);
    const failingReport = JSON.parse(
      await readFile(resolve(root, 'artifacts/play/scripts/failing/play.json'), 'utf8'),
    ) as PlayReport;
    // Exactly one of the two waited for the other, and said so once on stderr.
    const waits = [report.timings.lockMs, failingReport.timings.lockMs].filter(
      (ms) => ms !== undefined,
    );
    expect(waits).toHaveLength(1);
    expect(
      progress.filter((line) => line.includes('plays of one project run one at a time')),
    ).toHaveLength(1);
    expect(progress.filter((line) => line.includes('started'))).toHaveLength(2);
    depsIdentity = await readDepsIdentity();
    // Each play removes its generated root when it ends.
    expect(existsSync(resolve(root, '.forgeax/generated/play'))).toBe(false);
  },
  PLAY_E2E_TIMEOUT_MS,
);

it(
  'advances a three-minute round clock to its loss screen in a fraction of that real time and resumes',
  async () => {
    const result = await playCommand({ root, script: 'scripts/advance.mjs', detail: true });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      value: {
        passed: true,
        returned: {
          invalid: [
            'advance-invalid',
            'advance-invalid',
            'advance-invalid',
            'advance-invalid',
            'advance-invalid',
          ],
        },
        execution: 'healthy',
      },
    });
    const report = (result as { value: PlayReport }).value;
    // 10800 update-only frames and one rendered frame take about 1-2 s on an
    // idle Mac (about 20 s under heavy load); rendering every frame took 16-65 s.
    expect((report.returned as { realMs: number }).realMs).toBeLessThan(30_000);
    expect(report.steps[0]).toMatchObject({ name: 'advance 180 s', ok: true });
    expect(report.steps[1]).toMatchObject({ name: 'advance 0.5 s', ok: true });
    // A later play reuses the optimized dependencies instead of re-optimizing them.
    expect(await readDepsIdentity()).toEqual(depsIdentity);
  },
  PLAY_E2E_TIMEOUT_MS,
);

it(
  'fails a play whose renderer rejects every submit with the renderer error, not a white canvas',
  async () => {
    const result = await playCommand({ root, script: 'scripts/broken-submit.mjs' });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      error: {
        code: 'play-runtime-failed',
        detail: {
          reason: 'renderer-error',
          message: expect.stringContaining('the canvas is not presented'),
        },
      },
    });
    const report = JSON.parse(
      await readFile(resolve(root, 'artifacts/play/scripts/broken-submit/play.json'), 'utf8'),
    ) as PlayReport;
    expect(report.screenshots.map((shot) => [shot.name, shot.rendered])).toEqual([
      ['broken', false],
      ['final', false],
    ]);
    expect(report.rendererError).toMatchObject({ message: expect.stringMatching(/destroyed/) });
    expect(report.rendererError?.count).toBeGreaterThan(30);
    // The development host logs each distinct renderer error once, as a warning:
    // the renderer-error check, not the browser-error count, fails the play.
    expect(report.returned).toEqual({ warnings: ['warning'] });
    expect(report.errors.console).toEqual([]);
  },
  PLAY_E2E_TIMEOUT_MS,
);

it(
  'runs a step range from its setup without replaying skipped input, and names unmatched starts',
  async () => {
    const ranged = await playCommand({ root, script: 'scripts/range.mjs', steps: 'check..2' });
    expect(ranged, JSON.stringify(ranged)).toMatchObject({
      ok: true,
      value: { passed: true, final: false, nonFinal: ['step range check..2'] },
    });
    const report = JSON.parse(
      await readFile(resolve(root, 'artifacts/play/scripts/range/play.json'), 'utf8'),
    ) as PlayReport;
    expect(report.range).toEqual({ from: 'check', to: '2' });
    expect(report.steps.map((step) => [step.name, step.skipped === true])).toEqual([
      ['press', true],
      ['check > setup > advance 0.5 s', false],
      ['check > setup', false],
      ['check', false],
    ]);
    const unmatched = await playCommand({ root, script: 'scripts/range.mjs', from: 'boss' });
    expect(unmatched, JSON.stringify(unmatched)).toMatchObject({
      ok: false,
      error: {
        code: 'play-step-failed',
        detail: {
          reason: 'range-unmatched',
          message: expect.stringContaining('#1 press, #2 check, #3 past the range'),
          final: false,
        },
      },
    });
  },
  PLAY_E2E_TIMEOUT_MS,
);

it(
  'reaches the same terminal state in real time and at a fourfold time scale on fixed steps',
  async () => {
    const real = await playCommand({ root, script: 'scripts/timed.mjs', detail: true });
    expect(real, JSON.stringify(real)).toMatchObject({ ok: true, value: { passed: true } });
    const realReport = (real as { value: PlayReport }).value;
    expect(realReport.timeScale).toBe(1);
    expect(realReport.final).toBeUndefined();
    const fast = await playCommand({
      root,
      script: 'scripts/timed.mjs',
      detail: true,
      timeScale: 4,
    });
    expect(fast, JSON.stringify(fast)).toMatchObject({
      ok: true,
      value: { passed: true, timeScale: 4, final: false, nonFinal: ['time scale 4'] },
    });
    const fastReport = (fast as { value: PlayReport }).value;
    type Timed = {
      terminal: unknown;
      restGameSeconds: number;
      restWallMs: number;
      advancedGameSeconds: number;
    };
    const realReturned = realReport.returned as Timed;
    const fastReturned = fastReport.returned as Timed;
    expect(fastReturned.terminal).toEqual(realReturned.terminal);
    expect(fastReturned.terminal).toEqual({ presses: 3, charged: true, phase: 'playing' });
    // Lockstep: wait(2000) steps exactly 120 frames, and nothing moves between helpers.
    expect(fastReturned.restGameSeconds).toBeCloseTo(2, 6);
    expect(fastReturned.restWallMs).toBeLessThan(realReturned.restWallMs);
    // advance(0.5) then wait(100): 0.5 s plus 6 frames, with the App still in lockstep.
    expect(fastReturned.advancedGameSeconds).toBeCloseTo(0.6, 6);
    expect(realReturned.advancedGameSeconds).toBeGreaterThanOrEqual(0.5 - 1e-6);
    // Every stepped frame is a whole fixed step: no game time is dropped or stretched.
    const clock = fastReport.clock;
    expect(clock).toBeDefined();
    expect(clock?.stepSeconds).toBeCloseTo(1 / 60, 9);
    // advance(0.5) counts as game time but not as clock frames.
    expect(clock?.gameSeconds).toBeCloseTo((clock?.frames ?? 0) / 60 + 0.5, 6);
    expect(clock?.frames).toBeGreaterThanOrEqual(120);
  },
  PLAY_E2E_TIMEOUT_MS,
);

it(
  'reuses one playthrough for the dev runtime and the built release, blocking other hosts',
  async () => {
    const iteration = await playCommand({ root, script: 'scripts/playthrough.mjs', timeScale: 4 });
    expect(iteration, JSON.stringify(iteration)).toMatchObject({
      ok: true,
      value: {
        passed: true,
        returned: { release: false, hud: 'Play fixture', phase: 'playing', reads: [] },
      },
    });
    const missing = await playCommand({ root, script: 'scripts/playthrough.mjs', release: true });
    expect(missing, JSON.stringify(missing)).toMatchObject({
      ok: false,
      error: { code: 'play-not-ready', detail: { reason: 'release-missing' } },
    });
    const built = await buildCommand({ root });
    expect(built.ok, JSON.stringify(built)).toBe(true);
    const release = await playCommand({
      root,
      script: 'scripts/playthrough.mjs',
      release: true,
      requireUi: true,
      detail: true,
    });
    expect(release, JSON.stringify(release)).toMatchObject({
      ok: true,
      value: {
        passed: true,
        mode: 'release',
        dist: 'dist',
        externalRequests: [],
        returned: {
          release: true,
          hud: 'Play fixture',
          phase: 'playing',
          reads: ['advance-failed'],
          fetched: 'none',
        },
      },
    });
    const releaseReport = (release as { value: PlayReport }).value;
    // Served by play's static server, not a Vite dev server.
    expect(releaseReport.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(releaseReport.execution).toBeUndefined();
    expect(releaseReport.screenshots.find((shot) => shot.name === 'final')?.rendered).toBe(true);
    const external = await playCommand({
      root,
      script: 'scripts/playthrough-external.mjs',
      release: true,
    });
    expect(external, JSON.stringify(external)).toMatchObject({
      ok: false,
      error: {
        code: 'play-runtime-failed',
        detail: {
          reason: 'external-request',
          externalRequests: ['https://example.com/forgeax-release-probe.json'],
        },
      },
    });
    const externalReport = JSON.parse(
      await readFile(
        resolve(root, 'artifacts/play/scripts/playthrough-external/play.json'),
        'utf8',
      ),
    ) as PlayReport;
    expect(externalReport.returned).toMatchObject({ fetched: 'blocked' });
    expect(externalReport.externalRequests).toEqual([
      'https://example.com/forgeax-release-probe.json',
    ]);
  },
  PLAY_E2E_TIMEOUT_MS,
);
