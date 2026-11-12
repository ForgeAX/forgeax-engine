import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { logLiveInputTiming, traceDevStartup } from '../startup-timing.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('retains detached startup intervals without exposing failure contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-startup-timing-'));
  roots.push(root);
  const log = join(root, 'startup.log');
  vi.stubEnv('FORGEAX_WORKSPACE_TIMING', '1');
  vi.stubEnv('FORGEAX_STARTUP_TIMING_LOG', log);
  await expect(traceDevStartup('fixture-ready', async () => 42)).resolves.toBe(42);
  const cause = new Error('private-runtime-detail');
  await expect(
    traceDevStartup('fixture-failure', async () => {
      throw cause;
    }),
  ).rejects.toBe(cause);
  logLiveInputTiming({ stage: 'compiler-inputs-adopted', pendingReload: 'inputs' });
  const raw = await readFile(log, 'utf8');
  expect(raw).not.toContain(cause.message);
  const records = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
  expect(records).toMatchObject([
    { stage: 'fixture-ready', pid: process.pid, completed: true },
    { stage: 'fixture-failure', pid: process.pid, completed: false },
    { stage: 'compiler-inputs-adopted', pid: process.pid, pendingReload: 'inputs' },
  ]);
  expect(records[0].elapsedMs).toBeGreaterThanOrEqual(0);
  expect(records[0].startedUnixMs).toBeGreaterThan(0);
  expect(records[0].cpuMs).toBeGreaterThanOrEqual(0);
  expect(raw).toContain('[forgeax.live-inputs.timing]');
  expect(records[2].observedUnixMs).toBeGreaterThan(0);
});

it('does not write timing records without the opt-in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-startup-timing-'));
  roots.push(root);
  const log = join(root, 'startup.log');
  vi.stubEnv('FORGEAX_WORKSPACE_TIMING', '0');
  vi.stubEnv('FORGEAX_STARTUP_TIMING_LOG', log);
  await expect(traceDevStartup('fixture-disabled', async () => true)).resolves.toBe(true);
  logLiveInputTiming({ stage: 'input-reload-disabled' });
  await expect(stat(log)).rejects.toMatchObject({ code: 'ENOENT' });
});
