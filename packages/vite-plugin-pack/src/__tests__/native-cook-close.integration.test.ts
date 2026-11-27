import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { testGate } from '../../../../scripts/test/test-gate.mjs';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';
import { createPackTestServer } from './vite-fixtures.js';

it.each([
  'complete',
  'close',
] as const)('retains complete production and drains cancelled production: %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-native-cook-close-'));
  let server: Awaited<ReturnType<typeof createPackTestServer>> | undefined;
  const { promise: blocked, resolve: release } = testGate();
  const { promise: started, resolve: observeStarted } = testGate();
  const calls: string[] = [];
  class Cooker implements NativeCooker {
    readonly key = 'close-effect';
    private readonly accepted: string[] = calls;
    discover(input: unknown) {
      expect(this.accepted).toBe(calls);
      return input;
    }
    async cook(input: unknown) {
      const draft = input as { readonly guid: string; readonly sourceKey: string };
      this.accepted.push(draft.sourceKey);
      if (this.accepted.length === 1) {
        observeStarted();
        await blocked;
      }
      return {
        guid: draft.guid,
        payload: { kind: this.key, cooked: true },
        refs: [],
        artifacts: {},
        inputFingerprint: `sha256:${'1'.repeat(64)}`,
      };
    }
  }
  try {
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(
      join(assets, 'outputs.pack.ts'),
      `export default {
      schemaVersion: '2.0.0',
      packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,82]),
      build: () => ({ ok: true, value: {
        a: { kind: 'close-effect', execution: 'cooked', source: {} },
        b: { kind: 'close-effect', execution: 'cooked', source: {} },
      } }),
    };`,
    );
    const binding = createStandaloneRuntimeAssetBinding('native-cook-close');
    const plugin = pluginPack({
      roots: [assets],
      cookers: [new Cooker()],
      runtimeBinding: binding,
      producerReadiness: 'before-consume',
      ddc: { projectDdcRoot: join(root, 'ddc') },
    });
    server = await createPackTestServer(root, plugin);
    await server.listen();
    await started;
    if (mode === 'complete') {
      release();
      await plugin.ready();
      const baseUrl = server.resolvedUrls?.local[0];
      if (baseUrl === undefined) throw new Error('Vite did not expose the owned server URL');
      const response = await fetch(new URL(binding.catalogUrl, baseUrl));
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(calls).toEqual(['a', 'b']);
      expect(plugin.catalogSnapshot()).toHaveLength(2);
      return;
    }
    let closed = false;
    const closing = plugin.closeBundle().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    expect(calls).toEqual(['a']);
    release();
    await closing;
    expect(calls).toEqual(['a']);
    expect(plugin.catalogSnapshot()).toEqual([]);
  } finally {
    release();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
