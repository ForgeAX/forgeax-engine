import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createPortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it, vi } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it('keeps project file notifications while closing without native FSEvents blocking', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-host-watcher-'));
  let server: ViteDevServer | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"host-watcher"}\n');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'host-watcher',
        name: 'Host watcher',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve');
    if (process.platform === 'darwin')
      expect(config.server?.watch).toMatchObject({ useFsEvents: false });
    const probe = resolve(config.root ?? root, 'watcher-close-probe.txt');
    await writeFile(probe, 'before\n');
    const portServer = createPortServer();
    await new Promise<void>((done) => portServer.listen(0, '127.0.0.1', done));
    const address = portServer.address();
    if (!address || typeof address === 'string') throw new Error('No probe port');
    const port = address.port;
    await new Promise<void>((done, reject) =>
      portServer.close((error) => (error ? reject(error) : done())),
    );
    server = await createServer({
      ...config,
      server: { ...config.server, host: '127.0.0.1', port, strictPort: true },
    });
    await server.listen();
    const watcher = server.watcher;
    const changed = vi.fn();
    watcher.on('change', changed);
    await vi.waitFor(
      () => expect(Object.values(watcher.getWatched()).flat()).toContain('watcher-close-probe.txt'),
      { timeout: 5000 },
    );
    await writeFile(probe, 'after\n');
    await vi.waitFor(() => expect(changed.mock.calls.some(([path]) => path === probe)).toBe(true), {
      timeout: 5000,
    });
    const started = performance.now();
    await server.close();
    server = undefined;
    expect(performance.now() - started).toBeLessThan(5000);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
