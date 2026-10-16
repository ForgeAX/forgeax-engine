import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { discoverProjectTools } from '../tools/project-tools.js';

it.each([
  false,
  true,
])('CLI discovery leaves the browser cache intact (commands=%s)', async (commands) => {
  const root = await mkdtemp(join(tmpdir(), 'tool-cache-owner-'));
  try {
    await writeFile(join(root, 'package.json'), '{"name":"cache-owner","type":"module"}');
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'cache-owner',
        name: 'Cache owner',
        roots: {},
      }),
    );
    await writeFile(
      join(root, 'commands.ts'),
      `export default { schemaVersion: '1.0.0', commands: [{ id: 'fixture.echo', path: ['fixture', 'echo'], title: 'Echo', summary: 'Echo input', realm: 'build', argsSchema: '{"type":"object"}', executor: './execute.ts' }] };`,
    );
    await mkdir(join(root, 'assets'));
    if (commands)
      await writeFile(
        join(root, 'assets/tools.pack.json'),
        JSON.stringify({
          schemaVersion: '3.0.0',
          packageId: '01900000-0000-7000-8000-000000000140',
          assets: {
            'plugin/tools': {
              kind: 'plugin',
              payload: {
                module: { specifier: '../plugin.ts' },
                toolContract: { specifier: '../commands.ts' },
              },
            },
          },
        }),
      );
    const cache = join(root, 'node_modules', '.vite', 'deps');
    await mkdir(cache, { recursive: true });
    const metadata = JSON.stringify({
      hash: 'browser-owner',
      lockfileHash: 'browser-owner',
      configHash: 'browser-owner',
      browserHash: 'browser-owner',
      optimized: {},
      chunks: {},
    });
    await writeFile(join(cache, '_metadata.json'), metadata);
    await writeFile(join(cache, 'live.js'), 'export const live = true;');
    expect(await discoverProjectTools(root)).toHaveLength(commands ? 1 : 0);
    expect(await readFile(join(cache, '_metadata.json'), 'utf8')).toBe(metadata);
    expect(await readFile(join(cache, 'live.js'), 'utf8')).toBe('export const live = true;');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
