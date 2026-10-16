import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { observeViteHttpReadiness } from '../../../../scripts/lib/vite-http-readiness.mjs';
import { pnpmCommand } from '../../../../scripts/lib/pnpm-command.mjs';
import { createOwnedProcessGroupStopper } from '../../../shared/scripts/rhi-debug-process.mjs';
import { smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';

export const waitGizmoFrames = (page) =>
  page.waitForFunction((minimum) => globalThis.__gizmo?.frames() > minimum, smokeFrameBudget(), { timeout: 180000 });

export async function startGizmoHost({ capture = false } = {}) {
  if (process.env.GIZMO_URL) return { url: process.env.GIZMO_URL, stop: async () => {} };
  const root = resolve(import.meta.dirname, '../../../..'),
    manifest = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST ?? resolve(root, 'shared-build-inputs/manifest.json');
  const [manager, ...managerArgs] = pnpmCommand();
  const child = spawn(
    manager,
    [...managerArgs, '--filter', '@forgeax/hello-transform-gizmo', 'dev', '--host', '127.0.0.1', '--port', '0'],
    {
      cwd: root,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORGEAX_ENGINE_RHI_DEBUG: capture ? '1' : '0',
        ...(existsSync(manifest) ? { FORGEAX_SHARED_APP_INPUTS_MANIFEST: manifest } : {}),
      },
    },
  );
  const stop = createOwnedProcessGroupStopper(child);
  const readiness = observeViteHttpReadiness(child, {
    timeoutEnvName: 'FORGEAX_GIZMO_STARTUP_TIMEOUT_MS',
    outputLimit: 12000,
  });
  try {
    const { origin } = await readiness.wait();
    return { url: origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
