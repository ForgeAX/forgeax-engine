import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import MagicString from 'magic-string';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { startupCacheHttp } from '../host/startup-cache-http.js';

it.each([
  '/',
  '/games/preview/',
])('serves large Vite transform maps separately under %s', async (base) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-dev-source-map-'));
  const source = `/* ${'a'.repeat(1024 * 1024)} */\nexport const game = 1;\n`;
  await writeFile(resolve(root, 'large.mjs'), source);
  await writeFile(resolve(root, 'small.mjs'), 'export const game = 2;\n');
  const server = await createServer({
    base,
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      startupCacheHttp(),
      {
        name: 'fixture-transform',
        transform(code, id) {
          if (!id.endsWith('/large.mjs') && !id.endsWith('/small.mjs')) return null;
          const input = new MagicString(code).append('\n/* transformed */');
          return {
            code: input.toString(),
            map: input.generateMap({ source: id, includeContent: true }),
          };
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  try {
    await server.listen();
    const origin = server.resolvedUrls?.local[0];
    if (origin === undefined) throw new Error('missing Vite server URL');
    const module = await fetch(new URL('large.mjs', origin));
    expect(module.ok).toBe(true);
    expect(module.headers.get('content-type')).toContain('javascript');
    const code = await module.text();
    expect(code).toContain('/* transformed */');
    expect(code).toContain(`//# sourceMappingURL=${base}large.mjs.map`);
    expect(code).not.toContain('sourceMappingURL=data:');
    const map = await fetch(new URL('large.mjs.map', origin));
    expect(map.ok).toBe(true);
    expect(await map.json()).toMatchObject({
      version: 3,
      sourcesContent: [source],
      mappings: expect.any(String),
    });
    const timestamp = '?t=1970000000000';
    const updated = await (await fetch(new URL(`large.mjs${timestamp}`, origin))).text();
    expect(updated).toContain(`//# sourceMappingURL=${base}large.mjs.map${timestamp}`);
    const updatedMap = await fetch(new URL(`large.mjs.map${timestamp}`, origin));
    expect(updatedMap.ok).toBe(true);
    expect(await updatedMap.json()).toMatchObject({ sourcesContent: [source] });
    const small = await (await fetch(new URL('small.mjs', origin))).text();
    expect(small).toContain('sourceMappingURL=data:');
    const eTag = module.headers.get('etag');
    if (eTag === null) throw new Error('module response is missing its ETag');
    const unchanged = await fetch(new URL('large.mjs', origin), {
      headers: { 'If-None-Match': eTag },
    });
    expect(unchanged.status).toBe(304);
  } finally {
    await server.close();
    await rm(root, { force: true, recursive: true });
  }
});
