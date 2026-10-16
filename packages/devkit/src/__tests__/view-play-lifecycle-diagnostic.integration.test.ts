import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { it } from 'vitest';

const selector = 'packages/devkit/src/__tests__/view-play-lifecycle-diagnostic.integration.test.ts';
const execute = promisify(execFile);

it.skipIf(process.env.FOCUS_SELECTOR !== selector)(
  'observes two real Play retirements without replacing the ten-cycle delivery gate',
  async () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const env = {
      ...process.env,
      FORGEAX_SKIP_HARNESS_SYNC: '1',
      FORGEAX_VIEW_CLOSE_DIAGNOSTIC: '1',
      FORGEAX_PROBE_PLAY_ONLY: '0',
      FORGEAX_VIEW_ADDITIONAL_PAGES: '["rhi-debug","profiler"]',
    };
    for (const [file, args] of [
      ['pnpm', ['build:tools']],
      [
        'node',
        ['scripts/forgeax/prepare-shader-release-inputs.mjs', '--build', '--profile', 'base-ssao'],
      ],
      ['node', ['scripts/verify-engine-plugin-boundary.mjs']],
    ] as const) {
      try {
        const result = await execute(file, [...args], {
          cwd:
            args[0] === 'scripts/verify-engine-plugin-boundary.mjs'
              ? resolve(root, 'tools/view')
              : root,
          env: { ...env, FORGEAX_PLAY_CYCLES: '2' },
          timeout: 900_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        console.info(result.stdout, result.stderr);
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        console.error(failure.stdout, failure.stderr);
        throw error;
      }
    }
  },
  1_500_000,
);
