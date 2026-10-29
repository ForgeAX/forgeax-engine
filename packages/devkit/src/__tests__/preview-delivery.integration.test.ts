import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { prepareDist } from '../delivery-dist.js';
import { writeDistManifest } from '../dist.js';
import { disposeDevKitHosts, startPreviewProjectWithHost } from '../host.js';

it('previews the selected player bytes and validator instead of the diagnostic dist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-delivery-'));
  let player: string | undefined;
  try {
    await mkdir(join(root, 'dist/shaders'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"delivery-fixture"}');
    await writeFile(join(root, 'dist/index.html'), '<title>Player source</title>');
    await writeFile(join(root, 'dist/pack-index.json'), '[]');
    await writeFile(join(root, 'dist/shaders/manifest.json'), '{}');
    const manifest = await writeDistManifest(
      {
        root,
        id: 'delivery-fixture',
        name: 'Delivery Fixture',
        roots: {},
        assetRoots: [],
        assetLibraries: [],
        packageJson: {},
      },
      './',
    );
    const prepared = await prepareDist(join(root, 'dist'), manifest);
    player = prepared.root;
    const result = await startPreviewProjectWithHost({ root, dist: player, port: 0, json: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const value = result.value as { serves: string; urls: { local: string[] } };
    expect(value.serves).toBe(player);
    const url = value.urls.local[0];
    if (!url) throw new Error('preview URL');
    const response = await fetch(new URL('pack-index.json', url));
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(await readFile(join(player, 'pack-index.json')));
    expect(bytes).not.toEqual(await readFile(join(root, 'dist/pack-index.json')));
    const deliveredManifest = await fetch(new URL('forgeax-dist.json', url));
    expect(
      createHash('sha256')
        .update(await deliveredManifest.text())
        .digest('hex'),
    ).toBe(
      createHash('sha256')
        .update(await readFile(join(player, 'forgeax-dist.json')))
        .digest('hex'),
    );
    const revalidated = await fetch(new URL('pack-index.json', url), {
      headers: { 'If-None-Match': response.headers.get('etag') ?? '' },
    });
    expect(revalidated.status).toBe(304);
    const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
    const child = spawn(
      process.execPath,
      [cli, 'project', 'preview', '--root', root, '--dist', player, '--port', '0', '--json'],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    const output = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      const [line] = await once(output, 'line', { signal: AbortSignal.timeout(10_000) });
      const envelope = JSON.parse(String(line)) as {
        ok: boolean;
        value: { urls: { local: string[] } };
      };
      expect(envelope.ok, stderr).toBe(true);
      const address = envelope.value.urls.local[0];
      if (!address) throw new Error('CLI preview URL');
      // The startup JSON is not a terminal result: subsequent HTTP reads still
      // belong to this foreground process until its caller stops it.
      for (let request = 0; request < 3; request++) {
        const served = await fetch(new URL('pack-index.json', address));
        expect(Buffer.from(await served.arrayBuffer())).toEqual(bytes);
        expect(child.exitCode).toBeNull();
      }
    } finally {
      output.close();
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    }
  } finally {
    await disposeDevKitHosts();
    await rm(root, { recursive: true, force: true });
    if (player !== undefined) await rm(player, { recursive: true, force: true });
  }
}, 90_000);
