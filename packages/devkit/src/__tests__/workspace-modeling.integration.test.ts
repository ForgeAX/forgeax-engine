import { fileURLToPath } from 'node:url';
import type { EngineWorkspaceProvider } from '@forgeax/engine-app';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_MODELING_OPERATIONS } from '../workspace-modeling-tools.js';
import { devKitWorkspacePlugin } from '../workspace-plugin.js';

// The View modeling window's route: a frontend caller runs model.* through
// engine.workspace.call against its own admitted project (the forgeax-modeling cases).
const modelingRoot = fileURLToPath(new URL('../../../modeling/', import.meta.url));

describe('workspace modeling operations', () => {
  it('run against the caller project and require an open project', {
    timeout: 120000,
  }, async () => {
    const backend = await createBackendHost({});
    const provider: EngineWorkspaceProvider = {
      openProject: ({ root }) => ({ project: { id: root, root } }),
      closeProject() {},
      listAssets: () => [],
      openPreview() {
        throw new Error('unused');
      },
    };
    const client = backend.transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    try {
      const fiber = await backend.context.plugin(devKitWorkspacePlugin, {
        provider,
        hostBinding: { backend },
      });
      await fiber.await();
      const call = (operation: string, args: Record<string, unknown>) =>
        client.request('engine.workspace.call', { operation, args }) as Promise<
          Record<string, unknown>
        >;
      const source = 'examples/bracket/bracket.pack.ts';
      const closed = await call('model.inspect', { source }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(JSON.stringify(closed)).toContain('engine-workspace-project-required');
      await call('engine.project.open', { root: modelingRoot });
      const inspected = await call('model.inspect', { source });
      expect(inspected).toMatchObject({ build: { ok: true, outputs: ['mesh/bracket'] } });
      const selected = (await call('model.select', {
        source,
        selector: "sel.createdBy('boss', 'top')",
      })) as { selected: { ids: number[] } };
      const report = await call('model.synthesize', {
        source,
        pick: { faces: selected.selected.ids },
        stability: false,
      });
      expect(report).toMatchObject({
        schema: 'forgeax.model.synthesize/1',
        expression: "sel.createdBy('boss', 'top')",
        jaccard: 1,
        stability: 'unchecked',
      });
      // The window sends a larger per-call capture budget; model.render declares it too, so
      // a missing source fails in the capture rather than in argument validation.
      await expect(call('model.inspect', { source, timeoutMs: 300000 })).resolves.toMatchObject({
        build: { ok: true },
      });
      const missing = await call('model.render', {
        source: 'examples/missing.pack.ts',
        timeoutMs: 300000,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(JSON.stringify(missing)).toContain('"phase":"module-load"');
      for (const output of ['../k6-escape.png', '/tmp/k6-escape.png']) {
        const escaped = await call('model.render', { source, output }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(JSON.stringify(escaped)).toContain('output stays inside the project root');
      }
      expect(WORKSPACE_MODELING_OPERATIONS).toContain('model.render');
    } finally {
      client.close();
      await backend.dispose();
    }
  });
});
