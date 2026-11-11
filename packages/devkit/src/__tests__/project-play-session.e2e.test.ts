// @perf-budget-skip: real generated game, detached live owner, Vite dev runtime and sandboxed Chromium playthrough.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PlayReport } from '../play.js';

// The detached owner runs the built CLI next to the library it is loaded from.
const { liveDevControl, playCommand, startLiveDev } = (await import(
  new URL('../../dist/index.mjs', import.meta.url).href
)) as typeof import('../live-dev.js') & typeof import('../play.js');

const PACKAGE = '019fb7ce-2200-7000-8000-00000000100d';
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
  }),
});
`;

const GAME = `import type {} from '@forgeax/engine/app';
import type {} from '@forgeax/engine/assets-runtime';
import { Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat } from '@forgeax/engine/math';
import type { Plugin } from '@forgeax/engine/plugin';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, Skylight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';

export const game: Plugin.Object<{ readonly mesh: string; readonly material: string }> = {
  name: 'play-session-fixture/game',
  inject: ['world', 'assets', 'gameHost'],
  async apply(ctx, config) {
    const world = ctx.world;
    const assets = ctx.assets!;
    const host = ctx.gameHost!;
    host.setPointerLockAllowed(false);
    const mesh = (await assets.load(assets.parseGuid(config.mesh), 'mesh')).unwrap();
    const material = (await assets.load(assets.parseGuid(config.material), 'material')).unwrap();
    const state = { presses: 0 };
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
      const unregister = host.gameProjection?.registerRead({ id: 'fixture.state', title: 'Fixture', read: () => ({ ...state }) });
      yield () => unregister?.();
      world.addSystem(Update, { name: 'play-session-fixture/input', queries: [], fn() {
        const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        if (input.keyboard.justPressedCode('KeyD')) state.presses += 1;
      } }).unwrap();
      yield () => world.removeSystem(Update, 'play-session-fixture/input').unwrap();
    });
  },
};
`;

// Every play starts from a fresh page, so presses count from zero.
const script = (presses: number) => `export default async function presses(play) {
  await play.step('press', async () => {
    for (let index = 0; index < ${presses}; index += 1) await play.keyboard.press('KeyD');
    await play.waitFor((s) => s.presses === ${presses});
  });
  const state = await play.state();
  return { presses: state.presses, edition: state.edition ?? 1 };
}
`;

let root = '';

/** Browser processes the live owner launched itself (its direct children). */
function ownerBrowsers(ownerPid: number): readonly string[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, ppid, ...command]) =>
        Number(ppid) === ownerPid && /chrom|headless_shell/i.test(command.join(' ')),
    )
    .map(([pid]) => pid ?? '');
}

/** The owner's project child: its Vite server and built project inputs. */
function ownerProject(ownerPid: number): string | undefined {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(
      ([, ppid, ...args]) => Number(ppid) === ownerPid && args.includes('--__forgeax-live-project'),
    )?.[0];
}

const readReport = async () =>
  JSON.parse(
    await readFile(resolve(root, 'artifacts/play/scripts/presses/play.json'), 'utf8'),
  ) as PlayReport;

beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'forgeax-play-session-'));
  await cp(resolve(import.meta.dirname, '../../../../templates/empty'), root, {
    recursive: true,
    filter: (source) => !/(^|\/)(node_modules|dist|\.forgeax)(\/|$)/.test(source),
  });
  await mkdir(resolve(root, 'assets/play'), { recursive: true });
  await mkdir(resolve(root, 'scripts'), { recursive: true });
  // A game resolves its installed Engine, so Vite crawls the Engine runtime dependencies.
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(
    resolve(import.meta.dirname, '../../../engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'dir',
  );
  const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
  await Promise.all([
    writeFile(resolve(root, 'assets/play/play.pack.ts'), PACK),
    writeFile(resolve(root, 'assets/play/game.ts'), GAME),
    writeFile(resolve(root, 'scripts/presses.mjs'), script(2)),
    writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({ ...manifest, roots: { engine: guid('plugin/game') } })}\n`,
    ),
  ]);
});

afterAll(async () => {
  if (root === '') return;
  await liveDevControl(root, 'stop').catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const SESSION_E2E_TIMEOUT_MS = Number(process.env.FORGEAX_PLAY_E2E_TIMEOUT_MS ?? 600_000);

it(
  'plays in the reloaded page of the running dev owner and leaves the owner running',
  async () => {
    const options = { root, script: 'scripts/presses.mjs', progress: false, detail: true };
    // A private play first: it starts its own runtime and browser.
    const cold = await playCommand(options);
    expect(cold, JSON.stringify(cold)).toMatchObject({ ok: true });
    const coldReport = await readReport();
    expect(coldReport.mode).toBe('private');

    const absent = await playCommand({ ...options, session: true });
    expect(absent).toMatchObject({
      ok: false,
      error: { code: 'play-not-ready', detail: { reason: 'session-unavailable' } },
    });

    const started = (await startLiveDev(root, { headless: true })) as {
      readonly ok: boolean;
      readonly value: { readonly pid: number };
    };
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    const browsers = ownerBrowsers(started.value.pid);
    expect(browsers.length).toBeGreaterThan(0);
    const project = ownerProject(started.value.pid);
    expect(project).toBeDefined();

    const warm = await playCommand({ ...options, session: true });
    expect(warm, JSON.stringify(warm)).toMatchObject({
      ok: true,
      value: { mode: 'session', returned: { presses: 2 } },
    });
    const warmReport = await readReport();
    // An edited script runs on the next session play, again from a fresh page.
    await writeFile(resolve(root, 'scripts/presses.mjs'), script(3));
    const edited = await playCommand({ ...options, session: true });
    expect(edited, JSON.stringify(edited)).toMatchObject({
      ok: true,
      value: { mode: 'session', returned: { presses: 3 } },
    });
    const editedReport = await readReport();
    // Unchanged project inputs keep the running project child and replace only the page.
    expect(ownerProject(started.value.pid)).toBe(project);
    // A game edit is a new project input: the play replaces the project child too.
    await writeFile(
      resolve(root, 'assets/play/game.ts'),
      GAME.replace('const state = { presses: 0 };', 'const state = { presses: 0, edition: 2 };'),
    );
    const rebuilt = await playCommand({ ...options, session: true });
    expect(rebuilt, JSON.stringify(rebuilt)).toMatchObject({
      ok: true,
      value: { mode: 'session', returned: { presses: 3, edition: 2 } },
    });
    const rebuiltReport = await readReport();
    expect(ownerProject(started.value.pid)).not.toBe(project);
    // Both plays reused the owner's browser, and the owner still serves live commands.
    expect(ownerBrowsers(started.value.pid)).toEqual(browsers);
    const look = (await liveDevControl(root, 'look', {})) as { readonly ok: boolean };
    expect(look, JSON.stringify(look)).toMatchObject({ ok: true });
    const startup = (report: PlayReport) =>
      (report.timings.openMs ?? 0) + (report.timings.readyMs ?? 0);
    process.stderr.write(
      `play session timings: ${JSON.stringify({
        private: coldReport.timings,
        session: warmReport.timings,
        sessionEdited: editedReport.timings,
        sessionRebuilt: rebuiltReport.timings,
      })}\n`,
    );
    expect(startup(warmReport)).toBeLessThan(startup(coldReport));
    expect(startup(editedReport)).toBeLessThan(startup(coldReport));
  },
  SESSION_E2E_TIMEOUT_MS,
);
