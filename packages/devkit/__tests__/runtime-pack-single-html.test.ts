import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import testQuality from '../../../scripts/test/render-quality.json' with { type: 'json' };
import {
  createLiveSyncProjectDirectory,
  prepareLiveSyncSharedInputs,
} from '../scripts/live-sync-inputs.mjs';
import { packageCommand } from '../src/commands.js';
import { disposeDevKitHosts } from '../src/host.js';
import { runtimeBrowserLaunchOptions } from './browser-launch.js';

const generator = `import { createBoxGeometry } from '@forgeax/engine/geometry';
import { ok } from '@forgeax/engine/types';
if (globalThis.name !== 'forgeax-task') throw new Error('Generator evaluated outside its Task Worker');
export function build({ values }) {
  return ok({ box: createBoxGeometry(values.width, 1, 1).unwrap() });
}
`;

const inspection = 'offline-pack.mesh';
const authoredId = '01900000-0000-7000-8000-000000000985';
const authoredPack = `import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { box } from './box-shape.ts';
export function generate() {
  if (globalThis.name !== 'forgeax-task') throw new Error('Expected ordinary Pack Task Worker');
  return ok({ 'mesh/ordinary': box(2) });
}
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${authoredId}'),
  runtime: { export: 'generate', outputs: { 'mesh/ordinary': 'mesh' }, dependencies: [] },
  build: () => ok({}),
});
`;

it('opens the formal single HTML offline and generates a Mesh in its Task Worker', {
  timeout: 420_000,
}, async () => {
  const repository = resolve(import.meta.dirname, '../../..');
  const manifestPath = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  const { root, temporaryRoot } = await createLiveSyncProjectDirectory(
    'forgeax-single-html-task-',
    repository,
    manifestPath,
  );
  const output = resolve(root, 'release/worker-pack.html');
  const workers = process.env.FORGEAX_EXECUTION_WORKERS;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    if (manifestPath)
      await prepareLiveSyncSharedInputs({
        sourceRoot: repository,
        projectRoot: root,
        temporaryRoot,
        manifestPath,
      });
    await cp(resolve(repository, 'templates/empty/assets'), resolve(root, 'assets'), {
      recursive: true,
    });
    await cp(resolve(repository, 'templates/empty/forge.json'), resolve(root, 'forge.json'));
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(repository, 'packages/engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({
        name: 'single-html-task-pack',
        type: 'module',
        dependencies: { '@forgeax/engine': '*' },
      }),
    );
    await writeFile(resolve(root, 'assets/box.program.mjs'), generator);
    await writeFile(resolve(root, 'assets/ordinary.pack.ts'), authoredPack);
    await writeFile(
      resolve(root, 'assets/box-shape.ts'),
      `import { createBoxGeometry } from '@forgeax/engine/geometry';
export const box = (width: number) => createBoxGeometry(width, 1, 1).unwrap();`,
    );
    const sceneOwnerPath = resolve(root, 'assets/scene-owner.pack.ts');
    const sceneOwner = await readFile(sceneOwnerPath, 'utf8');
    const marker = '    const loaded =';
    if (!sceneOwner.includes(marker)) throw new Error('Empty template scene owner changed');
    await writeFile(
      sceneOwnerPath,
      `import programSource from './box.program.mjs?raw';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { AssetGuid } from '@forgeax/engine/pack/source';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type {} from '@forgeax/engine/app';
` +
        sceneOwner
          .replace(
            "inject: ['assets', 'world']",
            "inject: ['assets', 'world', 'gameHost', 'runtimePacks']",
          )
          .replace(
            marker,
            `
    const p = ctx.runtimePacks.producer;
    const parent = '01900000-0000-7000-8000-000000000981';
    const packageId = '01900000-0000-7000-8000-000000000982';
    const imports = p.inspect().imports;
    const artifact = preparePackProgram({
      entry: 'box.program.mjs', export: 'build', modules: { 'box.program.mjs': programSource },
      imports: Object.fromEntries(['@forgeax/engine/geometry', '@forgeax/engine/types'].map(key => [key, imports[key]])),
    }).unwrap();
    (await p.admit({ source: {
      schemaVersion: '2.0.0', kind: 'scriptable-pack-source', source: 'box.program.mjs',
      program: 'offline-box', packageId: parent, runtime: { execution: 'task-worker', dependencies: [] },
      parameters: [{ name: 'width', type: 'f32', default: 2, minimum: 1, maximum: 5 }],
    }, programs: { 'offline-box': { artifact } } })).unwrap();
    const generated = (await p.generate({ schemaVersion: '3.0.0', parent, packageId, values: { width: 3 } })).unwrap();
    const guid = generated.rows[0].guid;
    const mesh = (await ctx.assets.load(guid, 'mesh')).unwrap();
    const geometry = ctx.assets.read(mesh).unwrap();
    const ordinaryGuid = AssetGuid.format(AssetGuid.derive(definePackageId('${authoredId}'), 'mesh/ordinary'));
    const ordinary = (await ctx.assets.load(ordinaryGuid, 'mesh')).unwrap();
    const ordinaryBounds = Array.from(ctx.assets.read(ordinary).unwrap().aabb);
    ctx.assets.release(ordinary).unwrap();
    const material = ctx.assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
    ctx.world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap();
    ctx.world.spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: perspective({ fov: Math.PI / 3, near: 0.1, far: 20, aspect: 1 }) },
    ).unwrap();
    ctx.gameHost.gameProjection.registerRead({
      id: ${JSON.stringify(inspection)}, title: 'Offline mesh', description: 'Generated mesh',
      read: () => ({
        guid, bounds: Array.from(geometry.aabb), ordinaryBounds, typed: geometry.vertices instanceof Float32Array,
        inEngineWorker: globalThis.name === 'forgeax-engine',
      }),
    });
${marker}`,
          ),
    );
    process.env.FORGEAX_EXECUTION_WORKERS = JSON.stringify({
      engine: true,
      render: false,
      kernels: false,
    });
    const packaged = await packageCommand({ root, format: 'single-html', output, json: true });
    if (!packaged.ok) throw packaged.error;
    const launch = runtimeBrowserLaunchOptions();
    browser = await chromium.launch({ ...launch, chromiumSandbox: true });
    const page = await browser.newPage({
      serviceWorkers: 'block',
      viewport: { width: testQuality.squareSize, height: testQuality.squareSize },
    });
    await page.addInitScript(() => {
      let presented = 0;
      window.addEventListener('forgeax:frame-completed', (event) => {
        if (event.target === document.querySelector('canvas#app') &&
            (event as CustomEvent).detail?.presentation === 'ready') presented += 1;
      }, true);
      Reflect.set(globalThis, '__offlinePackPresentedFrames', () => presented);
    });
    const errors: string[] = [];
    const network: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) network.push(request.url());
    });
    page.on('requestfailed', (request) => errors.push(request.url()));
    await page.goto(pathToFileURL(output).href);
    const read = () =>
      page.evaluate(async (id) => {
        const game = Reflect.get(globalThis, '__forgeaxGameInspection');
        if (!game || !(await game.list()).reads.includes(id)) return undefined;
        return game.read(id);
      }, inspection);
    try {
      await expect.poll(read, { timeout: 60_000 }).toMatchObject({
        typed: true,
        inEngineWorker: true,
        bounds: [-1.5, -0.5, -0.5, 1.5, 0.5, 0.5],
        ordinaryBounds: [-1, -0.5, -0.5, 1, 0.5, 0.5],
      });
    } catch (cause) {
      const diagnostic = await page.evaluate(() => ({
        presented: Reflect.get(globalThis, '__offlinePackPresentedFrames')(),
        singleHtml: Reflect.get(globalThis, '__forgeaxSingleHtml')?.witness(),
        startup: Reflect.get(globalThis, '__forgeaxStartup')?.inspect()?.diagnostics,
      }));
      throw new Error(
        `Offline Mesh did not publish: ${JSON.stringify({ diagnostic, errors, network })}`,
        { cause },
      );
    }
    const presentedFrames = () =>
      page.evaluate<number>(() => Reflect.get(globalThis, '__offlinePackPresentedFrames')());
    const first = await presentedFrames();
    await expect
      .poll(presentedFrames, { timeout: 90_000 })
      .toBeGreaterThanOrEqual(first + 60);
    const { PNG } = await import('pngjs');
    const image = PNG.sync.read(await page.locator('canvas#app').screenshot());
    const center = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    const red = image.data[center] ?? 0;
    const green = image.data[center + 1] ?? 0;
    const blue = image.data[center + 2] ?? 0;
    expect(red).toBeGreaterThan(Math.max(128, 2 * green, 2 * blue));
    expect(
      await page.evaluate(() => Reflect.get(globalThis, '__forgeaxSingleHtml').witness()),
    ).toMatchObject({
      ready: true,
      resourceMisses: [],
      externalRequests: [],
    });
    expect(errors).toEqual([]);
    expect(network).toEqual([]);
  } finally {
    if (workers === undefined) delete process.env.FORGEAX_EXECUTION_WORKERS;
    else process.env.FORGEAX_EXECUTION_WORKERS = workers;
    await browser?.close();
    await disposeDevKitHosts();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
