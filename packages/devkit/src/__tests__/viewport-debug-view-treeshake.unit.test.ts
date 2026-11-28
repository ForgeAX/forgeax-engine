import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InlineConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

async function closeViteConfig(config: InlineConfig | undefined): Promise<void> {
  if (!config?.plugins) return;
  for (const plugin of config.plugins.flat()) {
    if (
      plugin &&
      typeof plugin === 'object' &&
      'closeBundle' in plugin &&
      typeof plugin.closeBundle === 'function'
    ) {
      await plugin.closeBundle.call({} as never);
    }
  }
}

async function createMinimalProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-vp-debug-treeshake-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'vp-debug-treeshake-fixture',
      private: true,
      type: 'module',
    }),
  );
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({
      id: 'vp-debug-treeshake-fixture',
      name: 'Viewport Debug Fixture',
      schemaVersion: '3.0.0',
      roots: {},
    }),
  );
  return root;
}

describe('viewport debug view 3-tier default switch and tree-shaking contract', () => {
  it('omits all debug-view imports and hooks from default production builds, and includes them only on explicit opt-in or serve mode', async () => {
    const root = await createMinimalProject();
    const configs: InlineConfig[] = [];
    try {
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;

      // 1. Default build: ZERO reference to debug-view (guarantees 0-byte tree-shaking)
      const defaultBuild = await createViteConfig(facts.value, 'build');
      configs.push(defaultBuild);
      expect(defaultBuild.root).toBeDefined();
      const defaultMain = await readFile(join(defaultBuild.root ?? '', 'main.ts'), 'utf8');
      expect(defaultMain).not.toContain('render/debug-view');
      expect(defaultMain).not.toContain('createViewportOutputExtension');
      expect(defaultMain).not.toContain('__forgeaxViewportOutput');

      // 2. Explicit opt-in build (`viewportDebugView: true`): includes debug-view and activates it
      const optInBuild = await createViteConfig(facts.value, 'build', '/', {
        viewportDebugView: true,
      });
      configs.push(optInBuild);
      expect(optInBuild.root).toBeDefined();
      const optInMain = await readFile(join(optInBuild.root ?? '', 'main.ts'), 'utf8');
      expect(optInMain).toContain('@forgeax/engine/render/debug-view');
      expect(optInMain).toContain('createViewportOutputExtension');
      expect(optInMain).toContain('const viewportDebugViewRequested = !workerExecution && (true);');

      // 3. Dev / View serve mode: enabled by default for View (`workspaceTarget`), manual opt-in for standalone dev (`?forgeax-debug-view=1`)
      const devServe = await createViteConfig(facts.value, 'serve');
      configs.push(devServe);
      expect(devServe.root).toBeDefined();
      const devMain = await readFile(join(devServe.root ?? '', 'main.ts'), 'utf8');
      expect(devMain).toContain('@forgeax/engine/render/debug-view');
      expect(devMain).toContain(
        "const viewportDebugViewRequested = !workerExecution && (workspaceTarget || query.get('forgeax-debug-view') === '1');",
      );
    } finally {
      for (const config of configs) await closeViteConfig(config);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
