import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Host preparation preserves an already published native dependency URL', async () => {
  // Resolve the maintained configurations without starting any native fixture.
  const program = `import { createVitest } from 'vitest/node';
    process.argv.push('list', '--filesOnly');
    for (const config of ['config/vitest.browser.config.ts', 'config/vitest.browser-host.config.ts']) {
      let ctx;
      try {
        ctx = await createVitest('test', { root: process.cwd(), config, watch: false });
        const project = ctx.projects.find(project => project.name.startsWith('browser'));
        console.log('CACHE=' + JSON.stringify(project.vite.config.cacheDir));
      } finally { await ctx?.close(); }
    }`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const caches = output
    .split('\n')
    .filter((line) => line.startsWith('CACHE='))
    .map((line) => JSON.parse(line.slice('CACHE='.length)));
  assert.equal(caches.length, 2);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-browser-cache-')));
  const servers = [];
  try {
    await mkdir(join(root, 'node_modules'));
    await symlink(
      await realpath('packages/rhi-debug/node_modules/pako'),
      join(root, 'node_modules/pako'),
      'junction',
    );
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    async function start(index, dependency) {
      const suffix = relative(process.cwd(), caches[index]);
      assert.ok(!suffix.startsWith('..'), 'browser cache must belong to this checkout');
      const entry = `entry-${index}.js`;
      await writeFile(
        join(root, entry),
        `import value from '${dependency}'; export default value;`,
      );
      const server = await createServer({
        configFile: false,
        root,
        cacheDir: join(root, suffix),
        plugins: [{ name: index === 0 ? 'native-fixtures' : 'host-fixtures' }],
        optimizeDeps: { noDiscovery: true, include: [dependency] },
        server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [root, process.cwd()] } },
      });
      servers.push(server);
      await server.listen();
      const base = `http://127.0.0.1:${server.httpServer.address().port}`;
      const transformed = (await server.transformRequest(`/${entry}`)).code;
      const url = /from\s+["']([^"']*pako[^"']*)["']/.exec(transformed)?.[1];
      assert.ok(url?.startsWith('/'), transformed);
      if (index === 0) {
        // Prepare the dependency without populating this server's module cache:
        // the first browser import happens after its neighboring Host starts.
        const optimizer = server.environments.client.depsOptimizer;
        await optimizer.metadata.discovered[dependency]?.processing;
        const bytes = await readFile(join(root, suffix, 'deps', 'pako.js'));
        assert.ok(bytes.length > 0);
      } else {
        const first = await fetch(base + url);
        await first.arrayBuffer();
        assert.equal(first.status, 200);
      }
      return { url: base + url, file: join(root, suffix, 'deps', 'pako.js') };
    }
    const published = await start(0, 'pako');
    await start(1, 'pako/lib/zlib/inflate.js');
    // Vite can repair a later source request; that does not preserve the
    // publication held by an already transformed native test module.
    assert.ok((await readFile(published.file)).length > 0);
    const response = await fetch(published.url);
    await response.arrayBuffer();
    assert.equal(
      response.status,
      200,
      'Host startup invalidated the native dependency publication',
    );
  } finally {
    for (const server of servers.reverse()) await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
