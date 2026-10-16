import { execFile } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { it } from 'vitest';

const selector =
  'packages/devkit/src/__tests__/view-runtime-content-diagnostic.integration.test.ts';
const execute = promisify(execFile);

it.skipIf(process.env.FOCUS_SELECTOR !== selector)(
  'captures the original TypeScript runtime-content preview failure on its own device',
  async () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const evidence = resolve(root, 'artifacts/ci-focus/view-runtime-content');
    await mkdir(evidence, { recursive: true });
    const env = {
      ...process.env,
      FORGEAX_SKIP_HARNESS_SYNC: '1',
      FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1',
      FORGEAX_PREVIEW_RHI_WINDOW: '1',
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
      ['scripts/forgeax/prepare-shader-release-inputs.mjs', '--build', '--profile', 'base-ssao'],
      ['scripts/ci/run-view-integration.mjs', '--candidate', '--group', 'runtime-ts'],
    ];
    try {
      for (const [index, args] of commands.entries()) {
        try {
          const result = await execute(process.execPath, args, {
            cwd: root,
            env,
            timeout: 1_800_000,
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
    } finally {
      for (const owner of ['live', 'cold']) {
        await cp(
          resolve(root, 'artifacts/view-integration/runtime-ts', owner),
          resolve(evidence, owner),
          {
            recursive: true,
          },
        ).catch(async (error: NodeJS.ErrnoException) => {
          await writeFile(
            resolve(evidence, `${owner}-unavailable.json`),
            JSON.stringify({ owner, code: error.code, message: error.message }),
          );
        });
      }
    }
  },
  2_000_000,
);
