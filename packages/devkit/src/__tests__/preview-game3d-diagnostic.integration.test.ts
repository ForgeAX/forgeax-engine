import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { it } from 'vitest';

const selector = 'packages/devkit/src/__tests__/preview-game3d-diagnostic.integration.test.ts';
const execute = promisify(execFile);

it.skipIf(process.env.FOCUS_SELECTOR !== selector)(
  'runs the original Game3D Preview and live disk reconciliation assertions',
  async () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const evidence = resolve(root, 'artifacts/ci-focus/preview-game3d');
    await mkdir(evidence, { recursive: true });
    const env = {
      ...process.env,
      FORGEAX_SKIP_HARNESS_SYNC: '1',
      FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1',
      FORGEAX_DEV_PACK_READINESS: 'on-demand',
      FORGEAX_TEMPLATE_SMOKE_SLUGS: 'game-3d',
      FORGEAX_TEMPLATE_SMOKE_DIR: evidence,
      FORGEAX_LIVE_SYNC_EVIDENCE: resolve(evidence, 'live-sync'),
    };
    const commands = [
      [
        'scripts/ci/build-shared-app-inputs.mjs',
        '--root',
        root,
        '--out',
        'shared-app-inputs',
        '--projection-out',
        'shared-build-inputs',
      ],
      ['apps/preview/scripts/smoke-templates.mjs'],
      ['packages/devkit/scripts/check-live-sync.mjs'],
    ];
    for (const [index, args] of commands.entries()) {
      try {
        const result = await execute(process.execPath, args, {
          cwd: root,
          env,
          timeout: 900_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        await writeFile(resolve(evidence, `command-${index}.log`), result.stdout + result.stderr);
        // biome-ignore lint/suspicious/noConsole: retain the original native browser probe output.
        console.info(result.stdout, result.stderr);
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        await writeFile(
          resolve(evidence, `command-${index}-failed.log`),
          (failure.stdout ?? '') + (failure.stderr ?? ''),
        );
        console.error(failure.stdout, failure.stderr);
        throw error;
      }
    }
  },
  2_000_000,
);
