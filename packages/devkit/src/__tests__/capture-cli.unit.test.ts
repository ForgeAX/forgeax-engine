import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() =>
  vi.fn(async (options: Record<string, unknown>) => ({ ok: true, value: options })),
);
vi.mock('../commands.js', () => ({ browserCaptureCommand: capture }));

import { runUnifiedCli } from '../unified-cli';

const roots: string[] = [];
afterEach(async () => {
  capture.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-capture-cli-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), '{"name":"capture-cli-fixture","type":"module"}');
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({ schemaVersion: '3.0.0', id: 'capture-cli', name: 'Capture', roots: {} }),
  );
  return root;
}

it.each([
  'auto',
  'hardware',
  'software',
])('passes the selected %s backend through the real CLI to capture', async (backend) => {
  const root = await fixture();
  expect(
    await runUnifiedCli(['project', 'capture', '--backend', backend, '--root', root]),
  ).toMatchObject({ ok: true });
  expect(capture).toHaveBeenCalledExactlyOnceWith({ backend, root });
});

it.each([
  ['--software', 'true'],
  ['--backend', 'other'],
])('rejects invalid capture selection %s %s before invoking the owner', async (flag, value) => {
  const root = await fixture();
  expect(await runUnifiedCli(['project', 'capture', flag, value, '--root', root])).toMatchObject({
    ok: false,
    error: { code: 'cli-parse-error' },
  });
  expect(capture).not.toHaveBeenCalled();
});

it('advertises the supported capture backend choices in CLI help', async () => {
  const root = await fixture();
  const result = await runUnifiedCli(['help', 'project', 'capture', '--root', root, '--json']);
  expect(result).toMatchObject({
    ok: true,
    value: {
      leaf: {
        inputSchema: { properties: { backend: { enum: ['auto', 'hardware', 'software'] } } },
      },
    },
  });
});
