import { existsSync } from 'node:fs';
// @perf-budget-skip: generated Engine loading/HTTP cache lifecycle; GPU acceptance is separate.
import { createServer, type ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { createStartupCacheIdentity } from '../host/startup-cache-identity.js';
import { type StartupCacheIdentity, startupEntrySource } from '../host/startup-cache-source.js';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';

async function fixture(resetInvalidatesDocument = false, holdReset = false) {
  let resetGate: ServerResponse | undefined;
  let identity: StartupCacheIdentity = createStartupCacheIdentity({
    project: 'cache-test',
    game: 'game-1',
    engine: 'engine-1',
  });
  let poisonEntry = false,
    poisonLoader = false,
    legacyWorker = false;
  const bootstrap = () => startupEntrySource(identity, './entry.mjs');
  let code = 'globalThis.entryVersion=1;',
    entries = 0,
    resets = 0,
    pages = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.searchParams.get('forgeax-startup-cache-reset') === '1') {
      resets++;
      response.setHeader('Clear-Site-Data', '"cache"');
    }
    if (url.pathname === '/game/reset-gate') {
      resetGate = response;
      return;
    }
    if (url.pathname === '/game/entry.mjs') {
      entries++;
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=3600',
      });
      response.end(
        poisonEntry && entries === 1 ? 'throw Error("stale HTTP Engine module");' : code,
      );
      return;
    }
    if (url.pathname.startsWith('/game/loader-')) {
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=3600',
      });
      const source = poisonLoader ? 'throw Error("stale bootstrap module");' : bootstrap();
      poisonLoader = false;
      response.end(source);
      return;
    }
    if (url.pathname === '/game/worker.js') {
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      response.end(`
        self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
        self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
        let resetClient;
        self.addEventListener('fetch',e=>{if(${resetInvalidatesDocument}&&e.clientId===resetClient&&new URL(e.request.url).pathname.endsWith('.mjs')){e.respondWith(new Response('Retired startup document',{status:503}));return;}if(new URL(e.request.url).pathname==='/game/entry.mjs')e.respondWith((async()=>await(await caches.open('engine-test')).match(e.request,{ignoreSearch:true})||fetch(e.request))());});
        self.addEventListener('message',e=>{
          if(${legacyWorker}||e.data?.kind!=='forgeax-startup-cache')return;
          const port=e.ports[0];port.postMessage({protocol:e.data.protocol,accepted:true});
          e.waitUntil((async()=>{
            if(e.data.action==='reset'){if(${holdReset})await(await fetch('/game/reset-gate')).text();resetClient=e.source.id;await(await caches.open('engine-test')).delete('/game/entry.mjs');}
            port.postMessage({protocol:e.data.protocol,ok:true});
          })());
        });`);
      return;
    }
    if (url.pathname === '/game/seed.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Cache seed</title>');
      return;
    }
    pages++;
    const html = hostStartupDocument('Engine default loading', undefined, identity).replace(
      '</body>',
      `
      <script>${hostStartupScript(true, 'undefined', undefined, identity)}</script>
      <script type="module" src="./loader-${encodeURIComponent(JSON.stringify(identity))}.mjs"></script>
      </body>`,
    );
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const executablePath = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    '/opt/google/chrome-beta/chrome',
    chromium.executablePath(),
  ].find((path): path is string => path !== undefined && existsSync(path));
  const browser = await chromium
    .launch({
      headless: true,
      ...(executablePath === undefined ? {} : { executablePath }),
      chromiumSandbox: true,
    })
    .catch(async (error) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    });
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    page,
    context,
    origin,
    get entries() {
      return entries;
    },
    get resets() {
      return resets;
    },
    get pages() {
      return pages;
    },
    get resetPending() {
      return resetGate !== undefined;
    },
    releaseReset: () => resetGate?.end('ready'),
    poisonHttpEntry: () => {
      poisonEntry = true;
    },
    poisonHttpLoader: () => {
      poisonLoader = true;
    },
    change: (versions: Partial<StartupCacheIdentity>, source: string) => {
      identity = createStartupCacheIdentity({ ...identity, ...versions });
      code = source;
    },
    open: (query = '') => page.goto(`${origin}/game/index.html${query}`),
    seedWorker: async (legacy = false) => {
      legacyWorker = legacy;
      await page.goto(`${origin}/game/seed.html`);
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('./worker.js');
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
          await new Promise<void>((resolve) =>
            navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
              once: true,
            }),
          );
        await (await caches.open('engine-test')).put(
          '/game/entry.mjs',
          new Response('throw Error("stale Engine module before game code");', {
            headers: { 'content-type': 'text/javascript' },
          }),
        );
        localStorage.setItem('player-settings', 'keep');
        await (await caches.open('other-project')).put('/keep', new Response('keep'));
      });
      legacyWorker = false;
    },
    close: async () => {
      resetGate?.end('closed');
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it('recovers a cached Engine-module failure in the default loading screen before any game code', async () => {
  const f = await fixture();
  try {
    await f.seedWorker();
    await f.open();
    await f.page.waitForFunction(() => Reflect.get(globalThis, 'entryVersion') === 1);
    expect(new URL(f.page.url()).searchParams.get('forgeax-startup-retry')).toBe('1');
    expect(f.resets).toBe(1);
    expect(f.entries).toBe(1);
    expect(await f.page.locator('#forgeax-loading').isVisible()).toBe(true);
    expect(
      await f.page.evaluate(async () => ({
        settings: localStorage.getItem('player-settings'),
        other: !!(await (await caches.open('other-project')).match('/keep')),
      })),
    ).toEqual({ settings: 'keep', other: true });
  } finally {
    await f.close();
  }
}, 60000);

it.each([
  false,
  true,
])('stops after one real Engine startup retry and retains both failures (storage denied: %s)', async (denied) => {
  const f = await fixture();
  try {
    f.change({}, 'throw Error("real Engine initialization failure");');
    if (denied)
      await f.context.addInitScript(() =>
        Object.defineProperty(window, 'sessionStorage', {
          get() {
            throw new DOMException('denied', 'SecurityError');
          },
        }),
      );
    await f.open();
    await f.page.waitForFunction(() =>
      document.querySelector('#forgeax-fatal-details')?.textContent?.includes('attempted once'),
    );
    expect(f.resets).toBe(1);
    expect(f.pages).toBe(3); // Two document loads plus the cache-reset fetch.
    const details = await f.page.locator('#forgeax-fatal-details').textContent();
    expect(details).toContain('real Engine initialization failure');
    if (!denied) expect(details).toContain('First failure:');
    expect(await f.page.locator('#forgeax-loading').isVisible()).toBe(false);
  } finally {
    await f.close();
  }
}, 60000);

it.each([
  { game: 'game-2' },
  { engine: 'engine-2' },
  { revision: 'changed-source' },
])('revalidates fresh HTTP modules before startup when identity changes: %j', async (change) => {
  const f = await fixture();
  try {
    await f.open();
    await f.page.waitForFunction(() => Reflect.get(globalThis, 'entryVersion') === 1);
    // Exact UI receipt lifecycle; this test validates loading ownership, not GPU rendering.
    await f.page.evaluate(() => {
      const startup = Reflect.get(globalThis, '__forgeaxStartup'),
        canvas = document.querySelector('#app');
      if (!canvas) throw Error('Missing Engine canvas');
      startup.bindSession('test-world');
      startup.prepare();
      const detail = {
        worldIdentity: 'test-world',
        deviceGeneration: 1,
        frameId: 1,
        presentation: 'ready',
      };
      canvas.dispatchEvent(new CustomEvent('forgeax:frame-submitted', { bubbles: true, detail }));
      canvas.dispatchEvent(new CustomEvent('forgeax:frame-completed', { bubbles: true, detail }));
    });
    expect(
      await f.page.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith('forgeax.startup/')),
      ),
    ).toHaveLength(1);
    f.change(change, 'globalThis.entryVersion=2;');
    await f.open();
    await f.page.waitForFunction(() => Reflect.get(globalThis, 'entryVersion') === 2);
    expect(f.resets).toBe(1);
    expect(f.entries).toBe(2);
    expect(new URL(f.page.url()).searchParams.has('forgeax-startup-retry')).toBe(false);
  } finally {
    await f.close();
  }
}, 60000);

it.each([
  'entry',
  'loader',
] as const)('recovers stale HTTP %s bytes before Game execution without a Service Worker', async (subject) => {
  const f = await fixture();
  try {
    if (subject === 'entry') f.poisonHttpEntry();
    else f.poisonHttpLoader();
    await f.open();
    await f.page.waitForFunction(() => Reflect.get(globalThis, 'entryVersion') === 1);
    expect(f.resets).toBe(1);
    expect(new URL(f.page.url()).searchParams.get('forgeax-startup-retry')).toBe('1');
  } finally {
    await f.close();
  }
}, 60000);

it('retries an Engine prewarm fault while loading, retaining its structured error on the second failure', async () => {
  const f = await fixture();
  try {
    f.change(
      {},
      `globalThis.__forgeaxStartup.fail({code:'pipeline-library-failed',message:'Engine prewarm failed',hint:'repair the pipeline library'}, {fault:{phase:'startup'}});`,
    );
    await f.open();
    await f.page.waitForFunction(() =>
      document.querySelector('#forgeax-fatal-details')?.textContent?.includes('attempted once'),
    );
    const details = await f.page.locator('#forgeax-fatal-details').textContent();
    expect(details).toContain('pipeline-library-failed');
    expect(details).toContain('repair the pipeline library');
    expect(f.resets).toBe(1);
  } finally {
    await f.close();
  }
}, 60000);

it('updates an existing legacy cache owner before its single startup retry', async () => {
  const f = await fixture();
  try {
    await f.seedWorker(true);
    await f.open();
    await f.page.waitForFunction(() => Reflect.get(globalThis, 'entryVersion') === 1);
    expect(f.resets).toBe(1);
    expect(
      await f.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
    ).toBe(1);
  } finally {
    await f.close();
  }
}, 60000);

it('preserves runtime failures after the first accepted ready frame without clearing caches', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.page.waitForFunction(() => Reflect.get(globalThis, 'entryVersion') === 1);
    await f.page.evaluate(() => {
      const startup = Reflect.get(globalThis, '__forgeaxStartup');
      const canvas = document.querySelector('#app');
      if (!canvas) throw Error('Missing Engine canvas');
      startup.bindSession('ready-world');
      startup.prepare();
      const detail = {
        worldIdentity: 'ready-world',
        deviceGeneration: 1,
        frameId: 1,
        presentation: 'ready',
      };
      canvas.dispatchEvent(new CustomEvent('forgeax:frame-submitted', { bubbles: true, detail }));
      canvas.dispatchEvent(new CustomEvent('forgeax:frame-completed', { bubbles: true, detail }));
      startup.fail(Error('runtime failure after entry'));
    });
    expect(await f.page.locator('#forgeax-fatal-details').textContent()).toContain(
      'runtime failure after entry',
    );
    // Two rendering turns drain the recovery callback without a wall-clock sleep.
    await f.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    expect(f.resets).toBe(0);
    expect(f.pages).toBe(1);
    expect(new URL(f.page.url()).searchParams.has('forgeax-startup-retry')).toBe(false);
  } finally {
    await f.close();
  }
}, 60000);

it('still retries when a cache owner retires the failed document or its old module URL is unavailable', async () => {
  const f = await fixture(true);
  try {
    await f.seedWorker();
    await f.open();
    await f.page.waitForFunction(() => Reflect.get(globalThis, 'entryVersion') === 1);
    expect(f.resets).toBe(1);
    expect(new URL(f.page.url()).searchParams.get('forgeax-startup-retry')).toBe('1');
  } finally {
    await f.close();
  }
}, 60000);

it('keeps default loading nonterminal while its cache reset is pending', async () => {
  const f = await fixture(false, true);
  try {
    await f.seedWorker();
    await f.open();
    await expect.poll(() => f.resetPending, { timeout: 5000 }).toBe(true);
    expect(await f.page.locator('#forgeax-fatal').isVisible()).toBe(false);
    expect(await f.page.locator('#forgeax-loading').isVisible()).toBe(true);
    f.releaseReset();
    await f.page.waitForFunction(() => Reflect.get(globalThis, 'entryVersion') === 1);
    expect(f.resets).toBe(1);
  } finally {
    await f.close();
  }
}, 60000);

it('preserves a managed Play target failure before its first frame without autonomous navigation', async () => {
  const f = await fixture();
  try {
    f.change({}, 'throw Error("managed Play target failed before its first frame");');
    await f.open('?forgeaxWorkspace=game');
    await f.page.locator('#forgeax-fatal').waitFor({ state: 'visible' });
    expect(await f.page.locator('#forgeax-fatal-details').textContent()).toContain(
      'managed Play target failed before its first frame',
    );
    expect(f.resets).toBe(0);
    expect(f.pages).toBe(1);
    expect(new URL(f.page.url()).searchParams.has('forgeax-startup-retry')).toBe(false);
  } finally {
    await f.close();
  }
}, 60000);
