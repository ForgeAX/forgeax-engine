import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { createServer } from 'vite';
import { expect, it, vi } from 'vitest';
import { forgeaxShader } from '../index.js';
import { publishShaderManifest } from '../manifest-publication.js';

it.each([
  'shared',
  '../external/profile',
  'external-project',
])('serves admitted blocks from %s through nested-project Vite HTTP without splitting them again', async (outputDirectory) => {
  const fixture = await mkdtemp(join(tmpdir(), 'prepared-manifest-http-'));
  const root = join(fixture, 'checkout');
  const project = join(root, 'apps/hello/fixture');
  const consumer = outputDirectory === 'external-project' ? join(fixture, 'consumer') : project;
  const output = join(root, outputDirectory);
  await mkdir(project, { recursive: true });
  await mkdir(consumer, { recursive: true });
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  const source = 'fn shared() {}\n\nfn retained() {}\n';
  const sourceDigest = 'f2be32b04b5d7b8209224020f19bce8d359dd1ceaad83bbe38c07cb039462f2e';
  const publication = publishShaderManifest(
    [
      { hash: 'retained', wgsl: source, bindings: '[]', uvSetCount: 8 },
      { hash: 'unspecified', wgsl: source, bindings: '[]' },
    ],
    [],
  );
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'shaders.json'), JSON.stringify(publication));
  const payload = relative(root, join(output, 'shaders.json')).replaceAll('\\', '/');
  await writeFile(
    join(output, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      producer: 'repo-build-inputs',
      inputFingerprint: 'http-fixture',
      inventory: [payload],
      payload: { engineShaderManifest: payload },
    }),
  );
  vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', join(output, 'manifest.json'));
  vi.stubEnv('FORGEAX_ENGINE_SHADER_SOURCE_BUILD', '0');
  const plugin = forgeaxShader(
    outputDirectory === 'external-project' ? { workspaceRoot: root } : {},
  );
  const server = await createServer({
    configFile: false,
    root: consumer,
    plugins: [plugin],
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: { usePolling: true, interval: 1_000 } },
    optimizeDeps: { noDiscovery: true },
  });
  const nativeSplit = String.prototype.split;
  let repeatedSplits = 0;
  const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (
    this: string,
    separator: unknown,
    limit?: number,
  ) {
    if (separator === '\n\n' && String(this) === source) repeatedSplits++;
    return Reflect.apply(nativeSplit, this, [separator, limit]) as string[];
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (address === null || address === undefined || typeof address === 'string')
      throw new Error('HTTP fixture has no port');
    const url = `http://127.0.0.1:${address.port}/shaders/manifest.json`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    const body = await first.text();
    const expanded = await readShaderManifestPublication(JSON.parse(body));
    expect(expanded).toEqual({
      entries: [
        { hash: 'retained', wgsl: source, sourceDigest, bindings: '[]', uvSetCount: 8, glsl: '' },
        {
          hash: 'unspecified',
          wgsl: source,
          sourceDigest,
          bindings: '[]',
          uvSetCount: 0,
          glsl: '',
        },
      ],
      materialShaders: [],
    });
    expect(await (await fetch(url)).text()).toBe(body);
    expect(repeatedSplits).toBe(0);
  } finally {
    spy.mockRestore();
    await server.close();
    vi.unstubAllEnvs();
    await rm(fixture, { recursive: true, force: true });
  }
}, 20_000);
