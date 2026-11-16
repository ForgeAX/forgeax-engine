import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { expect, it, vi } from 'vitest';
import {
  createLiveSyncProjectDirectory,
  prepareLiveSyncSharedInputs,
} from '../../scripts/live-sync-inputs.mjs';
import { verifyDist, writeDistManifest } from '../dist.js';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it('includes platform HTML before sealing and still detects later output mutation', async () => {
  const sourceRoot = resolve(import.meta.dirname, '../../../..');
  const manifest =
    process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST ??
    resolve(sourceRoot, 'shared-build-inputs/manifest.json');
  const { root, temporaryRoot } = await createLiveSyncProjectDirectory(
    'forgeax-build-head-',
    sourceRoot,
    manifest,
  );
  try {
    await prepareLiveSyncSharedInputs({
      sourceRoot,
      projectRoot: root,
      temporaryRoot,
      manifestPath: manifest,
    });
    vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', manifest);
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"build-head","type":"module"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({ schemaVersion: '3.0.0', id: 'build-head', name: 'Build head', roots: {} }),
    );
    await writeFile(
      resolve(root, 'platform-head.html'),
      '<meta name="platform-test" content="included"><script>globalThis.platformBeforeBootstrap = true;</script>',
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'build', '/', {
      htmlHead: 'platform-head.html',
    });
    await build({ ...config, logLevel: 'silent' });
    const html = await readFile(resolve(root, 'dist/index.html'), 'utf8');
    expect(html).toContain('platform-test');
    expect(html).toContain('platformBeforeBootstrap');
    expect([...html.matchAll(/src="[^"]*\/assets\/index-[^/"]+\.js"/g)]).toHaveLength(1);
    await writeDistManifest(facts.value, '/');
    expect(await verifyDist(resolve(root, 'dist'))).toMatchObject({ ok: true });
    await writeFile(resolve(root, 'dist/index.html'), `${html}\n<!-- modified after build -->`);
    expect(await verifyDist(resolve(root, 'dist'))).toMatchObject({
      ok: false,
      error: { code: 'dist-artifact-mismatch' },
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}, 120_000);
