import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  pack: undefined as string | undefined,
  start: vi.fn(async (root: string) => ({ root, phase: 'ready' })),
  status: vi.fn(async (root: string) => ({ root, phase: 'stopped' })),
  stop: vi.fn(async (root: string) => ({ root, phase: 'stopped' })),
}));

vi.mock('../backend-process.js', () => ({
  devKitBackendHostPack: () => backend.pack,
  discoverDevKitBackendTools: async () => [],
  startDevKitBackend: backend.start,
  devKitBackendStatus: backend.status,
  stopDevKitBackend: backend.stop,
}));

import { runUnifiedCli } from '../unified-cli.js';

const roots: string[] = [];
afterEach(async () => {
  backend.pack = undefined;
  backend.start.mockClear();
  backend.status.mockClear();
  backend.stop.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function hostPackFixture(failing = true) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-backend-control-discovery-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), '{"name":"backend-control","type":"module"}');
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      id: 'backend-control',
      name: 'Backend control',
      roots: {},
    }),
  );
  const host = join(root, 'host');
  await mkdir(host);
  const marker = join(root, 'host-contract-imported');
  const pack = join(host, 'host.pack.json');
  await writeFile(
    pack,
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000008302',
      assets: {
        'plugin/main': {
          kind: 'plugin',
          payload: {
            module: { specifier: './host.mjs' },
            toolContract: { specifier: './commands.mjs' },
          },
        },
      },
    }),
  );
  await writeFile(join(host, 'host.mjs'), 'export default { apply() {} };');
  const contract = {
    schemaVersion: '1.0.0',
    commands: [
      {
        id: 'backend.inspect',
        path: ['backend', 'inspect'],
        title: 'Inspect backend extension',
        summary: 'An external Host Pack command.',
        realm: 'build',
        argsSchema: '{"type":"object","properties":{},"additionalProperties":false}',
      },
    ],
  };
  await writeFile(
    join(host, 'commands.mjs'),
    `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'imported');
    ${failing ? "throw new Error('resident Host Pack discovery must not precede backend controls');" : `export default ${JSON.stringify(contract)};`}
  `,
  );
  backend.pack = pack;
  return { root, marker };
}

it.each([
  'start',
  'status',
  'stop',
] as const)('dispatches backend %s without importing the resident Host Pack command module', async (operation) => {
  const { root, marker } = await hostPackFixture();
  expect(await runUnifiedCli(['backend', operation, '--root', root, '--json'])).toMatchObject({
    ok: true,
    value: { root, phase: operation === 'start' ? 'ready' : 'stopped' },
  });
  if (operation === 'start') expect(backend.start).toHaveBeenCalledWith(root, {});
  else expect(backend[operation]).toHaveBeenCalledWith(root);
  await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  'stop',
  'inspect',
])('preserves Host Pack discovery for help backend %s', async (operation) => {
  const { root, marker } = await hostPackFixture(false);
  expect(
    await runUnifiedCli(['help', 'backend', operation, '--root', root, '--json']),
  ).toMatchObject({ ok: true, value: { leaf: { realm: 'build' } } });
  expect(await readFile(marker, 'utf8')).toBe('imported');
  expect(backend.stop).not.toHaveBeenCalled();
});

it('preserves discovery when a command only shares the backend prefix', async () => {
  const { root, marker } = await hostPackFixture(false);
  await runUnifiedCli(['backend', 'inspect', '--root', root, '--json']);
  expect(await readFile(marker, 'utf8')).toBe('imported');
  expect(backend.stop).not.toHaveBeenCalled();
});

it.each([
  '--help',
  '--help=true',
])('preserves Host Pack discovery for backend stop %s', async (flag) => {
  const { root, marker } = await hostPackFixture(false);
  expect(await runUnifiedCli(['backend', 'stop', flag, '--root', root, '--json'])).toMatchObject({
    ok: true,
    value: { leaf: { realm: 'build' } },
  });
  expect(await readFile(marker, 'utf8')).toBe('imported');
  expect(backend.stop).not.toHaveBeenCalled();
});

it('does not discover the Host Pack when the backend help flag is false', async () => {
  const { root, marker } = await hostPackFixture();
  const result = await runUnifiedCli(['backend', 'stop', '--help=false', '--root', root, '--json']);
  // Preserve the existing strict-schema rejection; false does not select help.
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: false,
    command: 'backend stop',
    error: { code: 'cli-parse-error' },
  });
  expect(backend.stop).not.toHaveBeenCalled();
  await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
