// @perf-budget-skip: real Vite build/dev graphs and Chromium Worker module identity.
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { build, createServer } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries } from '../build/execution-workers.js';
import {
  assertSoftwareGraphicsGuard,
  runPreparedNativeUnit,
  softwareGraphicsGuard,
} from './native-unit-owner.js';
import { installBrowserHostGraphicsGuard } from './support/browser-host-graphics-guard.js';

it('shares installed Engine component identity across dev Worker and bootstrap imports', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-worker-dev-identity-')));
  const packages = resolve(import.meta.dirname, '../../..');
  const scope = resolve(root, 'node_modules/@forgeax');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const guard = await softwareGraphicsGuard();
    await mkdir(resolve(scope, 'engine'), { recursive: true });
    await mkdir(resolve(scope, 'worker-host'));
    await cp(resolve(packages, 'skinning/dist'), resolve(scope, 'engine-skinning'), {
      recursive: true,
    });
    await writeFile(
      resolve(scope, 'engine-skinning/package.json'),
      JSON.stringify({ name: '@forgeax/engine-skinning', type: 'module', exports: './index.mjs' }),
    );
    for (const name of ['ecs', 'types']) {
      await symlink(resolve(packages, name), resolve(scope, `engine-${name}`));
    }
    await writeFile(
      resolve(scope, 'engine/package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        type: 'module',
        exports: { './skinning': './skinning.js', './package.json': './package.json' },
        dependencies: { '@forgeax/engine-skinning': '0.0.0' },
      }),
    );
    await writeFile(
      resolve(scope, 'engine/skinning.js'),
      "export { Skin } from '@forgeax/engine-skinning';",
    );
    await writeFile(resolve(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    await writeFile(
      resolve(root, 'main.js'),
      `import { Skin } from '@forgeax/engine/skinning';
       globalThis.__skinLoaded = !!Skin;
       const worker = new Worker(new URL('./node_modules/@forgeax/worker-host/engine-worker-runtime.mjs', import.meta.url), { type: 'module' });
       worker.onmessage = event => { globalThis.__identity = event.data.identity; globalThis.__workerGraphicsRejections = event.data.rejected; };
       worker.postMessage('/bootstrap.js');`,
    );
    await writeFile(
      resolve(root, 'bootstrap.js'),
      "export { Skin } from '@forgeax/engine/skinning';",
    );
    await writeFile(resolve(scope, 'worker-host/graphics-guard.mjs'), guard);
    await writeFile(
      resolve(scope, 'worker-host/engine-worker-runtime.mjs'),
      `import './graphics-guard.mjs';
       import { Skin } from '@forgeax/engine-skinning';
       self.onmessage = async event => {
         const identity = Skin === (await import(/* @vite-ignore */ event.data)).Skin;
         const gpu = Object.getOwnPropertyDescriptor(navigator, 'gpu')?.value;
         const rejected = [];
         if (!gpu || !Object.isFrozen(gpu)) rejected.push('guard missing');
         else for (const acquire of [() => gpu.requestAdapter(), () => new OffscreenCanvas(1, 1).getContext('webgl2'), () => new OffscreenCanvas(1, 1).getContext('webgpu')]) {
           try { acquire(); rejected.push('not rejected'); } catch (error) { rejected.push(String(error)); }
         }
         self.postMessage({ identity, rejected });
       };`,
    );
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [executionWorkerEntries([])],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, packages] } },
    });
    await server.listen();
    const executablePath = ['/opt/google/chrome-beta/chrome', chromium.executablePath()].find(
      existsSync,
    );
    browser = await chromium.launch({
      headless: true,
      ...(executablePath === undefined ? {} : { executablePath }),
      args: ['--disable-gpu'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    await installBrowserHostGraphicsGuard(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls?.local[0] ?? '');
    await page.waitForFunction(() => '__identity' in globalThis, undefined, { timeout: 30_000 });
    await assertSoftwareGraphicsGuard(page);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(globalThis, '__identity'))).toBe(true);
    const workerRejections = await page.evaluate(
      () => Reflect.get(globalThis, '__workerGraphicsRejections') as string[],
    );
    expect(workerRejections).toHaveLength(3);
    for (const error of workerRejections)
      expect(error).toContain(
        'Browser host contract requested graphics; use the native GPU test config',
      );
  } finally {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.platform === 'win32')(
  'cancels a queued unit owner before its native command can run',
  async (context) => {
    const caseStartedAt = performance.now();
    const scratch = await mkdtemp(resolve(tmpdir(), 'forgeax-unit-admission-'));
    const lockPath = resolve(scratch, 'private-test.lock');
    const waiting = resolve(scratch, 'waiting');
    const launched = resolve(scratch, 'native-launched');
    const leaseModule = new URL('../../../../scripts/ci/local-gpu-lease.mjs', import.meta.url).href;
    const { withLocalGpuLease } = await import(leaseModule);
    const reason = new Error('Existing Vitest case cancelled while queued');
    const controller = new AbortController();
    try {
      await withLocalGpuLease(
        async () => {
          const pending = runPreparedNativeUnit(
            { signal: controller.signal, onTestFinished: context.onTestFinished },
            [
              process.execPath,
              '--input-type=module',
              '-e',
              `
          import { writeFile } from 'node:fs/promises';
          import { withLocalGpuLease } from ${JSON.stringify(leaseModule)};
          const pending = withLocalGpuLease(() => writeFile(${JSON.stringify(launched)}, 'launched'),
            { lockPath: ${JSON.stringify(lockPath)}, label: 'queued unit regression' });
          await writeFile(${JSON.stringify(waiting)}, 'queued');
          await pending;
        `,
            ],
            context.task.timeout,
            { ...process.env, FORGEAX_LOCAL_GPU_LEASE: '0' },
          ).then(
            () => undefined,
            (error: unknown) => error,
          );
          const remainingCaseBudget = Math.max(
            1,
            context.task.timeout - (performance.now() - caseStartedAt) - 1_000,
          );
          await expect
            .poll(() => existsSync(waiting), { interval: 20, timeout: remainingCaseBudget })
            .toBe(true);
          controller.abort(reason);
          expect(await pending).toBe(reason);
        },
        { lockPath, label: 'private unit admission regression' },
      );
      await withLocalGpuLease(
        async () => {
          expect(existsSync(launched)).toBe(false);
        },
        { lockPath, label: 'successor observes no late native launch' },
      );
    } finally {
      controller.abort(reason);
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

it('starts no owner when the existing case signal is already aborted', async (context) => {
  const scratch = await mkdtemp(resolve(tmpdir(), 'forgeax-unit-cancelled-'));
  const launched = resolve(scratch, 'native-launched');
  const controller = new AbortController();
  const reason = new Error('Case budget already exhausted');
  controller.abort(reason);
  try {
    await expect(
      runPreparedNativeUnit(
        { signal: controller.signal, onTestFinished: context.onTestFinished },
        [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'launched')`,
        ],
        context.task.timeout,
        { ...process.env, FORGEAX_LOCAL_GPU_LEASE: '0' },
      ),
    ).rejects.toBe(reason);
    expect(existsSync(launched)).toBe(false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it('serves snapshotted App Worker entries without exposing sibling inputs', async (context) => {
  const began = performance.now();
  const stages: { stage: string; elapsedMs: number }[] = [];
  const record = (stage: string) => stages.push({ stage, elapsedMs: performance.now() - began });
  const evidence = resolve(
    import.meta.dirname,
    '../../../../artifacts/runtime-pack/worker-snapshot',
  );
  const saveStages = async (name: string) => {
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, `${name}.json`), JSON.stringify(stages, null, 2));
  };
  context.onTestFailed(() => saveStages('failed-stages'));
  record('fixture-prepare');
  const snapshot = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-worker-snapshot-')));
  const root = resolve(snapshot, 'project');
  const facade = resolve(root, 'node_modules/@forgeax/engine');
  const app = resolve(snapshot, 'dependencies/app');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await mkdir(resolve(facade, 'node_modules/@forgeax'), { recursive: true });
    await mkdir(resolve(app, 'dist'), { recursive: true });
    await writeFile(
      resolve(facade, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        exports: { './package.json': './package.json' },
        dependencies: { '@forgeax/engine-app': '0.0.0' },
      }),
    );
    await writeFile(
      resolve(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-app',
        main: './dist/index.mjs',
        exports: { './package.json': './package.json' },
      }),
    );
    await writeFile(resolve(app, 'dist/index.mjs'), 'export const ready = true;');
    await symlink(app, resolve(facade, 'node_modules/@forgeax/engine-app'));
    await writeFile(resolve(snapshot, 'private.txt'), 'unrelated snapshot input');
    for (const worker of ['engine', 'render', 'kernel']) {
      await writeFile(
        resolve(app, `dist/${worker}-worker-runtime.mjs`),
        'self.postMessage("ready");',
      );
    }
    record('server-create');
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [executionWorkerEntries([])],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    });
    record('server-listen');
    await server.listen();
    record('private-input-fetch');
    const origin = server.resolvedUrls?.local[0] ?? '';
    const privateResponse = await fetch(new URL(`/@fs/${snapshot}/private.txt`, origin));
    expect(privateResponse.status).toBe(403);
    for (const worker of ['engine', 'render', 'kernel']) {
      record(`worker-fetch:${worker}`);
      const response = await fetch(
        new URL(`/@fs/${app}/dist/${worker}-worker-runtime.mjs`, origin),
      );
      expect(response.status, worker).toBe(200);
      expect(await response.text()).toContain('self.postMessage("ready")');
    }
  } finally {
    record('server-retire');
    await server?.close();
    record('fixture-remove');
    await rm(snapshot, { recursive: true, force: true });
    record('complete');
    await saveStages('completed-stages');
  }
});

it('shares component identity and admits lazy imports in emitted Worker runtimes', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-worker-identity-')));
  const skinning = resolve(import.meta.dirname, '../../../skinning/dist/index.mjs').replaceAll(
    '\\',
    '/',
  );
  try {
    await symlink(
      resolve(import.meta.dirname, '../../../../node_modules'),
      resolve(root, 'node_modules'),
    );
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      resolve(root, 'main.js'),
      `
      export const worker = new Worker(new URL('./engine-worker-runtime.mjs', import.meta.url), { type: 'module' });
    `,
    );
    await writeFile(resolve(root, 'bootstrap.js'), `export { Skin } from '${skinning}';`);
    await writeFile(
      resolve(root, 'inspect.js'),
      `import { Skin } from '${skinning}'; export const read = () => Skin;`,
    );
    await writeFile(
      resolve(root, 'engine-worker-runtime.mjs'),
      `
      import { Skin } from '${skinning}';
      globalThis.__forgeaxIdentityProbe = async url => Skin === (await import(/* @vite-ignore */ url)).Skin;
      globalThis.__forgeaxLazyWorkerProbe = async () => (await import('./inspect.js')).read() === Skin;
    `,
    );
    const outDir = resolve(root, 'dist');
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [executionWorkerEntries()],
      build: {
        target: 'esnext',
        outDir,
        rollupOptions: {
          preserveEntrySignatures: 'strict',
          input: { main: resolve(root, 'main.js'), bootstrap: resolve(root, 'bootstrap.js') },
          output: { entryFileNames: 'assets/[name].js' },
        },
      },
    });
    const assets = resolve(outDir, 'assets');
    const files = await readdir(assets);
    const workerFile = files.find((name) => name.startsWith('engine-worker-runtime'));
    expect(workerFile).toBeDefined();
    if (workerFile === undefined) return;
    await import(pathToFileURL(resolve(assets, workerFile)).href);
    const globals = globalThis as typeof globalThis & {
      __forgeaxIdentityProbe?: (url: string) => Promise<boolean>;
      __forgeaxLazyWorkerProbe?: () => Promise<boolean>;
    };
    try {
      expect(
        await globals.__forgeaxIdentityProbe?.(pathToFileURL(resolve(assets, 'bootstrap.js')).href),
      ).toBe(true);
      expect(await globals.__forgeaxLazyWorkerProbe?.()).toBe(true);
      expect(await readFile(resolve(assets, 'main.js'), 'utf8')).toContain('engine-worker-runtime');
    } finally {
      delete globals.__forgeaxIdentityProbe;
      delete globals.__forgeaxLazyWorkerProbe;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('discovers nested native Engine dependencies before a cold browser target activates', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-engine-cold-deps-')));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (const [name, dependencies, source] of [
      [
        '@forgeax/engine',
        { '@forgeax/engine-app': '0.0.0', '@forgeax/engine-plugin': '0.0.0' },
        "export { value } from '@forgeax/engine-app';",
      ],
      [
        '@forgeax/engine-app',
        { '@forgeax/engine-plugin': '0.0.0' },
        "export { value } from '@forgeax/engine-plugin';",
      ],
      [
        '@forgeax/engine-plugin',
        { 'nested-cjs': '0.0.0' },
        "import dependency from 'nested-cjs'; export const value = dependency.value;",
      ],
    ] as const) {
      const directory = resolve(root, 'node_modules', name);
      await mkdir(resolve(directory, 'dist'), { recursive: true });
      await writeFile(
        resolve(directory, 'package.json'),
        JSON.stringify({
          name,
          type: 'module',
          main: './dist/index.mjs',
          exports: { '.': './dist/index.mjs', './package.json': './package.json' },
          dependencies,
        }),
      );
      await writeFile(resolve(directory, 'dist/index.mjs'), source);
    }
    await mkdir(resolve(root, 'node_modules/nested-cjs'));
    await writeFile(
      resolve(root, 'node_modules/nested-cjs/package.json'),
      JSON.stringify({ name: 'nested-cjs', main: './index.cjs' }),
    );
    await writeFile(
      resolve(root, 'node_modules/nested-cjs/index.cjs'),
      'module.exports = { value: 42 };',
    );
    await writeFile(resolve(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    await writeFile(
      resolve(root, 'main.js'),
      "import { value } from '@forgeax/engine'; globalThis.__value = value;",
    );
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [executionWorkerEntries()],
      build: { outDir: 'output' },
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const optimizer = server.environments.client?.depsOptimizer;
    await optimizer?.init();
    await optimizer?.scanProcessing;
    expect(
      Object.keys({ ...optimizer?.metadata.optimized, ...optimizer?.metadata.discovered }),
    ).toContain('nested-cjs');
    const messages: unknown[] = [];
    const send = server.ws.send.bind(server.ws);
    server.ws.send = ((...args: Parameters<typeof send>) => {
      messages.push(args[0]);
      return send(...args);
    }) as typeof send;
    const executablePath = ['/opt/google/chrome-beta/chrome', chromium.executablePath()].find(
      existsSync,
    );
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--disable-gpu'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    await installBrowserHostGraphicsGuard(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls?.local[0] ?? '');
    await page.waitForFunction(() => Reflect.get(globalThis, '__value') === 42);
    await assertSoftwareGraphicsGuard(page);
    expect(errors).toEqual([]);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'full-reload' }));
  } finally {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// The App Worker closure must stay usable by ordinary animation consumers.
it('builds ordinary App module Workers without opting into skeletal Physics', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-ordinary-app-worker-')));
  const app = resolve(import.meta.dirname, '../../../app/dist/index.mjs').replaceAll('\\', '/');
  try {
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      resolve(root, 'main.js'),
      `import { createApp } from ${JSON.stringify(app)}; globalThis.__createApp = createApp;`,
    );
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      worker: { format: 'es' },
      build: {
        target: 'esnext',
        write: false,
        rollupOptions: { input: resolve(root, 'main.js') },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const files = outputs.flatMap((output) => ('output' in output ? output.output : []));
    expect(files.some((file) => file.fileName.includes('engine-worker-runtime'))).toBe(true);
    expect(files.some((file) => file.fileName.includes('render-worker-runtime'))).toBe(true);
    expect(files.some((file) => file.fileName.includes('kernel-worker-runtime'))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
