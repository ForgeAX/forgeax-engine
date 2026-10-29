import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { build, normalizePath, type Rollup } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

async function fixture(base = './') {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-bootstrap-cache-'));
  await mkdir(resolve(root, 'assets'));
  await mkdir(resolve(root, 'node_modules'));
  const runtime = resolve(root, 'node_modules/runtime.mjs');
  await writeFile(resolve(root, 'package.json'), '{"name":"bootstrap-cache","type":"module"}');
  await writeFile(
    resolve(root, 'forge.json'),
    JSON.stringify({
      id: 'bootstrap-cache',
      name: 'Bootstrap cache',
      schemaVersion: '3.0.0',
      roots: {},
    }),
  );
  const facts = await readProjectFacts(root);
  if (!facts.ok) throw facts.error;
  const config = await createViteConfig(facts.value, 'build', base);
  const generated = config.root;
  if (generated === undefined) throw new Error('Missing generated root');
  const host = await readFile(resolve(generated, 'main.ts'), 'utf8');
  const expression = /bootstrap: (new URL\([\s\S]+?\n\s+\)),/.exec(host)?.[1];
  if (expression === undefined) throw new Error('Missing generated bootstrap URL');
  const runtimeImport = JSON.stringify(normalizePath(runtime));
  await writeFile(
    resolve(generated, 'index.html'),
    '<script type="module" src="./main.ts"></script>',
  );
  await writeFile(
    resolve(generated, 'main.ts'),
    `import { registry } from ${runtimeImport};
const bootstrap = ${expression};
globalThis.bootstrapProbe = {
  version: registry.version,
  bootstrap: bootstrap.href,
  start: () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./engine-worker-runtime.mjs', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Bootstrap Worker did not reply')); }, 5000);
    worker.onmessage = event => { clearTimeout(timeout); worker.terminate(); resolve(event.data); };
    worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage(bootstrap.href);
  }),
};`,
  );
  await writeFile(
    resolve(generated, 'execution-bootstrap.ts'),
    `import { registry } from ${runtimeImport}; export default () => registry;`,
  );
  await writeFile(
    resolve(generated, 'engine-worker-runtime.mjs'),
    `import { registry } from ${runtimeImport};
self.onmessage = async event => {
  try {
    const value = (await import(event.data)).default();
    self.postMessage({ version: value.version, sameOwner: value === registry, loads: globalThis.registryLoads });
  } catch (cause) { self.postMessage({ error: String(cause) }); }
};`,
  );
  return {
    root,
    async build(version: string) {
      // Installed runtime bytes can change without changing the authored SSR input identity.
      await writeFile(
        runtime,
        `globalThis.registryLoads = (globalThis.registryLoads ?? 0) + 1;
export const registry = Object.freeze({ version: ${JSON.stringify(version)} });`,
      );
      const result = await build({
        ...config,
        configFile: false,
        logLevel: 'silent',
        build: { ...config.build, write: false, minify: false },
      });
      const output = (Array.isArray(result) ? result : [result]).flatMap((value) =>
        'output' in value ? value.output : [],
      );
      const bootstrap = output.find(
        (value): value is Rollup.OutputChunk =>
          value.type === 'chunk' &&
          value.facadeModuleId === normalizePath(resolve(generated, 'execution-bootstrap.ts')),
      );
      if (bootstrap === undefined) throw new Error('Missing built bootstrap');
      return { output, bootstrap };
    },
  };
}

it.each([
  '/',
  './',
  '/play/game/',
  'https://cdn.test/play/game/',
])('changes the bootstrap filename and page reference with runtime bytes at base %s', async (base) => {
  const f = await fixture(base);
  try {
    const first = await f.build('one');
    expect(first.bootstrap.fileName).toMatch(/^assets\/execution-bootstrap-[\w-]+\.js$/);
    const unchanged = await f.build('one');
    const changed = await f.build('two');
    expect(unchanged.bootstrap.fileName).toBe(first.bootstrap.fileName);
    expect(changed.bootstrap.fileName).not.toBe(first.bootstrap.fileName);
    for (const result of [first, changed]) {
      const page = result.output.find(
        (value): value is Rollup.OutputChunk => value.type === 'chunk' && value.name === 'index',
      );
      expect(page?.code).toContain(result.bootstrap.fileName.split('/').at(-1));
      expect(page?.code).not.toContain('execution-bootstrap.js?v=');
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('loads a new deployment in a cached browser without mixing page, Worker and bootstrap modules', async () => {
  const f = await fixture('/play/game/');
  const resources = new Map<string, string | Uint8Array>();
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
    const key = path === '/play/game/' ? '/play/game/index.html' : path;
    const resource = resources.get(key);
    if (resource === undefined) {
      response.writeHead(404).end();
      return;
    }
    requests.push(path);
    response.setHeader(
      'Cache-Control',
      key.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
    response.setHeader('Content-Type', key.endsWith('.html') ? 'text/html' : 'text/javascript');
    response.end(resource);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing fixture address');
    browser = await chromium.launch({
      ...(process.env.FORGEAX_CHROME_CHANNEL === undefined
        ? {}
        : { channel: process.env.FORGEAX_CHROME_CHANNEL }),
      headless: true,
      chromiumSandbox: true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const bootstraps: string[] = [];
    for (const version of ['one', 'two']) {
      const result = await f.build(version);
      // Retain old hashed chunks, just as a CDN can retain the previous deployment.
      for (const value of result.output)
        resources.set(
          `/play/game/${value.fileName}`,
          value.type === 'chunk' ? value.code : value.source,
        );
      bootstraps.push(`/play/game/${result.bootstrap.fileName}`);
      await page.goto(`http://127.0.0.1:${address.port}/play/game/`);
      await page
        .waitForFunction(() => 'bootstrapProbe' in globalThis)
        .catch((cause) => {
          throw new Error(JSON.stringify({ pageErrors, requests }), { cause });
        });
      const actual = await page.evaluate(async () => {
        const probe = (
          globalThis as unknown as {
            bootstrapProbe: { version: string; bootstrap: string; start(): Promise<unknown> };
          }
        ).bootstrapProbe;
        return {
          version: probe.version,
          bootstrap: new URL(probe.bootstrap).pathname,
          worker: await probe.start(),
        };
      });
      expect(actual).toEqual({
        version,
        bootstrap: bootstraps.at(-1),
        worker: { version, sameOwner: true, loads: 1 },
      });
    }
    expect(bootstraps[1]).not.toBe(bootstraps[0]);
    for (const bootstrap of bootstraps)
      expect(requests.filter((path) => path === bootstrap)).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(f.root, { recursive: true, force: true });
  }
});
