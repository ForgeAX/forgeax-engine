import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const discovery = vi.hoisted(() => vi.fn());
const start = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: { phase: 'ready' } })));
const status = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: { phase: 'stopped' } })));
const control = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: { phase: 'stopped' } })));

vi.mock('../build/plugin-assets.js', async (original) => ({
  ...(await original<typeof import('../build/plugin-assets.js')>()),
  discoverPluginAssets: discovery,
}));
vi.mock('../live-dev.js', () => ({
  startLiveDev: start,
  liveDevStatus: status,
  liveDevControl: control,
}));

import { runUnifiedCli } from '../unified-cli.js';

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-live-command-loading-')));
  roots.push(root);
  await writeFile(join(root, 'package.json'), '{"name":"live-command-loading","type":"module"}');
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      id: 'live-command-loading',
      name: 'Live command loading',
      roots: {},
    }),
  );
  discovery.mockRejectedValue(new Error('asset discovery belongs to the serving owner'));
  return root;
}

it.each([
  'start',
  'status',
  'stop',
  'reload',
])('dispatches built-in dev %s to its owner without a preliminary project inventory', async (operation) => {
  const root = await fixture();
  const result = await runUnifiedCli(['dev', operation, '--root', root, '--json']);
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
  });
  expect(discovery).not.toHaveBeenCalled();
  if (operation === 'start') expect(start).toHaveBeenCalledWith(root, {});
  else if (operation === 'status') expect(status).toHaveBeenCalledWith(root);
  else expect(control).toHaveBeenCalledWith(root, operation, expect.any(Object));
});

it.each([
  { args: ['help', 'dev', 'start'] },
  { args: ['dev', 'start', '--help'] },
  { args: ['dev', 'custom'] },
  { args: ['dev', 'custom', 'start'] },
])('retains extension discovery for $args', async ({ args }) => {
  const root = await fixture();
  await runUnifiedCli([...args, '--root', root, '--json']);
  expect(discovery).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  expect(control).not.toHaveBeenCalled();
});
