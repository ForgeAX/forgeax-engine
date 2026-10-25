// @perf-budget-skip: real generated game, detached live owner, Vite dev runtime and sandboxed Chromium.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The detached owner runs the built CLI next to the library it is loaded from.
const { liveDevControl, startLiveDev } = (await import(
  new URL('../../dist/index.mjs', import.meta.url).href
)) as typeof import('../live-dev.js');

const PACKAGE = '019fb7ce-2200-7000-8000-00000000100c';
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

const DARK_SKY = '[0.02, 0.02, 0.03, 1]';
const BRIGHT_SKY = '[0.85, 0.9, 0.95, 1]';

const game = (sky: string) => `import type {} from '@forgeax/engine/app';
import type {} from '@forgeax/engine/assets-runtime';
import { quat } from '@forgeax/engine/math';
import type { Plugin } from '@forgeax/engine/plugin';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, Skylight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';

const SKY = ${sky};

export const game: Plugin.Object<{ readonly mesh: string; readonly material: string }> = {
  name: 'look-fixture/game',
  inject: ['world', 'assets'],
  async apply(ctx, config) {
    const world = ctx.world;
    const assets = ctx.assets!;
    const mesh = (await assets.load(assets.parseGuid(config.mesh), 'mesh')).unwrap();
    const material = (await assets.load(assets.parseGuid(config.material), 'material')).unwrap();
    ctx.effect(function* () {
      yield () => {
        assets.release(mesh).unwrap();
        assets.release(material).unwrap();
      };
      const entities = [
        world.spawn({ component: Transform, data: { pos: [0, 0, 4] } },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100, clearColor: SKY } }).unwrap(),
        world.spawn({ component: Skylight, data: { intensity: 0.8, color: [1, 1, 1] } }).unwrap(),
        world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -1, -0.6], color: [1, 1, 1], intensity: 3 } }).unwrap(),
        world.spawn({ component: Transform, data: { pos: [0, 0, 0], quat: quat.fromEuler(quat.create(), 0.5, 0.7, 0, 'XYZ') } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } }).unwrap(),
      ];
      yield () => { for (const entity of entities) world.despawn(entity).unwrap(); };
    });
  },
};
`;

interface LookValue {
  readonly revision: string;
  readonly waitedMs?: number;
  readonly views: readonly {
    readonly name: string;
    readonly screenshot: string;
    readonly metrics: { readonly luma: number; readonly width: number; readonly flat: boolean };
    readonly findings: readonly string[];
  }[];
}

let root = '';

async function look(args: Record<string, unknown> = {}): Promise<LookValue> {
  const result = (await liveDevControl(root, 'look', args)) as {
    readonly ok: boolean;
    readonly value: LookValue;
  };
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return result.value;
}

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

async function devDependencyHash(): Promise<unknown> {
  const metadata = resolve(root, '.forgeax/dev/vite/deps/_metadata.json');
  return readFile(metadata, 'utf8').then(
    (text) => JSON.parse(text).browserHash,
    () => undefined,
  );
}

beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'forgeax-dev-look-'));
  await cp(resolve(import.meta.dirname, '../../../../templates/empty'), root, {
    recursive: true,
    filter: (source) => !/(^|\/)(node_modules|dist|\.forgeax)(\/|$)/.test(source),
  });
  await mkdir(resolve(root, 'assets/look'), { recursive: true });
  // A game resolves its installed Engine, so Vite crawls the Engine runtime
  // dependencies before the first page. Without it, a cold dependency cache
  // discovers them during the first load and fails startup with 504s.
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(
    resolve(import.meta.dirname, '../../../engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'dir',
  );
  const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
  await Promise.all([
    writeFile(resolve(root, 'assets/look/look.pack.ts'), PACK),
    writeFile(resolve(root, 'assets/look/game.ts'), game(DARK_SKY)),
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

const LOOK_E2E_TIMEOUT_MS = Number(process.env.FORGEAX_LOOK_E2E_TIMEOUT_MS ?? 600_000);

it(
  'looks at the edited revision in the warm browser and reports its pixels',
  async () => {
    const started = (await startLiveDev(root, { headless: true })) as {
      readonly ok: boolean;
      readonly value: { readonly pid: number };
    };
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    const ownerPid = started.value.pid;
    const browsers = ownerBrowsers(ownerPid);
    expect(browsers.length).toBeGreaterThan(0);

    const dark = await look();
    expect(dark.views).toHaveLength(1);
    expect(dark.views[0]?.name).toBe('01-current-game');
    expect(dark.views[0]?.metrics.flat).toBe(false);
    expect(dark.views[0]?.metrics.luma).toBeLessThan(60);
    expect(dark.views[0]?.findings.some((finding) => finding.startsWith('dark:'))).toBe(true);
    const dependencyHash = await devDependencyHash();

    // No status polling: the look itself waits for the edited revision.
    await writeFile(resolve(root, 'assets/look/game.ts'), game(BRIGHT_SKY));
    const bright = await look();
    expect(bright.revision).not.toBe(dark.revision);
    expect(bright.waitedMs).toBeGreaterThan(0);
    expect(bright.views[0]?.metrics.luma).toBeGreaterThan(150);
    // The replacement page opened in the same browser, and Vite kept the
    // dependency cache identity, so module URLs stayed stable.
    expect(ownerBrowsers(ownerPid)).toEqual(browsers);
    expect(dependencyHash).toEqual(expect.any(String));
    expect(await devDependencyHash()).toBe(dependencyHash);

    const presets = await look({
      viewports: '400x300',
      cameras: [{ name: 'side', position: [4, 1, 0], target: [0, 0, 0] }],
      hideUi: true,
    });
    expect(presets.revision).toBe(bright.revision);
    expect(presets.views.map((view) => [view.name, view.metrics.width])).toEqual([
      ['01-400x300-side', 400],
    ]);
    const camera = (await liveDevControl(root, 'camera/get', {})) as {
      readonly value: { readonly control: string };
    };
    expect(camera.value.control).toBe('game');
  },
  LOOK_E2E_TIMEOUT_MS,
);
