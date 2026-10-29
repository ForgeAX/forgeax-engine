import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifact, mapConcurrent } from './sdk-lib.mjs';
import { sdkStage } from './sdk-stage.mjs';
import { createSdkVerifierProcess } from './verify-sdk-process.mjs';

/** Real single-owner rebuild, public facades, native binding and browser/Worker consumption. */
export async function verifySdkSourceEdit({ sdkRoot, output, env = process.env }) {
  const manifest = JSON.parse(await readFile(resolve(sdkRoot, 'sdk-manifest.json'), 'utf8'));
  const sourceRoot = resolve(sdkRoot, manifest.source.root);
  const packageManager = JSON.parse(
    await readFile(resolve(sourceRoot, 'package.json'), 'utf8'),
  ).packageManager;
  const { execFileAsync: execute } = createSdkVerifierProcess(packageManager);
  const source = resolve(sourceRoot, 'packages/math/src/vec3.ts');
  const original = await readFile(source, 'utf8');
  const edited = original.replace('create(x = 0, y = 0, z = 0)', 'create(x = 137, y = 0, z = 0)');
  assert.notEqual(edited, original, 'the probe must edit the real vec3.create implementation');
  const dist = resolve(sourceRoot, 'packages/math/dist');
  const backup = resolve(output, 'math-baseline');
  await mkdir(output, { recursive: true });
  await rm(backup, { recursive: true, force: true });
  await cp(dist, backup, { recursive: true });
  const game = resolve(output, 'game');
  await mkdir(resolve(game, 'assets'), { recursive: true });
  const projectPackage = JSON.stringify({
    name: 'sdk-source-edit',
    private: true,
    type: 'module',
    dependencies: { '@forgeax/engine': manifest.sdkVersion },
  });
  await writeFile(resolve(game, 'package.json'), projectPackage);
  await writeFile(
    resolve(game, 'forge.json'),
    JSON.stringify({
      id: 'sdk-source-edit',
      name: 'SDK Source Edit',
      schemaVersion: '3.0.0',
      roots: {},
    }),
  );
  const require = createRequire(resolve(sourceRoot, 'package.json'));
  const load = (name) => import(pathToFileURL(require.resolve(name)).href);
  const devkit = await import(
    pathToFileURL(resolve(sourceRoot, 'packages/devkit/dist/index.mjs')).href
  );
  const { build, preview } = await load('vite');
  const { createBackendHost } = await import(
    pathToFileURL(resolve(sourceRoot, 'packages/host/dist/backend.mjs')).href
  );
  const playwright = await load('playwright');
  const { chromium } = playwright.default ?? playwright;
  let browser;
  let server;
  let backend;
  try {
    await writeFile(source, edited);
    await sdkStage('rebuild only @forgeax/engine-math', () =>
      execute('corepack', [packageManager, '--filter', '@forgeax/engine-math', 'build'], {
        cwd: sourceRoot,
        env,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    const unchanged = manifest.artifacts.filter(
      ({ path }) =>
        path.startsWith(`${manifest.source.root}/packages/`) &&
        path.includes('/dist/') &&
        !path.startsWith(`${manifest.source.root}/packages/math/`),
    );
    assert(unchanged.length > 0, 'the probe needs untouched prebuilt owners');
    const bound = await devkit.engineUseLocalCommand({ root: game, path: sourceRoot });
    assert(bound.ok && bound.value.healthy, JSON.stringify(bound));
    const checked = await devkit.engineDoctorCommand({ root: game });
    assert(checked.ok && checked.value.healthy, JSON.stringify(checked));
    const sample = `(() => {
      const world = new World();
      const entity = world.spawn({ component: Transform, data: { pos: vec3.create() } }).unwrap();
      return { x: world.get(entity, Transform).unwrap().pos[0], world: world.hasComponent(entity, Transform) };
    })()`;
    const probe = `
      import { vec3 } from ${JSON.stringify(pathToFileURL(resolve(sourceRoot, 'packages/engine/dist/facades/math.mjs')).href)};
      import { World } from ${JSON.stringify(pathToFileURL(resolve(sourceRoot, 'packages/engine/dist/facades/ecs.mjs')).href)};
      import { Transform } from ${JSON.stringify(pathToFileURL(resolve(sourceRoot, 'packages/engine/dist/facades/scene.mjs')).href)};
      console.log(JSON.stringify(${sample}));
    `;
    const node = await execute(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: game,
      env,
    });
    assert.deepEqual(JSON.parse(node.stdout.trim()), { x: 137, world: true });
    const imports =
      "import { vec3 } from '@forgeax/engine/math'; import { World } from '@forgeax/engine/ecs'; import { Transform } from '@forgeax/engine/scene';";
    await writeFile(resolve(game, 'index.html'), '<script type="module" src="/main.ts"></script>');
    await writeFile(
      resolve(game, 'main.ts'),
      `${imports}
      globalThis.sdkSourceEdit = { main: ${sample} };
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { globalThis.sdkSourceEdit.worker = data; worker.terminate(); };
    `,
    );
    await writeFile(resolve(game, 'worker.ts'), `${imports} self.postMessage(${sample});`);
    const facts = await devkit.readProjectFacts(game);
    assert(facts.ok, JSON.stringify(facts));
    backend = await createBackendHost();
    await (
      await backend.context.plugin({
        name: 'sdk-source-edit:presentation',
        provide: ['devkitBackend'],
        apply(ctx) {
          ctx.provide('devkitBackend', {
            host: backend,
            root: sdkRoot,
            hostPackageRoot: resolve(sdkRoot, 'tools/view'),
            assertCurrent: async () => {},
          });
        },
      })
    ).await();
    // The embedded View's installed Engine must not replace the source Host graph.
    const presentation = await devkit.createViteConfig(facts.value, 'serve', '/', {
      host: { backend },
    });
    const config = await devkit.createViteConfig(facts.value, 'build');
    const built = resolve(output, 'web');
    // Exercise the production Engine resolver in main and Vite's native Worker
    // pipeline. This numeric/ECS probe has no authored Packs or render graph.
    await build({
      ...config,
      resolve: presentation.resolve,
      root: game,
      configFile: false,
      plugins: config.plugins.filter(
        (plugin) =>
          plugin.name === 'forgeax:devkit-engine-workspace-resolver' ||
          plugin.name === 'forgeax:project-session',
      ),
      build: {
        ...config.build,
        outDir: built,
        rollupOptions: { input: resolve(game, 'index.html') },
      },
    });
    server = await preview({
      configFile: false,
      root: game,
      build: { outDir: built },
      preview: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    const url = server.resolvedUrls.local[0];
    assert(url, 'the built game must have a local URL');
    browser = await chromium.launch({
      headless: true,
      channel: env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => globalThis.sdkSourceEdit?.worker !== undefined);
    assert.deepEqual(await page.evaluate(() => globalThis.sdkSourceEdit), {
      main: { x: 137, world: true },
      worker: { x: 137, world: true },
    });
    assert.deepEqual(errors, []);
    await mapConcurrent(unchanged, async (expected) => {
      const actual = await artifact(sdkRoot, resolve(sdkRoot, expected.path));
      assert.equal(actual.bytes, expected.bytes);
      assert.equal(actual.sha256, expected.sha256);
    });
    assert.equal(await readFile(resolve(game, 'package.json'), 'utf8'), projectPackage);
    assert((await devkit.engineUnlinkCommand({ root: game })).ok);
    await assert.rejects(readFile(resolve(game, '.forgeax/engine-binding.json')), {
      code: 'ENOENT',
    });
    const evidence = {
      ok: true,
      modified: '@forgeax/engine-math',
      unchangedFiles: unchanged.length,
      commands: ['package build', 'engine use-local', 'engine check', 'engine unlink'],
      node: true,
      browser: true,
      worker: true,
      embeddedViewHost: true,
      projectManifestUnchanged: true,
    };
    await writeFile(resolve(output, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        if (server)
          await new Promise((accept, reject) =>
            server.httpServer.close((error) => (error ? reject(error) : accept())),
          );
      } finally {
        try {
          await backend?.dispose();
        } finally {
          await writeFile(source, original);
          await rm(dist, { recursive: true, force: true });
          await cp(backup, dist, { recursive: true });
        }
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  if (!args.includes('--sdk') || !args.includes('--output'))
    throw new Error(
      'Usage: verify-sdk-source-edit.mjs --sdk <SDK with installed source dependencies> --output <directory>',
    );
  console.log(
    JSON.stringify(
      await verifySdkSourceEdit({
        sdkRoot: resolve(value('--sdk')),
        output: resolve(value('--output')),
      }),
    ),
  );
}
