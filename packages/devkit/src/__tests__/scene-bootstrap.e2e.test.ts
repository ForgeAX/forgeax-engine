// @perf-budget-skip: intentional real Chromium + Vite scene bootstrap gate.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseImage } from '@forgeax/engine-image/parse-image';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { Context } from '@forgeax/engine-plugin';
import { type Browser, chromium, type Page } from 'playwright';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';
import { allocateLoopbackPort } from '../tools/browser-host.js';

const namespace = '01900000-0000-7000-8000-000000000140';
const parsedNamespace = PackageId.parse(namespace);
if (!parsedNamespace.ok) throw parsedNamespace.error;
const rootGuid = AssetGuid.format(AssetGuid.derive(parsedNamespace.value, 'plugin/scene'));
async function writeSceneRoot(root: string, loader: boolean): Promise<void> {
  await writeFile(
    resolve(root, 'assets/plugins.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: namespace,
      assets: {
        'plugin/scene': { kind: 'plugin', payload: { module: { specifier: '../scene-root.ts' } } },
        'plugin/unused-gameplay': {
          kind: 'plugin',
          payload: { module: { specifier: '../gameplay.ts' } },
        },
      },
    }),
  );
  await writeFile(
    resolve(root, 'scene-root.ts'),
    `import component from './scene-component';
${loader ? "import loader from './scene-loader';" : ''}
export default { apply(ctx) { globalThis.__forgeaxSceneContext = ctx; ctx.effect(() => () => { globalThis.__forgeaxSceneDisposed = true; }); ctx.plugin(component); ${loader ? 'ctx.plugin(loader);' : ''} } };`,
  );
}

type ActivationWitness = {
  readonly componentImports: number;
  readonly componentApplies: number;
  readonly loaderImports: number;
  readonly loaderApplies: number;
  readonly gameplayImports: number;
};

function browserExecutable(): string | undefined {
  const candidates = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/opt/google/chrome-beta/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    typeof chromium.executablePath === 'function' ? chromium.executablePath() : undefined,
  ];
  return candidates.find(
    (candidate): candidate is string => candidate !== undefined && existsSync(candidate),
  );
}

async function listen(
  config: Awaited<ReturnType<typeof createViteConfig>>,
  onSceneRootEvent?: (event: string) => void,
): Promise<ViteDevServer> {
  const port = await allocateLoopbackPort();
  const hotUpdateTrace: Plugin = {
    name: 'scene-bootstrap-hot-update-trace',
    enforce: 'post',
    hotUpdate(context) {
      if (onSceneRootEvent && String(context.file).includes('scene-root'))
        onSceneRootEvent(`hot:${this.environment.name}:${context.file}`);
    },
  };
  const configuredWatch = config.server?.watch;
  const watch =
    process.platform === 'darwin' && configuredWatch !== null
      ? { ...(configuredWatch ?? {}), usePolling: true, interval: 100 }
      : configuredWatch;
  const serverOptions = { ...(config.server ?? {}) };
  delete serverOptions.watch;
  const server = await createServer({
    ...config,
    plugins: [
      {
        name: 'scene-bootstrap-source-watch-trace',
        enforce: 'pre',
        configureServer(target: ViteDevServer) {
          if (onSceneRootEvent) {
            target.watcher.on('all', (event, filename) => {
              if (String(filename).includes('scene-root'))
                onSceneRootEvent(`watch:${event}:${filename}`);
            });
          }
        },
      },
      ...(config.plugins ?? []),
      ...(onSceneRootEvent ? [hotUpdateTrace] : []),
    ],
    logLevel: 'silent',
    // This gate checks scene and Worker startup, not Vite's dependency scanner.
    // Discovery can invalidate an in-flight optimized import with a 504 while
    // the page still renders; keep its module graph stable for this fixture.
    optimizeDeps: { ...config.optimizeDeps, noDiscovery: true, include: [] },
    server: {
      ...serverOptions,
      ...(watch === undefined ? {} : { watch }),
      host: '127.0.0.1',
      port,
      strictPort: true,
    },
  });
  await server.listen();
  return server;
}

function capturePageFailures(page: Page, failures: string[]): void {
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('requestfailed', (request) => {
    const error = request.failure()?.errorText;
    // Vite may replace the first document after dependency discovery. The
    // browser cancels its in-flight module requests; readiness below proves
    // that the replacement document loaded the same required entry.
    if (error !== 'net::ERR_ABORTED') failures.push(`${request.url()}: ${error}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()}: ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
}

describe('native scene root bootstrap', () => {
  it('activates a scene root without importing an unused gameplay asset', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-scene-bootstrap-'));
    const root = resolve(parent, '.forgeax/game');
    let server: ViteDevServer | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    const pageErrors: string[] = [];
    const previousWorkers = process.env.FORGEAX_EXECUTION_WORKERS;
    const sceneRootWatchEvents: string[] = [];
    process.env.FORGEAX_EXECUTION_WORKERS = JSON.stringify({
      engine: false,
      render: false,
      kernels: false,
    });
    try {
      await mkdir(resolve(root, 'assets'), { recursive: true });
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'scene-bootstrap',
            name: 'Scene Bootstrap',
            schemaVersion: '3.0.0',
            roots: { engine: rootGuid },
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"scene-bootstrap"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
        writeFile(
          resolve(root, 'scene-component.ts'),
          `import { Camera } from '@forgeax/engine/render';\nimport { Transform } from '@forgeax/engine/scene';\nconst state = globalThis.__forgeaxSceneActivation;\nstate.componentImports += 1;\nexport default {\n  name: 'scene-component',\n  inject: ['world'],\n  apply(ctx) {\n    state.componentApplies += 1;\n    ctx.world.spawn(\n      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.01, far: 100 } },\n      { component: Transform, data: { pos: [0, 0, 3] } },\n    );\n  },\n};\n`,
        ),
        writeFile(
          resolve(root, 'scene-loader.ts'),
          `const state = globalThis.__forgeaxSceneActivation;\nstate.loaderImports += 1;\nexport default {\n  name: 'scene-loader',\n  inject: ['assets'],\n  apply() { state.loaderApplies += 1; },\n};\n`,
        ),
        writeFile(
          resolve(root, 'gameplay.ts'),
          `const state = globalThis.__forgeaxSceneActivation;\nstate.gameplayImports += 1;\nthrow new Error('gameplay entry was imported during scene bootstrap');\n`,
        ),
      ]);

      await writeSceneRoot(root, true);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      server = await listen(
        await createViteConfig(facts.value, 'serve', '/', { bootstrapRoot: 'project-bootstrap' }),
        (event) => sceneRootWatchEvents.push(event),
      );
      const sceneRootPath = resolve(root, 'scene-root.ts');
      const address = server.httpServer?.address();
      if (address === null || address === undefined || typeof address === 'string') {
        throw new Error('scene bootstrap server did not expose a TCP address');
      }

      const executablePath = browserExecutable();
      browser = await chromium.launch({
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: [
          '--enable-unsafe-webgpu',
          '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
          '--use-vulkan=swiftshader',
          '--use-angle=swiftshader',
          '--ignore-gpu-blocklist',
          '--disable-gpu-driver-bug-workarounds',
          '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
        ],
        chromiumSandbox: true,
      });
      page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      capturePageFailures(page, pageErrors);
      await page.addInitScript(() => {
        (
          globalThis as typeof globalThis & { __forgeaxSceneActivation: ActivationWitness }
        ).__forgeaxSceneActivation = {
          componentImports: 0,
          componentApplies: 0,
          loaderImports: 0,
          loaderApplies: 0,
          gameplayImports: 0,
        };
      });
      await page.goto(`http://127.0.0.1:${address.port}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
      try {
        await page.waitForFunction(
          () => {
            const state = (
              globalThis as typeof globalThis & { __forgeaxSceneActivation?: ActivationWitness }
            ).__forgeaxSceneActivation;
            return state?.componentApplies === 1 && state.loaderApplies === 1;
          },
          undefined,
          { timeout: 120_000 },
        );
      } catch (cause) {
        const state = await page.evaluate(
          () =>
            (globalThis as typeof globalThis & { __forgeaxSceneActivation?: ActivationWitness })
              .__forgeaxSceneActivation,
        );
        throw new Error(
          `${cause instanceof Error ? cause.message : String(cause)} state=${JSON.stringify(state)} pageErrors=${JSON.stringify(pageErrors)}`,
        );
      }
      const witness = await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __forgeaxSceneActivation: ActivationWitness })
            .__forgeaxSceneActivation,
      );
      expect(witness).toEqual({
        componentImports: 1,
        componentApplies: 1,
        loaderImports: 1,
        loaderApplies: 1,
        gameplayImports: 0,
      });
      expect(pageErrors).toEqual([]);
      let navigations = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page?.mainFrame()) navigations++;
      });
      const rootSource = await readFile(sceneRootPath, 'utf8');
      const stagedRoot = resolve(root, 'scene-root.pending');
      const sceneRootEventStart = sceneRootWatchEvents.length;
      await writeFile(stagedRoot, 'export default { broken: ; };');
      await rename(stagedRoot, sceneRootPath);
      try {
        await page.waitForFunction(
          () => document.querySelector('vite-error-overlay') !== null,
          undefined,
          { timeout: 360_000 },
        );
      } catch (cause) {
        const currentSource = await readFile(sceneRootPath, 'utf8');
        throw new Error(
          `invalid scene source did not reach the browser overlay: ${JSON.stringify({ sceneRootWatchEvents: sceneRootWatchEvents.slice(sceneRootEventStart), currentSource, pageErrors })}`,
          { cause },
        );
      }
      const invalidSaveEvents = sceneRootWatchEvents.slice(sceneRootEventStart);
      expect(
        invalidSaveEvents.some(
          (event) => event.startsWith('watch:') && event.includes('scene-root.ts'),
        ),
      ).toBe(true);
      expect(
        invalidSaveEvents.some(
          (event) => event.startsWith('hot:client:') && event.includes('scene-root.ts'),
        ),
      ).toBe(true);
      expect(navigations).toBe(0);
      expect(
        await page.evaluate(
          () =>
            (globalThis as typeof globalThis & { __forgeaxSceneActivation: ActivationWitness })
              .__forgeaxSceneActivation.componentApplies,
        ),
      ).toBe(1);
      // Two successive edits must converge on the last source snapshot in a new environment.
      for (const revision of ['2', '3']) {
        await writeFile(
          stagedRoot,
          rootSource.replace(
            'apply(ctx) {',
            `apply(ctx) { document.body.dataset.pluginRevision = '${revision}';`,
          ),
        );
        // A source save is one complete revision. Direct writeFile briefly
        // exposes an empty source while Vite scans the same path.
        await rename(stagedRoot, resolve(root, 'scene-root.ts'));
      }
      await page.waitForFunction(() => document.body.dataset.pluginRevision === '3', undefined, {
        timeout: 720_000,
      });
      expect(navigations).toBeGreaterThan(0);
      expect(
        await page.evaluate(
          () =>
            (globalThis as typeof globalThis & { __forgeaxSceneActivation: ActivationWitness })
              .__forgeaxSceneActivation,
        ),
      ).toEqual(witness);
      const unexpected = pageErrors.filter(
        (message) =>
          !/broken|Parse error|Unexpected token|Expected.*expression|500.*scene-root|Build failed|Transform failed/i.test(
            message,
          ),
      );
      expect(unexpected).toEqual([]);
      // Engine activation can precede App startup completion. Leaving at this
      // boundary must also release an App that completes after pagehide.
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      try {
        await page.waitForFunction(
          () =>
            (globalThis as typeof globalThis & { __forgeaxSceneDisposed?: boolean })
              .__forgeaxSceneDisposed === true,
          undefined,
          { timeout: 5_000 },
        );
      } catch (cause) {
        const cleanup = await page.evaluate(() => {
          const ctx = (globalThis as typeof globalThis & { __forgeaxSceneContext?: Context })
            .__forgeaxSceneContext;
          return [...(ctx?.registry.values() ?? [])].flatMap((runtime) =>
            [...runtime.fibers].map((fiber) => ({
              name: runtime.name,
              state: fiber.state,
              uid: fiber.uid,
              parent: fiber.parent.fiber.runtime?.name,
              inertia: Boolean(fiber.inertia),
            })),
          );
        });
        throw new Error(`scene cleanup failed: ${JSON.stringify({ cleanup, pageErrors })}`, {
          cause,
        });
      }
    } finally {
      await page?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
      if (previousWorkers === undefined) delete process.env.FORGEAX_EXECUTION_WORKERS;
      else process.env.FORGEAX_EXECUTION_WORKERS = previousWorkers;
    }
  }, 1_200_000);

  it.each([
    undefined,
    { engine: false },
    { render: false, kernels: false },
  ])('activates project logic and Host UI with policy %j', async (workers) => {
    const bootstrapRoot = 'project-bootstrap' as const;
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-scene-worker-'));
    let server: ViteDevServer | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    const pageErrors: string[] = [];
    const previousExecution = process.env.FORGEAX_EXECUTION_WORKERS;
    if (workers === undefined) delete process.env.FORGEAX_EXECUTION_WORKERS;
    else process.env.FORGEAX_EXECUTION_WORKERS = JSON.stringify(workers);
    try {
      await mkdir(resolve(root, 'assets'));
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'scene-worker-bootstrap',
            name: 'Scene Worker Bootstrap',
            schemaVersion: '3.0.0',
            roots: {
              engine: rootGuid,
              frontend: AssetGuid.format(AssetGuid.derive(parsedNamespace.value, 'plugin/ui')),
            },
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"scene-worker-bootstrap"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
        writeFile(
          resolve(root, 'scene-component.ts'),
          `import { Camera } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
export default {
  name: 'scene-component',
  inject: ['world'],
  apply(ctx) {
    ctx.world.spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.01, far: 100, clearColor: [0.1, 0.2, 0.3, 1] } },
    );
  },
};
`,
        ),
        writeFile(
          resolve(root, 'gameplay.ts'),
          `export default { name: 'worker-gameplay', inject: ['world', 'gameHost'], apply(ctx) { globalThis.__workerGameHost = { world: typeof ctx.world.identity, renderer: 'renderer' in ctx.gameHost, assets: ctx.gameHost.assets !== undefined }; } };`,
        ),
        writeFile(
          resolve(root, 'ui.ts'),
          `export default { name: 'host-ui', inject: ['gameHost'], apply(ctx) {
            const host = ctx.gameHost;
            globalThis.__hostApp = host.app;
            ctx.effect(() => {
              const button = document.createElement('button');
              button.id = 'host-ui'; button.textContent = 'Host ready'; button.style.pointerEvents = 'auto';
              button.onclick = () => { button.textContent = 'Clicked'; };
              host.uiRoot.append(button);
              return () => button.remove();
            });
          } };`,
        ),
      ]);

      await writeSceneRoot(root, false);
      const pack = JSON.parse(await readFile(resolve(root, 'assets/plugins.pack.json'), 'utf8'));
      pack.assets['plugin/ui'] = { kind: 'plugin', payload: { module: { specifier: '../ui.ts' } } };
      await writeFile(resolve(root, 'assets/plugins.pack.json'), JSON.stringify(pack));
      await writeFile(
        resolve(root, 'scene-root.ts'),
        `import component from './scene-component'; import game from './gameplay';
        export default { apply(ctx) { ctx.plugin(component); ctx.plugin(game); } };`,
      );
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      const config = await createViteConfig(facts.value, 'serve', '/', { bootstrapRoot });
      server = await listen({
        ...config,
        server: {
          ...config.server,
          headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          },
        },
      });
      const address = server.httpServer?.address();
      if (address === null || address === undefined || typeof address === 'string') {
        throw new Error('Worker scene bootstrap server did not expose a TCP address');
      }

      const executablePath = browserExecutable();
      browser = await chromium.launch({
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: [
          '--enable-unsafe-webgpu',
          '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
          '--use-vulkan=swiftshader',
          '--use-angle=swiftshader',
          '--ignore-gpu-blocklist',
          '--disable-gpu-driver-bug-workarounds',
          '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
        ],
        chromiumSandbox: true,
      });
      page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      capturePageFailures(page, pageErrors);
      await page.addInitScript(() => {
        const Original = globalThis.Worker;
        const messages: unknown[] = [];
        Object.assign(globalThis, { __workerMessages: messages });
        globalThis.Worker = class extends Original {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            messages.push({ created: String(url) });
            this.addEventListener('message', (event) => messages.push(event.data));
            this.addEventListener('error', (event) => messages.push({ error: event.message }));
          }
        };
      });
      await page.goto(`http://127.0.0.1:${address.port}/`, {
        // The generated module owns a top-level Worker handshake. Waiting for
        // DOMContentLoaded would hide a bootstrap fault behind Playwright's
        // navigation timeout; the static canvas is already present at commit.
        waitUntil: 'commit',
        timeout: 120_000,
      });
      try {
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.forgeaxFrameSubmitted !== undefined &&
            (globalThis as typeof globalThis & { __hostApp?: unknown }).__hostApp !== undefined &&
            document.querySelector('#host-ui') !== null,
          undefined,
          { timeout: 130_000 },
        );
      } catch (cause) {
        const state = await page.evaluate(() => ({
          readyState: document.readyState,
          fatal: document.querySelector('#forgeax-fatal')?.textContent,
          diagnostics: document.querySelector('#forgeax-fatal-details')?.textContent,
          frame: document.documentElement.dataset.forgeaxFrameSubmitted,
          workers: (globalThis as typeof globalThis & { __workerMessages?: unknown[] })
            .__workerMessages,
        }));
        throw new Error(
          `${cause instanceof Error ? cause.message : String(cause)} state=${JSON.stringify(state)} pageErrors=${JSON.stringify(pageErrors)}`,
        );
      }
      const engine = page
        .workers()
        .find((worker) => worker.url().includes('engine-worker-runtime'));
      expect(engine !== undefined).toBe(workers?.engine !== false);
      const source = engine ?? page;
      expect(
        await source.evaluate(
          () => (globalThis as unknown as { __workerGameHost: unknown }).__workerGameHost,
        ),
      ).toEqual({ world: 'string', renderer: false, assets: true });
      const selected = await page.evaluate(
        () =>
          (
            globalThis as unknown as { __hostApp: import('@forgeax/engine-app').ExecutionApp }
          ).__hostApp.execution.report().workers,
      );
      expect(selected.engine.enabled).toBe(workers?.engine !== false);
      expect(selected.render.enabled).toBe(workers === undefined);
      expect(selected.kernels.enabled).toBe(workers === undefined);
      await page.locator('#host-ui').click();
      expect(await page.locator('#host-ui').textContent()).toBe('Clicked');
      await page.setViewportSize({ width: 720, height: 400 });
      await page.waitForFunction(
        () => document.querySelector<HTMLCanvasElement>('#app')?.width === 720,
      );
      const canvasPng = await page.locator('canvas').first().screenshot({ type: 'png' });
      const decoded = parseImage(canvasPng, 'image/png', { mipmap: false });
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      const firstPixelLuma = Math.round(
        (54 * (decoded.value.bytes[0] ?? 0) +
          183 * (decoded.value.bytes[1] ?? 0) +
          19 * (decoded.value.bytes[2] ?? 0)) /
          256,
      );
      expect(firstPixelLuma).toBeGreaterThan(8);
      expect(pageErrors).toEqual([]);
    } finally {
      await page?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      if (previousExecution === undefined) delete process.env.FORGEAX_EXECUTION_WORKERS;
      else process.env.FORGEAX_EXECUTION_WORKERS = previousExecution;
    }
  }, 600_000);
});
