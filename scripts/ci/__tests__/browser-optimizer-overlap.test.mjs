import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';
import { browserProcessCacheDir } from '../browser-process-cache.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const files = [
  'render-temporal-environment-consumer',
  'standard-output',
  'surface-standard-pipeline',
  'taa-stability-feedback',
].map((name) => `packages/render/src/__tests__/${name}.browser.test.ts`);
files.push(
  'packages/render/src/cloud/__tests__/cloud-layer.browser.test.ts',
  'packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts',
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function open(config, selection, signal) {
  signal.throwIfAborted();
  console.log(
    '[browser-optimizer-owner] open',
    JSON.stringify({
      config,
      selection,
      node: process.version,
      sharedInputs: process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST ?? null,
    }),
  );
  process.argv = [
    process.execPath,
    `${root}/node_modules/vitest/vitest.mjs`,
    'run',
    '--config',
    config,
    '--project=browser',
    '--maxWorkers=1',
    ...selection,
  ];
  const ctx = await createVitest('test', {
    root,
    config: `${root}/${config}`,
    watch: false,
    project: ['browser'],
  });
  try {
    signal.throwIfAborted();
    console.log('[browser-optimizer-owner] config-ready', config);
    await ctx.globTestSpecifications(selection);
    await ctx._initBrowserServers();
    signal.throwIfAborted();
    const project = ctx.projects.find((project) => project.browser);
    assert.ok(project, 'actual Browser Vite server initialized');
    assert.equal(
      project.browser.provider,
      undefined,
      'CPU regression must not launch a browser/device',
    );
    console.log(
      '[browser-optimizer-owner] server-ready',
      JSON.stringify({
        config,
        cacheDir: project.browser.vite.config.cacheDir,
        includes: project.config.include,
      }),
    );
    return { ctx, server: project.browser.vite };
  } catch (error) {
    await ctx.close();
    throw error;
  }
}

async function response(server, path, signal) {
  signal.throwIfAborted();
  const url = new URL(path, server.resolvedUrls.local[0]);
  console.log('[browser-optimizer-owner] HTTP', url.href);
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  const body = await response.text();
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}: ${body.slice(0, 500)}`);
}

async function committed(server, signal) {
  signal.throwIfAborted();
  const optimizer = server.environments.client.depsOptimizer;
  assert.ok(optimizer, 'actual Vite dependency optimizer');
  await optimizer.scanProcessing;
  await Promise.all(
    Object.values(optimizer.metadata.discovered)
      .map((dep) => dep.processing)
      .filter(Boolean),
  );
  signal.throwIfAborted();
  assert.ok(Object.keys(optimizer.metadata.optimized).length > 0, 'actual optimizer publication');
  console.log(
    '[browser-optimizer-owner] committed',
    JSON.stringify({
      cacheDir: server.config.cacheDir,
      dependencies: Object.keys(optimizer.metadata.optimized),
    }),
  );
  return optimizer;
}

test('Host optimizer commit preserves live Renderer dependency bytes and HTTP imports', {
  timeout: 180_000,
}, async ({ signal }) => {
  const argv = process.argv;
  const workers = process.env.FORGEAX_SHADER_COMPILE_WORKERS;
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '1';
  let native, host;
  try {
    native = await open('config/vitest.browser.config.ts', files, signal);
    await response(
      native.server,
      `/@fs/${root.replaceAll('\\', '/')}/${files[1]}?import&browserv=${Date.now()}`,
      signal,
    );
    const optimizer = await committed(native.server, signal);
    const dependencies = Object.values(optimizer.metadata.optimized).map((dep) => ({
      file: dep.file,
      browserHash: dep.browserHash,
      sha256: hash(readFileSync(dep.file)),
    }));
    assert.ok(
      dependencies.some((dep) => dep.file.includes('pako')),
      'Renderer-owned dependency is present',
    );
    const hostFile = 'packages/net-websocket/__tests__/connector-contract.browser.test.ts';
    host = await open('config/vitest.browser-host.config.ts', [hostFile], signal);
    await response(
      host.server,
      `/@fs/${root.replaceAll('\\', '/')}/${hostFile}?import&browserv=${Date.now()}`,
      signal,
    );
    await committed(host.server, signal);
    for (const dependency of dependencies) {
      await response(
        native.server,
        `/${relative(root, dependency.file).replaceAll('\\', '/')}?v=${dependency.browserHash}`,
        signal,
      );
      assert.equal(hash(readFileSync(dependency.file)), dependency.sha256, dependency.file);
    }
    assert.notEqual(native.server.config.cacheDir, host.server.config.cacheDir);
    for (const file of files)
      await response(
        native.server,
        `/@fs/${root.replaceAll('\\', '/')}/${file}?import&browserv=${Date.now()}`,
        signal,
      );
  } finally {
    if (host) await host.ctx.close();
    if (native) await native.ctx.close();
    rmSync(browserProcessCacheDir(root, process.pid), { recursive: true, force: true });
    process.argv = argv;
    if (workers === undefined) delete process.env.FORGEAX_SHADER_COMPILE_WORKERS;
    else process.env.FORGEAX_SHADER_COMPILE_WORKERS = workers;
  }
});
