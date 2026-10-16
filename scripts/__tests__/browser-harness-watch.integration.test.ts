import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { expect, test } from 'vitest';
import { createBrowserProject } from '../../config/vitest-browser-project';

test('browser watcher excludes floating harness while keeping engine source watched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'g28-browser-watch-'));
  await mkdir(join(root, '.forgeax-harness'), { recursive: true });
  await mkdir(join(root, 'packages/physics'), { recursive: true });
  await writeFile(join(root, '.forgeax-harness/loop.json'), '{}');
  await writeFile(join(root, 'packages/physics/fixture.ts'), 'export const fixture = 1;');
  const project = createBrowserProject();
  const server = await createServer({
    configFile: false,
    root,
    plugins: [],
    logLevel: 'silent',
    server: { middlewareMode: true, watch: project.server.watch },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Vite watcher preparation timed out')), 3000);
      server.watcher.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const watched = server.watcher.getWatched();
    expect(Object.keys(watched).some((path) => path.includes('.forgeax-harness'))).toBe(false);
    expect(watched[join(root, 'packages/physics')]).toContain('fixture.ts');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
