// @perf-budget-skip: real live daemon, control endpoint and project child lifecycle.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('status cannot create a replacement before the initial owner publishes its session', async () => {
  // The fixture holds only the first filesystem publication. It consumes actual
  // public JS and the sibling CLI with real HTTP, input scans and child cleanup.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/live-dev-startup-status.mjs', import.meta.url))],
    {
      timeout: 12_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout.trim());
  expect(result.status).toBe('PASS');
  expect(result.observations[0].phase).toBe('starting');
  expect(result.observations.at(-1).phase).toBe('failed');
  expect(result.projectLog.match(/live project: loading DevKit host/g)?.length).toBe(1);
}, 15_000);
